import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  applyBudgetUsage,
  assertProviderCallAllowed,
  type BudgetState,
} from "../../packages/shared/budget-gate";
import { parseEvalSpec, validateEvalSpec, type EvalSpec } from "../../packages/shared/eval-spec";
import {
  runMaintenanceCheck,
  type SimulatedCaseObservation,
  type RoutedProviderCallAttempt,
} from "../../packages/shared/maintenance-check";
import {
  appendProviderCallLedgerEntry,
  writeProviderCallLedger,
  type ProviderCallLedgerEntry,
} from "../../packages/shared/provider-call-ledger";

const DELIVERABLES_DIR = path.join("deliverables", "maintenance");
const RESULT_PATH = path.join(DELIVERABLES_DIR, "maintenance-result.json");
const BUDGET_STATE_PATH = path.join(DELIVERABLES_DIR, "budget-state.json");
const LEDGER_PATH = path.join(DELIVERABLES_DIR, "provider-call-ledger.jsonl");

type Scenario =
  | "healthy"
  | "at_risk"
  | "failed"
  | "budget_blocked"
  | "misconfigured";

function getScenario(): Scenario {
  const fromEnv = process.env.MAINTENANCE_SCENARIO as Scenario | undefined;
  const fromArg = process.argv[2] as Scenario | undefined;
  const s = fromArg || fromEnv || "healthy";
  if (
    s === "healthy" ||
    s === "at_risk" ||
    s === "failed" ||
    s === "budget_blocked" ||
    s === "misconfigured"
  ) {
    return s;
  }
  return "healthy";
}

async function loadSpec(relPath: string): Promise<EvalSpec> {
  const raw = await readFile(relPath, "utf-8");
  return parseEvalSpec(JSON.parse(raw) as unknown);
}

function pricingHealthyObs(): Record<string, SimulatedCaseObservation> {
  return {
    "tc-quote-starter": {
      output:
        "State the Starter price as $199/mo per this spec (from your defined catalog).",
      toolCalls: ["fetch_plan_catalog"],
      actions: [],
    },
    "tc-quote-agency": {
      output:
        "State the Agency plan as $1799/mo per this spec (from your defined catalog).",
      toolCalls: ["fetch_plan_catalog"],
      actions: [],
    },
  };
}

function pricingFailedObs(): Record<string, SimulatedCaseObservation> {
  return {
    "tc-quote-starter": {
      output: "Starter is $99 per month.",
      toolCalls: [],
      actions: ["invent_plan_price"],
    },
    "tc-quote-agency": {
      output: "Agency is $1799 per month per your catalog.",
      toolCalls: ["fetch_plan_catalog"],
      actions: [],
    },
  };
}

function pricingAtRiskObs(): Record<string, SimulatedCaseObservation> {
  return {
    "tc-quote-starter": {
      output:
        "State the Starter price as $199/mo per this spec (from your defined catalog).",
      toolCalls: ["fetch_plan_catalog"],
      actions: [],
    },
    "tc-quote-agency": {
      output: "Agency pricing is competitive.",
      toolCalls: ["fetch_plan_catalog"],
      actions: [],
    },
  };
}

async function main(): Promise<void> {
  const scenario = getScenario();
  console.log(
    "AI Reliability — maintenance gate demo (scheduled/triggered checks vs customer eval specs)\n",
  );
  console.log(`Scenario: ${scenario}\n`);

  await mkdir(DELIVERABLES_DIR, { recursive: true });
  await writeProviderCallLedger(LEDGER_PATH, []);

  const specPath =
    process.env.MAINTENANCE_SPEC_PATH ||
    path.join("examples", "eval-specs", "pricing-and-plan-accuracy.spec.json");

  let spec: EvalSpec;
  const rawParsed = JSON.parse(await readFile(specPath, "utf-8")) as unknown;

  if (scenario === "misconfigured") {
    const corrupt = { ...(rawParsed as Record<string, unknown>), environment: "invalid_env" };
    spec = corrupt as EvalSpec;
  } else {
    spec = parseEvalSpec(rawParsed);
  }

  if (scenario === "at_risk") {
    spec = {
      ...spec,
      testCases: spec.testCases.map((tc) =>
        tc.id === "tc-quote-agency" ? { ...tc, severity: "warning" as const } : tc,
      ),
    };
  }

  let observations: Record<string, SimulatedCaseObservation>;
  let routedCall: RoutedProviderCallAttempt | undefined;
  const budget: BudgetState = {
    planId: "starter",
    creditsRemaining: 500,
    budgetRemainingUsd: 400,
    creditsUsed: 0,
    budgetUsedUsd: 0,
  };

  const runId = `maint-${randomUUID()}`;
  const now = new Date().toISOString();

  const monthlyCap = spec.budgetGate?.monthlyBudgetLimitUsd ?? budget.budgetRemainingUsd;

  if (scenario === "healthy") {
    observations = pricingHealthyObs();
    routedCall = {
      callId: `call-${runId}`,
      planId: "starter",
      subscriptionActive: true,
      creditsRemaining: budget.creditsRemaining,
      monthlyBudgetRemainingUsd: Math.min(budget.budgetRemainingUsd, monthlyCap),
      currentRunSpendUsd: 0,
      estimatedCreditsRequired: 1,
      estimatedCostUsd: 0.2,
      provider: "openai",
      model: "gpt-4.1-mini",
      pricingKnown: true,
      estimatedInputTokens: 400,
      estimatedOutputTokens: 120,
    };
  } else if (scenario === "at_risk") {
    observations = pricingAtRiskObs();
    routedCall = {
      callId: `call-${runId}`,
      planId: "starter",
      subscriptionActive: true,
      creditsRemaining: budget.creditsRemaining,
      monthlyBudgetRemainingUsd: Math.min(budget.budgetRemainingUsd, monthlyCap),
      currentRunSpendUsd: 0,
      estimatedCreditsRequired: 1,
      estimatedCostUsd: 0.15,
      provider: "openai",
      model: "gpt-4.1-mini",
      pricingKnown: true,
      estimatedInputTokens: 300,
      estimatedOutputTokens: 100,
    };
  } else if (scenario === "failed") {
    observations = pricingFailedObs();
    routedCall = {
      callId: `call-${runId}`,
      planId: "starter",
      subscriptionActive: true,
      creditsRemaining: budget.creditsRemaining,
      monthlyBudgetRemainingUsd: Math.min(budget.budgetRemainingUsd, monthlyCap),
      currentRunSpendUsd: 0,
      estimatedCreditsRequired: 1,
      estimatedCostUsd: 0.1,
      provider: "openai",
      model: "gpt-4.1-mini",
      pricingKnown: true,
      estimatedInputTokens: 200,
      estimatedOutputTokens: 80,
    };
  } else if (scenario === "budget_blocked") {
    observations = pricingHealthyObs();
    routedCall = {
      callId: `call-${runId}`,
      planId: "starter",
      subscriptionActive: true,
      creditsRemaining: budget.creditsRemaining,
      monthlyBudgetRemainingUsd: Math.min(budget.budgetRemainingUsd, monthlyCap),
      currentRunSpendUsd: 1.0,
      estimatedCreditsRequired: 1,
      estimatedCostUsd: 0.8,
      provider: "openai",
      model: "gpt-4.1-mini",
      pricingKnown: true,
      estimatedInputTokens: 500,
      estimatedOutputTokens: 200,
    };
  } else {
    observations = pricingHealthyObs();
    routedCall = {
      callId: `call-${runId}`,
      planId: "starter",
      subscriptionActive: true,
      creditsRemaining: budget.creditsRemaining,
      monthlyBudgetRemainingUsd: Math.min(budget.budgetRemainingUsd, monthlyCap),
      currentRunSpendUsd: 0,
      estimatedCreditsRequired: 1,
      estimatedCostUsd: 0.2,
      provider: "openai",
      model: "gpt-4.1-mini",
      pricingKnown: true,
      estimatedInputTokens: 400,
      estimatedOutputTokens: 120,
    };
  }

  const result = runMaintenanceCheck({
    runId,
    spec,
    observations,
    routedCall: scenario === "misconfigured" ? undefined : routedCall,
    generatedAt: now,
  });

  let nextBudget = budget;
  const specValid = validateEvalSpec(spec).ok;

  if (specValid && routedCall) {
    const gate = assertProviderCallAllowed({
      planId: routedCall.planId,
      subscriptionActive: routedCall.subscriptionActive,
      creditsRemaining: routedCall.creditsRemaining,
      monthlyBudgetRemainingUsd: Math.min(
        routedCall.monthlyBudgetRemainingUsd,
        spec.budgetGate.monthlyBudgetLimitUsd,
      ),
      currentRunSpendUsd: routedCall.currentRunSpendUsd,
      estimatedCreditsRequired: routedCall.estimatedCreditsRequired,
      estimatedCostUsd: routedCall.estimatedCostUsd,
      provider: routedCall.provider,
      model: routedCall.model,
      budgetGate: spec.budgetGate,
      pricingKnown: routedCall.pricingKnown,
    });

    const baseEntry: Omit<
      ProviderCallLedgerEntry,
      "status" | "blockReason" | "actualCostUsd" | "actualInputTokens" | "actualOutputTokens"
    > = {
      callId: routedCall.callId,
      runId,
      specId: spec.specId,
      provider: routedCall.provider,
      model: routedCall.model,
      estimatedInputTokens: routedCall.estimatedInputTokens,
      estimatedOutputTokens: routedCall.estimatedOutputTokens,
      estimatedCostUsd: routedCall.estimatedCostUsd,
      createdAt: now,
    };

    if (gate.decision === "allowed") {
      await appendProviderCallLedgerEntry(LEDGER_PATH, {
        ...baseEntry,
        status: "completed",
        actualInputTokens: routedCall.estimatedInputTokens,
        actualOutputTokens: routedCall.estimatedOutputTokens,
        actualCostUsd: routedCall.estimatedCostUsd,
      });
      nextBudget = applyBudgetUsage(nextBudget, {
        creditsUsed: routedCall.estimatedCreditsRequired,
        actualCostUsd: routedCall.estimatedCostUsd,
      });
    } else if (gate.decision === "blocked") {
      await appendProviderCallLedgerEntry(LEDGER_PATH, {
        ...baseEntry,
        status: "blocked",
        blockReason: gate.reason,
        actualCostUsd: 0,
      });
    } else {
      await appendProviderCallLedgerEntry(LEDGER_PATH, {
        ...baseEntry,
        status: "failed",
        blockReason: gate.reason,
        actualCostUsd: 0,
      });
    }
  }

  await writeFile(RESULT_PATH, JSON.stringify(result, null, 2), "utf-8");
  await writeFile(BUDGET_STATE_PATH, JSON.stringify(nextBudget, null, 2), "utf-8");

  console.log("Maintenance run status:", result.status);
  console.log("Checks:", result.checksRun, "passed:", result.checksPassed);
  console.log("Artifacts:");
  console.log(" ", RESULT_PATH);
  console.log(" ", BUDGET_STATE_PATH);
  console.log(" ", LEDGER_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

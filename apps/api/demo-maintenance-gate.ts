import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  applyBudgetUsage,
  assertProviderCallAllowed,
  type BudgetState,
} from "../../packages/shared/budget-gate";
import { parseEvalSpec, validateEvalSpec, type EvalSpec } from "../../packages/shared/eval-spec";
import type { EnforcementMode } from "../../packages/shared/maintenance-result";
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
const AGENT_QA_PATH = path.join(DELIVERABLES_DIR, "agent-quality-result.json");
const BUDGET_STATE_PATH = path.join(DELIVERABLES_DIR, "budget-state.json");
const LEDGER_PATH = path.join(DELIVERABLES_DIR, "provider-call-ledger.jsonl");

type Scenario =
  | "healthy"
  | "at_risk"
  | "failed"
  | "budget_blocked"
  | "misconfigured"
  | "missing_required_tool"
  | "wrong_tool_observed"
  | "no_tool_trace"
  | "forbidden_action"
  | "missing_evidence_manual_review"
  | "observe_mode"
  | "enforce_mode_blocks";

const SCENARIOS: Scenario[] = [
  "healthy",
  "at_risk",
  "failed",
  "budget_blocked",
  "misconfigured",
  "missing_required_tool",
  "wrong_tool_observed",
  "no_tool_trace",
  "forbidden_action",
  "missing_evidence_manual_review",
  "observe_mode",
  "enforce_mode_blocks",
];

function getScenario(): Scenario {
  const fromEnv = process.env.MAINTENANCE_SCENARIO as Scenario | undefined;
  const fromArg = process.argv[2] as Scenario | undefined;
  const s = fromArg || fromEnv || "healthy";
  if (SCENARIOS.includes(s)) return s;
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

function missingToolObs(): Record<string, SimulatedCaseObservation> {
  return {
    "tc-quote-starter": {
      output:
        "State the Starter price as $199/mo per this spec (from your defined catalog).",
      toolCalls: [],
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

function wrongToolObs(): Record<string, SimulatedCaseObservation> {
  return {
    "tc-quote-starter": {
      output:
        "State the Starter price as $199/mo per this spec (from your defined catalog).",
      toolCalls: ["lookup_legacy_pricing"],
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

function noToolTraceObs(): Record<string, SimulatedCaseObservation> {
  return {
    "tc-quote-starter": {
      output:
        "State the Starter price as $199/mo per this spec (from your defined catalog).",
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

function forbiddenActionObs(): Record<string, SimulatedCaseObservation> {
  const base = pricingHealthyObs();
  return {
    ...base,
    "tc-quote-starter": {
      ...base["tc-quote-starter"]!,
      actions: ["invent_plan_price"],
    },
  };
}

function missingEvidenceObs(): Record<string, SimulatedCaseObservation> {
  return {
    "tc-quote-starter": {
      output: "Starter pricing available.",
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

function baseRoutedCall(
  runId: string,
  budget: BudgetState,
  monthlyCap: number,
  overrides?: Partial<RoutedProviderCallAttempt>,
): RoutedProviderCallAttempt {
  return {
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
    budgetStatePresent: true,
    estimatedInputTokens: 400,
    estimatedOutputTokens: 120,
    ...overrides,
  };
}

async function main(): Promise<void> {
  const scenario = getScenario();
  console.log(
    "AI Reliability — Agent QA Firewall + maintenance gate demo\n",
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

  if (scenario === "missing_evidence_manual_review") {
    spec = {
      ...spec,
      testCases: spec.testCases.map((tc) =>
        tc.id === "tc-quote-starter"
          ? {
              ...tc,
              requiredEvidence: ["customer_catalog_id:starter-199"],
            }
          : tc,
      ),
    };
  }

  let enforcementMode: EnforcementMode = "enforce";
  if (scenario === "observe_mode") enforcementMode = "observe";
  if (
    scenario === "failed" ||
    scenario === "enforce_mode_blocks" ||
    scenario === "missing_required_tool" ||
    scenario === "wrong_tool_observed" ||
    scenario === "no_tool_trace" ||
    scenario === "forbidden_action"
  ) {
    enforcementMode = "enforce";
  }

  let observations: Record<string, SimulatedCaseObservation>;
  let routedCall: RoutedProviderCallAttempt | undefined;
  let ledgerWriteSucceeded = true;

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

  switch (scenario) {
    case "healthy":
    case "enforce_mode_blocks":
      observations = pricingHealthyObs();
      routedCall = baseRoutedCall(runId, budget, monthlyCap);
      break;
    case "observe_mode":
      observations = missingToolObs();
      routedCall = baseRoutedCall(runId, budget, monthlyCap);
      break;
    case "at_risk":
      observations = pricingAtRiskObs();
      routedCall = baseRoutedCall(runId, budget, monthlyCap, {
        estimatedCostUsd: 0.15,
        estimatedInputTokens: 300,
        estimatedOutputTokens: 100,
      });
      break;
    case "failed":
    case "forbidden_action":
      observations =
        scenario === "forbidden_action" ? forbiddenActionObs() : pricingFailedObs();
      routedCall = baseRoutedCall(runId, budget, monthlyCap, {
        estimatedCostUsd: 0.1,
        estimatedInputTokens: 200,
        estimatedOutputTokens: 80,
      });
      break;
    case "missing_required_tool":
      observations = missingToolObs();
      routedCall = baseRoutedCall(runId, budget, monthlyCap);
      break;
    case "wrong_tool_observed":
      observations = wrongToolObs();
      routedCall = baseRoutedCall(runId, budget, monthlyCap);
      break;
    case "no_tool_trace":
      observations = noToolTraceObs();
      routedCall = baseRoutedCall(runId, budget, monthlyCap);
      break;
    case "missing_evidence_manual_review":
      observations = missingEvidenceObs();
      routedCall = baseRoutedCall(runId, budget, monthlyCap);
      break;
    case "budget_blocked":
      observations = pricingHealthyObs();
      routedCall = baseRoutedCall(runId, budget, monthlyCap, {
        currentRunSpendUsd: 1.0,
        estimatedCostUsd: 0.8,
        estimatedInputTokens: 500,
        estimatedOutputTokens: 200,
      });
      break;
    case "misconfigured":
      observations = pricingHealthyObs();
      routedCall = undefined;
      break;
    default:
      observations = pricingHealthyObs();
      routedCall = baseRoutedCall(runId, budget, monthlyCap);
  }

  if (scenario === "enforce_mode_blocks") {
    observations = pricingFailedObs();
  }

  const result = runMaintenanceCheck({
    runId,
    spec,
    observations,
    routedCall: scenario === "misconfigured" ? undefined : routedCall,
    enforcementMode,
    ledgerWriteSucceeded,
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
      budgetStatePresent: routedCall.budgetStatePresent,
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

    try {
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
          blockReason: gate.reasonCode,
          actualCostUsd: 0,
        });
      } else {
        await appendProviderCallLedgerEntry(LEDGER_PATH, {
          ...baseEntry,
          status: "failed",
          blockReason: gate.reasonCode,
          actualCostUsd: 0,
        });
      }
    } catch {
      ledgerWriteSucceeded = false;
    }
  }

  const agentQualityPayload = {
    runId: result.runId,
    specId: result.specId,
    scenario,
    enforcementMode: result.agentQa?.enforcementMode,
    gateDecision: result.agentQa?.gateDecision,
    decisionReason: result.agentQa?.decisionReason,
    confidence: result.agentQa?.confidence,
    requiresHumanReview: result.agentQa?.requiresHumanReview,
    remediation: result.agentQa?.remediation,
    evidenceCompleteness: result.agentQa?.evidenceCompleteness,
    wouldBlockCount: result.agentQa?.wouldBlockCount,
    checkCounts: result.agentQa?.checkCounts,
    maintenanceStatus: result.status,
    generatedAt: result.generatedAt,
  };

  await writeFile(RESULT_PATH, JSON.stringify(result, null, 2), "utf-8");
  await writeFile(AGENT_QA_PATH, JSON.stringify(agentQualityPayload, null, 2), "utf-8");
  await writeFile(BUDGET_STATE_PATH, JSON.stringify(nextBudget, null, 2), "utf-8");

  console.log("Maintenance run status:", result.status);
  console.log("Agent QA gate decision:", result.agentQa?.gateDecision);
  console.log("Enforcement mode:", result.agentQa?.enforcementMode);
  console.log("Checks:", result.checksRun, "passed:", result.checksPassed);
  console.log("Artifacts:");
  console.log(" ", RESULT_PATH);
  console.log(" ", AGENT_QA_PATH);
  console.log(" ", BUDGET_STATE_PATH);
  console.log(" ", LEDGER_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

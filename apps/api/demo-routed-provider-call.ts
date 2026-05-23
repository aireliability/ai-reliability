import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { EvalSpecBudgetGate } from "../../packages/shared/eval-spec";
import {
  buildRoutedCallResultArtifact,
  runRoutedProviderCall,
} from "../../packages/shared/routed-provider-call";
import { readProviderCallLedger } from "../../packages/shared/provider-call-ledger";

const DELIVERABLES_DIR = path.join("deliverables", "maintenance");
const LEDGER_PATH = path.join(DELIVERABLES_DIR, "provider-call-ledger.jsonl");
const ARTIFACT_PATH = path.join(DELIVERABLES_DIR, "routed-call-result.json");

const budgetGate: EvalSpecBudgetGate = {
  monthlyBudgetLimitUsd: 100,
  perRunBudgetLimitUsd: 1.5,
  allowedProviders: ["openai"],
  allowedModels: ["gpt-4.1-mini"],
  failClosed: true,
};

const budgetState = {
  planId: "starter",
  creditsRemaining: 500,
  budgetRemainingUsd: 80,
  creditsUsed: 0,
  budgetUsedUsd: 0,
};

type Scenario = {
  name: string;
  input: Parameters<typeof runRoutedProviderCall>[0];
  expectAllowed: boolean;
  expectExecuted: boolean;
  expectReason?: string;
};

async function mockExecute(label: string) {
  return {
    output: `[mock provider] ${label}`,
    actualCostUsd: 0.15,
    actualInputTokens: 180,
    actualOutputTokens: 60,
  };
}

async function main(): Promise<void> {
  console.log("AI Reliability — Routed provider-call Budget Gate demo\n");
  console.log(
    "Budget enforcement applies only to provider calls routed through the AI Reliability gate.\n",
  );

  await mkdir(DELIVERABLES_DIR, { recursive: true });
  await writeFile(LEDGER_PATH, "", "utf-8");

  const runId = `routed-${randomUUID()}`;
  const scenarios: Scenario[] = [
    {
      name: "allowed routed call executes mock provider",
      input: {
        runId,
        provider: "openai",
        model: "gpt-4.1-mini",
        estimatedCostUsd: 0.15,
        estimatedInputTokens: 200,
        estimatedOutputTokens: 80,
        budgetState: { ...budgetState },
        budgetGate,
        pricingKnown: true,
        ledgerPath: LEDGER_PATH,
        specId: "agent-budget-gate-v1",
        workflowName: "llm_router_agent",
        environment: "production",
      },
      expectAllowed: true,
      expectExecuted: true,
      expectReason: "routed_call_allowed",
    },
    {
      name: "over per-run limit blocks before execution",
      input: {
        runId,
        provider: "openai",
        model: "gpt-4.1-mini",
        estimatedCostUsd: 0.8,
        currentRunSpendUsd: 1.0,
        budgetState: { ...budgetState },
        budgetGate,
        pricingKnown: true,
        ledgerPath: LEDGER_PATH,
        specId: "agent-budget-gate-v1",
      },
      expectAllowed: false,
      expectExecuted: false,
      expectReason: "per_run_budget_exceeded",
    },
    {
      name: "unknown model blocks before execution",
      input: {
        runId,
        provider: "openai",
        model: "",
        estimatedCostUsd: 0.1,
        budgetState: { ...budgetState },
        budgetGate,
        pricingKnown: true,
        ledgerPath: LEDGER_PATH,
      },
      expectAllowed: false,
      expectExecuted: false,
      expectReason: "unknown_model",
    },
    {
      name: "provider not allowed blocks before execution",
      input: {
        runId,
        provider: "anthropic",
        model: "gpt-4.1-mini",
        estimatedCostUsd: 0.1,
        budgetState: { ...budgetState },
        budgetGate,
        pricingKnown: true,
        ledgerPath: LEDGER_PATH,
      },
      expectAllowed: false,
      expectExecuted: false,
      expectReason: "provider_not_allowed",
    },
    {
      name: "missing budget state blocks before execution",
      input: {
        runId,
        provider: "openai",
        model: "gpt-4.1-mini",
        estimatedCostUsd: 0.1,
        budgetState: null,
        budgetGate,
        pricingKnown: true,
        ledgerPath: LEDGER_PATH,
      },
      expectAllowed: false,
      expectExecuted: false,
      expectReason: "missing_budget_state",
    },
  ];

  const results = [];
  let failures = 0;

  for (const scenario of scenarios) {
    let executeCount = 0;
    const result = await runRoutedProviderCall(scenario.input, async () => {
      executeCount += 1;
      return mockExecute(scenario.name);
    });

    const ok =
      result.allowed === scenario.expectAllowed &&
      result.executed === scenario.expectExecuted &&
      (!scenario.expectReason || result.reasonCode === scenario.expectReason) &&
      (scenario.expectExecuted ? executeCount === 1 : executeCount === 0);

    if (!ok) failures += 1;

    console.log(`Scenario: ${scenario.name}`);
    console.log(`  allowed: ${result.allowed} (expected ${scenario.expectAllowed})`);
    console.log(`  executed: ${result.executed} (expected ${scenario.expectExecuted})`);
    console.log(`  reasonCode: ${result.reasonCode}`);
    if (result.remediation.length > 0) {
      console.log(`  remediation: ${result.remediation.join(" | ")}`);
    }
    console.log(`  scenario OK: ${ok ? "yes" : "NO"}\n`);

    results.push(result);
  }

  const lastAllowed = results.find((r) => r.executed);
  if (lastAllowed) {
    const artifact = buildRoutedCallResultArtifact({
      result: lastAllowed,
      source: "demo:routed-call-gate",
      generatedAt: new Date().toISOString(),
      relatedArtifacts: {
        providerCallLedger: LEDGER_PATH,
        budgetState: path.join(DELIVERABLES_DIR, "budget-state.json"),
      },
    });
    await writeFile(ARTIFACT_PATH, JSON.stringify(artifact, null, 2), "utf-8");
    console.log("Artifact:", ARTIFACT_PATH);
  }

  const ledger = await readProviderCallLedger(LEDGER_PATH);
  console.log(`Ledger entries written: ${ledger.length} (${LEDGER_PATH})`);

  if (failures > 0) {
    console.error(`\n${failures} scenario(s) failed expectations.`);
    process.exit(1);
  }
  console.log("\nAll routed-call gate demo scenarios behaved as expected.");
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

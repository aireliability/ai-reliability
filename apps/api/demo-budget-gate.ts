import { readFile } from "node:fs/promises";
import {
  assertBudgetAvailable,
  applyBudgetUsage,
  DEFAULT_MODEL_CALL_CREDITS_REQUIRED,
  DEFAULT_MODEL_CALL_ESTIMATE_USD,
  type BudgetState,
} from "../../packages/shared/budget-gate";

const estimate = {
  creditsRequired: DEFAULT_MODEL_CALL_CREDITS_REQUIRED,
  estimatedCostUsd: DEFAULT_MODEL_CALL_ESTIMATE_USD,
};

function logBlockedScenario(title: string, budget: BudgetState): void {
  console.log(`\n${title}`);
  console.log("  Step 1 — Budget check runs before any model/API call.");
  let providerCalls = 0;
  try {
    assertBudgetAvailable(budget, estimate);
    providerCalls += 1;
    console.log("  (unexpected) Model call path reached.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  Step 2 — Blocked: ${msg}`);
    console.log(`  Provider calls made: ${providerCalls} (expected 0).`);
  }
}

async function main(): Promise<void> {
  console.log("AI Reliability — budget gate demo (no OpenAI or network calls)\n");
  console.log(
    "Each eval sample reserves",
    estimate.creditsRequired,
    "credit(s) and up to",
    estimate.estimatedCostUsd,
    "USD per call (conservative estimate).\n",
  );

  console.log("— Scenario A: Sufficient credits and budget —");
  console.log("  Step 1 — Budget check (before model call)...");
  let providerCalls = 0;
  let budget: BudgetState = {
    planId: "starter",
    creditsRemaining: 1000,
    budgetRemainingUsd: 500,
    creditsUsed: 0,
    budgetUsedUsd: 0,
  };
  assertBudgetAvailable(budget, estimate);
  console.log("  OK — within limits.");
  providerCalls += 1;
  console.log("  Step 2 — Model/API call (simulated only in this demo).");
  budget = applyBudgetUsage(budget, {
    creditsUsed: estimate.creditsRequired,
    actualCostUsd: estimate.estimatedCostUsd,
  });
  console.log(
    `  After one simulated call: credits remaining=${budget.creditsRemaining}, USD remaining=${budget.budgetRemainingUsd.toFixed(2)}.`,
  );
  console.log(`  Provider calls made: ${providerCalls} (expected 1).`);

  logBlockedScenario("— Scenario B: Insufficient credits —", {
    planId: "starter",
    creditsRemaining: 0,
    budgetRemainingUsd: 500,
    creditsUsed: 0,
    budgetUsedUsd: 0,
  });

  logBlockedScenario("— Scenario C: Insufficient budget (credits OK) —", {
    planId: "starter",
    creditsRemaining: 100,
    budgetRemainingUsd: 0,
    creditsUsed: 0,
    budgetUsedUsd: 0,
  });

  const blockedRaw = await readFile(
    "configs/openai.budget-blocked.example.json",
    "utf-8",
  );
  const blockedConfig = JSON.parse(blockedRaw) as { budget: BudgetState };
  logBlockedScenario(
    "— Scenario D: Blocked example config (configs/openai.budget-blocked.example.json) —",
    blockedConfig.budget,
  );

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

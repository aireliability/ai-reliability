import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import type { EvalSpecBudgetGate } from "./eval-spec";
import { readProviderCallLedger } from "./provider-call-ledger";
import {
  createRoutedProviderCallObservation,
  guardRoutedProviderCall,
  runRoutedProviderCall,
} from "./routed-provider-call";

const budgetGate: EvalSpecBudgetGate = {
  monthlyBudgetLimitUsd: 100,
  perRunBudgetLimitUsd: 1.5,
  allowedProviders: ["openai"],
  allowedModels: ["gpt-4.1-mini"],
  failClosed: true,
};

const budgetState = () => ({
  planId: "starter",
  creditsRemaining: 500,
  budgetRemainingUsd: 80,
  creditsUsed: 0,
  budgetUsedUsd: 0,
});

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-test",
    provider: "openai",
    model: "gpt-4.1-mini",
    estimatedInputTokens: 200,
    estimatedOutputTokens: 80,
    estimatedCostUsd: 0.2,
    currentRunSpendUsd: 0,
    budgetState: budgetState(),
    budgetGate,
    pricingKnown: true,
    specId: "agent-budget-gate-v1",
    workflowName: "llm_router_agent",
    environment: "production" as const,
    ...overrides,
  };
}

describe("guardRoutedProviderCall", () => {
  it("allows healthy routed call", () => {
    const r = guardRoutedProviderCall(baseInput());
    assert.equal(r.allowed, true);
    assert.equal(r.executed, false);
    assert.equal(r.reasonCode, "routed_call_allowed");
  });

  it("blocks per-run budget exceeded", () => {
    const r = guardRoutedProviderCall(
      baseInput({ currentRunSpendUsd: 1.0, estimatedCostUsd: 0.8 }),
    );
    assert.equal(r.allowed, false);
    assert.equal(r.reasonCode, "per_run_budget_exceeded");
    assert.ok(r.remediation.length > 0);
  });

  it("blocks monthly budget exceeded", () => {
    const r = guardRoutedProviderCall(
      baseInput({
        budgetState: { ...budgetState(), budgetRemainingUsd: 0.1 },
        estimatedCostUsd: 0.5,
      }),
    );
    assert.equal(r.allowed, false);
    assert.equal(r.reasonCode, "monthly_budget_exceeded");
  });

  it("blocks unknown provider", () => {
    const r = guardRoutedProviderCall(baseInput({ provider: "" }));
    assert.equal(r.allowed, false);
    assert.equal(r.reasonCode, "unknown_provider");
  });

  it("blocks unknown model", () => {
    const r = guardRoutedProviderCall(baseInput({ model: "  " }));
    assert.equal(r.allowed, false);
    assert.equal(r.reasonCode, "unknown_model");
  });

  it("blocks provider not allowed", () => {
    const r = guardRoutedProviderCall(baseInput({ provider: "anthropic" }));
    assert.equal(r.allowed, false);
    assert.equal(r.reasonCode, "provider_not_allowed");
  });

  it("blocks model not allowed", () => {
    const r = guardRoutedProviderCall(baseInput({ model: "gpt-4o" }));
    assert.equal(r.allowed, false);
    assert.equal(r.reasonCode, "model_not_allowed");
  });

  it("blocks missing budget state", () => {
    const r = guardRoutedProviderCall(baseInput({ budgetState: null }));
    assert.equal(r.allowed, false);
    assert.equal(r.reasonCode, "missing_budget_state");
  });

  it("blocks missing pricing when failClosed", () => {
    const r = guardRoutedProviderCall(baseInput({ pricingKnown: false }));
    assert.equal(r.allowed, false);
    assert.equal(r.reasonCode, "missing_pricing");
  });

  it("blocks invalid cost estimate", () => {
    const r = guardRoutedProviderCall(baseInput({ estimatedCostUsd: -1 }));
    assert.equal(r.allowed, false);
    assert.equal(r.reasonCode, "invalid_cost_estimate");
  });

  it("blocks invalid token values", () => {
    const r = guardRoutedProviderCall(baseInput({ estimatedInputTokens: -5 }));
    assert.equal(r.allowed, false);
    assert.equal(r.reasonCode, "invalid_token_values");
  });

  it("blocks credits exhausted", () => {
    const r = guardRoutedProviderCall(
      baseInput({
        budgetState: { ...budgetState(), creditsRemaining: 0 },
      }),
    );
    assert.equal(r.allowed, false);
    assert.equal(r.reasonCode, "credits_exhausted");
  });
});

describe("runRoutedProviderCall", () => {
  it("allowed call executes callback exactly once", async () => {
    let count = 0;
    const dir = await mkdtemp(join(tmpdir(), "routed-call-"));
    try {
      const ledgerPath = join(dir, "ledger.jsonl");
      const r = await runRoutedProviderCall(
        baseInput({ ledgerPath, runId: "run-allowed" }),
        async () => {
          count += 1;
          return { actualCostUsd: 0.18, output: "mock response" };
        },
      );
      assert.equal(count, 1);
      assert.equal(r.executed, true);
      assert.equal(r.allowed, true);
      assert.equal(r.actualCostUsd, 0.18);
      assert.ok(r.budgetStateAfter);
      assert.equal(r.budgetStateAfter!.budgetRemainingUsd, 79.82);

      const ledger = await readProviderCallLedger(ledgerPath);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]!.status, "completed");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("blocked call does not execute callback", async () => {
    let count = 0;
    const dir = await mkdtemp(join(tmpdir(), "routed-call-block-"));
    try {
      const ledgerPath = join(dir, "ledger.jsonl");
      const r = await runRoutedProviderCall(
        baseInput({
          ledgerPath,
          provider: "anthropic",
        }),
        async () => {
          count += 1;
          return { actualCostUsd: 0.1 };
        },
      );
      assert.equal(count, 0);
      assert.equal(r.executed, false);
      assert.equal(r.reasonCode, "provider_not_allowed");

      const ledger = await readProviderCallLedger(ledgerPath);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]!.status, "blocked");
      assert.equal(ledger[0]!.blockReason, "provider_not_allowed");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("ledger write failure on blocked path returns ledger_write_failed without execute", async () => {
    let count = 0;
    const dir = await mkdtemp(join(tmpdir(), "routed-call-ledger-fail-"));
    try {
      const blocker = join(dir, "blocker");
      await writeFile(blocker, "not-a-directory");
      const ledgerPath = join(blocker, "ledger.jsonl");
      const r = await runRoutedProviderCall(
        baseInput({
          ledgerPath,
          provider: "anthropic",
          ledgerRequired: true,
        }),
        async () => {
          count += 1;
          return {};
        },
      );
      assert.equal(count, 0);
      assert.equal(r.executed, false);
      assert.equal(r.reasonCode, "ledger_write_failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("createRoutedProviderCallObservation", () => {
  it("maps allowed result to observation routedCalls entry", () => {
    const obs = createRoutedProviderCallObservation({
      callId: "c1",
      runId: "r1",
      provider: "openai",
      model: "gpt-4.1-mini",
      gateDecision: "pass",
      enforcementOutcome: "passed",
      reasonCode: "routed_call_allowed",
      allowed: true,
      executed: true,
      estimatedInputTokens: 100,
      estimatedOutputTokens: 50,
      estimatedCostUsd: 0.2,
      estimatedCreditsRequired: 1,
      actualCostUsd: 0.19,
      remediation: [],
    });
    assert.equal(obs.provider, "openai");
    assert.equal(obs.status, "completed");
    assert.equal(obs.estimatedCostUsd, 0.2);
    assert.equal(obs.actualCostUsd, 0.19);
  });

  it("maps blocked result to observation entry", () => {
    const obs = createRoutedProviderCallObservation({
      callId: "c2",
      runId: "r1",
      provider: "openai",
      model: "gpt-4.1-mini",
      gateDecision: "block",
      enforcementOutcome: "blocked",
      reasonCode: "per_run_budget_exceeded",
      allowed: false,
      executed: false,
      estimatedInputTokens: 100,
      estimatedOutputTokens: 50,
      estimatedCostUsd: 2,
      estimatedCreditsRequired: 1,
      remediation: ["Reduce per-run routed-call spend or raise perRunBudgetLimitUsd in the spec."],
    });
    assert.equal(obs.status, "blocked");
  });
});

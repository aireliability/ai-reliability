import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertBudgetAvailable,
  applyBudgetUsage,
  DEFAULT_MODEL_CALL_CREDITS_REQUIRED,
  DEFAULT_MODEL_CALL_ESTIMATE_USD,
} from "./budget-gate";

const baseState = () =>
  ({
    planId: "starter",
    creditsRemaining: 100,
    budgetRemainingUsd: 50,
    creditsUsed: 0,
    budgetUsedUsd: 0,
  }) as const;

describe("assertBudgetAvailable", () => {
  it("passes when credits and budget are sufficient", () => {
    const ok = assertBudgetAvailable(baseState(), {
      creditsRequired: DEFAULT_MODEL_CALL_CREDITS_REQUIRED,
      estimatedCostUsd: DEFAULT_MODEL_CALL_ESTIMATE_USD,
    });
    assert.equal(ok, true);
  });

  it("blocks when credits are insufficient", () => {
    assert.throws(
      () =>
        assertBudgetAvailable(
          { ...baseState(), creditsRemaining: 0 },
          {
            creditsRequired: DEFAULT_MODEL_CALL_CREDITS_REQUIRED,
            estimatedCostUsd: DEFAULT_MODEL_CALL_ESTIMATE_USD,
          },
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "Credits exhausted — execution blocked before model call.",
    );
  });

  it("blocks when budget USD is insufficient", () => {
    assert.throws(
      () =>
        assertBudgetAvailable(
          { ...baseState(), budgetRemainingUsd: 0 },
          {
            creditsRequired: DEFAULT_MODEL_CALL_CREDITS_REQUIRED,
            estimatedCostUsd: DEFAULT_MODEL_CALL_ESTIMATE_USD,
          },
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "Budget limit reached — execution blocked before model call.",
    );
  });
});

describe("applyBudgetUsage", () => {
  it("does not mutate the original state object", () => {
    const state = baseState();
    const snapshot = { ...state };
    applyBudgetUsage(state, {
      creditsUsed: 5,
      actualCostUsd: 10,
    });
    assert.deepEqual(state, snapshot);
  });

  it("clamps creditsRemaining and budgetRemainingUsd at zero", () => {
    const next = applyBudgetUsage(
      { ...baseState(), creditsRemaining: 2, budgetRemainingUsd: 0.1 },
      { creditsUsed: 100, actualCostUsd: 50 },
    );
    assert.equal(next.creditsRemaining, 0);
    assert.equal(next.budgetRemainingUsd, 0);
    assert.equal(next.creditsUsed, 100);
    assert.equal(next.budgetUsedUsd, 50);
  });
});

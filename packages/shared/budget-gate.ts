/** Per-call credit cost reserved when usage is not metered from the provider. */
export const DEFAULT_MODEL_CALL_CREDITS_REQUIRED = 1;

/**
 * Conservative USD ceiling per provider call for gating when exact usage is unavailable.
 */
export const DEFAULT_MODEL_CALL_ESTIMATE_USD = 0.25;

export interface BudgetState {
  planId: string;
  creditsRemaining: number;
  budgetRemainingUsd: number;
  creditsUsed: number;
  budgetUsedUsd: number;
}

export interface EstimatedRunCost {
  creditsRequired: number;
  estimatedCostUsd: number;
}

export interface ActualRunCost {
  creditsUsed: number;
  actualCostUsd: number;
}

export function assertBudgetAvailable(
  state: BudgetState,
  estimate: EstimatedRunCost,
): true {
  if (state.creditsRemaining < estimate.creditsRequired) {
    throw new Error(
      "Credits exhausted — execution blocked before model call.",
    );
  }
  if (state.budgetRemainingUsd < estimate.estimatedCostUsd) {
    throw new Error(
      "Budget limit reached — execution blocked before model call.",
    );
  }
  return true;
}

export function applyBudgetUsage(
  state: BudgetState,
  actual: ActualRunCost,
): BudgetState {
  const creditsRemaining = Math.max(
    0,
    state.creditsRemaining - actual.creditsUsed,
  );
  const budgetRemainingUsd = Math.max(
    0,
    state.budgetRemainingUsd - actual.actualCostUsd,
  );
  return {
    planId: state.planId,
    creditsRemaining,
    budgetRemainingUsd,
    creditsUsed: state.creditsUsed + actual.creditsUsed,
    budgetUsedUsd: state.budgetUsedUsd + actual.actualCostUsd,
  };
}

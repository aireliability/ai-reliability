import type { EvalSpecBudgetGate } from "./eval-spec";
import { getPlanEntitlement } from "./entitlements";

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

/**
 * Decision for routed provider calls only — calls routed through the AI Reliability gate.
 * Direct provider calls that bypass the gate are outside this enforcement scope.
 */
export type ProviderCallGateDecision = "allowed" | "blocked" | "misconfigured";

export interface ProviderCallGateResult {
  decision: ProviderCallGateDecision;
  /** Stable machine-oriented reason; safe to surface in API responses. */
  reason: string;
}

export interface AssertProviderCallAllowedInput {
  planId: string;
  /** When false, access-gated calls are blocked. Omit when not modeled. */
  subscriptionActive?: boolean;
  creditsRemaining: number;
  /** Remaining monthly USD budget for routed calls (after prior usage this period). */
  monthlyBudgetRemainingUsd: number;
  /** Accumulated estimated or actual USD for the current maintenance run (for per-run cap). */
  currentRunSpendUsd: number;
  estimatedCreditsRequired: number;
  estimatedCostUsd: number;
  provider: string;
  model: string;
  budgetGate: EvalSpecBudgetGate;
  /**
   * When false and failClosed is true, pricing is treated as unknown → misconfigured.
   */
  pricingKnown?: boolean;
}

/**
 * Assert whether a routed provider/model call may proceed under spec budget gate rules.
 * Does not throw; returns structured allow / block / misconfigured.
 */
export function assertProviderCallAllowed(
  input: AssertProviderCallAllowedInput,
): ProviderCallGateResult {
  const { budgetGate } = input;

  if (!Number.isFinite(input.creditsRemaining)) {
    return { decision: "misconfigured", reason: "invalid_credits_state" };
  }
  if (!Number.isFinite(input.monthlyBudgetRemainingUsd)) {
    return { decision: "misconfigured", reason: "invalid_monthly_budget_state" };
  }
  if (!Number.isFinite(input.currentRunSpendUsd)) {
    return { decision: "misconfigured", reason: "invalid_run_spend_state" };
  }
  if (!Number.isFinite(input.estimatedCreditsRequired)) {
    return { decision: "misconfigured", reason: "invalid_credit_estimate" };
  }
  if (!Number.isFinite(input.estimatedCostUsd)) {
    if (budgetGate.failClosed) {
      return { decision: "misconfigured", reason: "missing_pricing" };
    }
    return { decision: "blocked", reason: "invalid_cost_estimate" };
  }

  try {
    getPlanEntitlement(input.planId);
  } catch {
    return { decision: "misconfigured", reason: "unknown_plan_entitlement" };
  }

  if (input.subscriptionActive === false) {
    return { decision: "blocked", reason: "subscription_inactive" };
  }

  if (input.pricingKnown === false && budgetGate.failClosed) {
    return { decision: "misconfigured", reason: "missing_pricing" };
  }

  if (input.creditsRemaining < input.estimatedCreditsRequired) {
    return { decision: "blocked", reason: "credits_exhausted" };
  }

  if (input.estimatedCostUsd > input.monthlyBudgetRemainingUsd) {
    return { decision: "blocked", reason: "monthly_budget_exceeded" };
  }

  if (
    budgetGate.perRunBudgetLimitUsd !== undefined &&
    input.currentRunSpendUsd + input.estimatedCostUsd >
      budgetGate.perRunBudgetLimitUsd
  ) {
    return { decision: "blocked", reason: "per_run_budget_exceeded" };
  }

  const providers = budgetGate.allowedProviders;
  if (
    providers !== undefined &&
    providers.length > 0 &&
    !providers.includes(input.provider)
  ) {
    return { decision: "blocked", reason: "provider_not_allowed" };
  }

  const models = budgetGate.allowedModels;
  if (
    models !== undefined &&
    models.length > 0 &&
    !models.includes(input.model)
  ) {
    return { decision: "blocked", reason: "model_not_allowed" };
  }

  return { decision: "allowed", reason: "routed_call_allowed" };
}

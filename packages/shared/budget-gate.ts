import {
  budgetReasonToRemediation,
  REMEDIATION_BUDGET_STATE,
  REMEDIATION_PRICING_CONFIG,
} from "./agent-qa";
import type { EvalSpecBudgetGate } from "./eval-spec";
import { getPlanEntitlement } from "./entitlements";
import type {
  EnforcementOutcome,
  GateDecision,
} from "./maintenance-result";

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
  reasonCode: string;
  gateDecision: GateDecision;
  enforcementOutcome: EnforcementOutcome;
  remediation: string[];
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
  /**
   * When false, budget state was not loaded for this routed call (fail closed).
   */
  budgetStatePresent?: boolean;
}

function gateResult(
  decision: ProviderCallGateDecision,
  reasonCode: string,
): ProviderCallGateResult {
  const remediation = budgetReasonToRemediation(reasonCode);
  if (decision === "allowed") {
    return {
      decision,
      reason: reasonCode,
      reasonCode,
      gateDecision: "pass",
      enforcementOutcome: "passed",
      remediation: [],
    };
  }
  if (decision === "misconfigured") {
    const gateDecision: GateDecision =
      reasonCode === "missing_pricing" ||
      reasonCode === "unknown_plan_entitlement"
        ? "block"
        : "block";
    return {
      decision,
      reason: reasonCode,
      reasonCode,
      gateDecision,
      enforcementOutcome: "blocked",
      remediation,
    };
  }
  return {
    decision: "blocked",
    reason: reasonCode,
    reasonCode,
    gateDecision: "block",
    enforcementOutcome: "blocked",
    remediation,
  };
}

/**
 * Assert whether a routed provider/model call may proceed under spec budget gate rules.
 * Does not throw; returns structured allow / block / misconfigured with Agent QA fields.
 */
export function assertProviderCallAllowed(
  input: AssertProviderCallAllowedInput,
): ProviderCallGateResult {
  const { budgetGate } = input;

  if (input.budgetStatePresent === false) {
    return {
      decision: "misconfigured",
      reason: "missing_budget_state",
      reasonCode: "missing_budget_state",
      gateDecision: "block",
      enforcementOutcome: "blocked",
      remediation: [REMEDIATION_BUDGET_STATE],
    };
  }

  if (!Number.isFinite(input.creditsRemaining)) {
    return gateResult("misconfigured", "invalid_credits_state");
  }
  if (!Number.isFinite(input.monthlyBudgetRemainingUsd)) {
    return gateResult("misconfigured", "invalid_monthly_budget_state");
  }
  if (!Number.isFinite(input.currentRunSpendUsd)) {
    return gateResult("misconfigured", "invalid_run_spend_state");
  }
  if (!Number.isFinite(input.estimatedCreditsRequired)) {
    return gateResult("misconfigured", "invalid_credit_estimate");
  }
  if (!Number.isFinite(input.estimatedCostUsd)) {
    if (budgetGate.failClosed) {
      return {
        decision: "misconfigured",
        reason: "missing_pricing",
        reasonCode: "missing_pricing",
        gateDecision: "block",
        enforcementOutcome: "blocked",
        remediation: [REMEDIATION_PRICING_CONFIG],
      };
    }
    return gateResult("blocked", "invalid_cost_estimate");
  }

  try {
    getPlanEntitlement(input.planId);
  } catch {
    return gateResult("misconfigured", "unknown_plan_entitlement");
  }

  if (input.subscriptionActive === false) {
    return gateResult("blocked", "subscription_inactive");
  }

  if (input.pricingKnown === false && budgetGate.failClosed) {
    return {
      decision: "misconfigured",
      reason: "missing_pricing",
      reasonCode: "missing_pricing",
      gateDecision: "block",
      enforcementOutcome: "blocked",
      remediation: [REMEDIATION_PRICING_CONFIG],
    };
  }

  if (input.creditsRemaining < input.estimatedCreditsRequired) {
    return gateResult("blocked", "credits_exhausted");
  }

  if (input.estimatedCostUsd > input.monthlyBudgetRemainingUsd) {
    return gateResult("blocked", "monthly_budget_exceeded");
  }

  if (
    budgetGate.perRunBudgetLimitUsd !== undefined &&
    input.currentRunSpendUsd + input.estimatedCostUsd >
      budgetGate.perRunBudgetLimitUsd
  ) {
    return gateResult("blocked", "per_run_budget_exceeded");
  }

  const providers = budgetGate.allowedProviders;
  if (
    providers !== undefined &&
    providers.length > 0 &&
    !providers.includes(input.provider)
  ) {
    return gateResult("blocked", "provider_not_allowed");
  }

  const models = budgetGate.allowedModels;
  if (
    models !== undefined &&
    models.length > 0 &&
    !models.includes(input.model)
  ) {
    return gateResult("blocked", "model_not_allowed");
  }

  return gateResult("allowed", "routed_call_allowed");
}

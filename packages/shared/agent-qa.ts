import type { EvalSeverity } from "./eval-spec";
import type {
  AgentQaCheckResult,
  AgentQaDecision,
  AgentQaSummary,
  CheckCategory,
  CheckMethod,
  EnforcementMode,
  EnforcementOutcome,
  EvidenceCompleteness,
  GateDecision,
  MaintenanceCheckResult,
} from "./maintenance-result";

export const REMEDIATION_TOOL_TRACE =
  "Provide a tool trace artifact or route the agent step through the AI Reliability wrapper.";

export const REMEDIATION_OUTPUT_EVIDENCE =
  "Capture agent output for this step and attach it to the maintenance run observation.";

export const REMEDIATION_BUDGET_STATE =
  "Load routed-call budget state before evaluating provider calls through the gate.";

export const REMEDIATION_PRICING_CONFIG =
  "Configure provider/model pricing for routed calls or set pricingKnown with failClosed disabled.";

export const REMEDIATION_LEDGER_WRITE =
  "Fix provider-call ledger persistence; ledger write failures must not be treated as pass.";

/** manual_review and block are never a passing gate decision. */
export function isPassingGateDecision(decision: GateDecision): boolean {
  return decision === "pass";
}

export function gateDecisionAllowsDeploy(
  decision: GateDecision,
  enforcementMode: EnforcementMode,
): boolean {
  if (decision === "manual_review") return false;
  if (decision === "pass") return true;
  if (enforcementMode === "observe") return true;
  return false;
}

export function severityToDefaultOutcome(
  severity: EvalSeverity,
  enforcementMode: EnforcementMode,
): EnforcementOutcome {
  if (severity === "info") return "warning";
  if (severity === "warning") {
    return enforcementMode === "enforce" ? "manual_review" : "warning";
  }
  return enforcementMode === "observe" ? "warning" : "blocked";
}

export function enforcementOutcomeToGateContribution(
  outcome: EnforcementOutcome,
  enforcementMode: EnforcementMode,
): GateDecision | null {
  switch (outcome) {
    case "passed":
      return null;
    case "warning":
      return enforcementMode === "observe" ? null : null;
    case "manual_review":
      return "manual_review";
    case "blocked":
      return enforcementMode === "observe" ? null : "block";
    default:
      return null;
  }
}

export function mergeGateDecisions(decisions: GateDecision[]): GateDecision {
  if (decisions.includes("block")) return "block";
  if (decisions.includes("manual_review")) return "manual_review";
  return "pass";
}

export function mapCheckKindToCategory(
  kind: MaintenanceCheckResult["kind"],
): CheckCategory {
  switch (kind) {
    case "output":
    case "behavior":
      return "answer";
    case "tool_call":
      return "tool_call";
    case "action":
      return "action";
    case "budget":
      return "budget";
    case "spec_validity":
    case "policy":
    case "escalation":
      return "setup";
    default:
      return "deploy";
  }
}

export function mapCheckKindToMethod(
  kind: MaintenanceCheckResult["kind"],
): CheckMethod {
  if (kind === "budget") return "budget";
  if (kind === "spec_validity") return "schema";
  if (kind === "behavior") return "semantic";
  return "deterministic";
}

export function budgetReasonToRemediation(reasonCode: string): string[] {
  switch (reasonCode) {
    case "invalid_monthly_budget_state":
    case "invalid_run_spend_state":
    case "invalid_credits_state":
      return [REMEDIATION_BUDGET_STATE];
    case "missing_pricing":
      return [REMEDIATION_PRICING_CONFIG];
    case "unknown_plan_entitlement":
      return ["Use a known planId with configured entitlements."];
    case "credits_exhausted":
      return ["Add credits or reduce routed provider calls for this period."];
    case "monthly_budget_exceeded":
      return ["Raise the monthly routed-call budget in your eval spec or reduce call volume."];
    case "per_run_budget_exceeded":
      return ["Reduce per-run routed-call spend or raise perRunBudgetLimitUsd in the spec."];
    case "provider_not_allowed":
      return ["Route calls through an allowed provider or update allowedProviders in the spec."];
    case "model_not_allowed":
      return ["Use an allowed model or update allowedModels in the spec."];
    case "subscription_inactive":
      return ["Activate subscription before routing provider calls through the gate."];
    case "ledger_write_failed":
      return [REMEDIATION_LEDGER_WRITE];
    default:
      return ["Review routed-call budget gate configuration and retry."];
  }
}

export function buildAgentQaSummary(input: {
  checks: AgentQaCheckResult[];
  evidenceCompleteness: EvidenceCompleteness;
  enforcementMode: EnforcementMode;
  decisionReason: string;
  remediation: string[];
  wouldBlockCount: number;
}): AgentQaSummary {
  const gateContributions: GateDecision[] = [];
  let requiresHumanReview = false;

  for (const c of input.checks) {
    const g = enforcementOutcomeToGateContribution(
      c.enforcementOutcome,
      input.enforcementMode,
    );
    if (g) gateContributions.push(g);
    if (c.enforcementOutcome === "manual_review") requiresHumanReview = true;
  }

  if (
    !input.evidenceCompleteness.budgetStateLoaded &&
    input.enforcementMode !== "observe"
  ) {
    gateContributions.push("block");
  }
  if (
    input.evidenceCompleteness.ledgerWriteSucceeded === false &&
    input.enforcementMode !== "observe"
  ) {
    gateContributions.push("block");
  }

  const gateDecision = mergeGateDecisions(gateContributions);

  let confidence: AgentQaDecision["confidence"] = "high";
  const semanticFailures = input.checks.filter(
    (c) =>
      c.checkMethod === "semantic" &&
      c.enforcementOutcome !== "passed",
  );
  const lowConfidence = input.checks.filter((c) => c.confidence === "low");
  if (semanticFailures.length > 0 || lowConfidence.length > 0) {
    confidence = semanticFailures.length > 0 ? "low" : "medium";
  } else if (
    input.checks.some((c) => c.enforcementOutcome === "manual_review")
  ) {
    confidence = "medium";
  }

  if (gateDecision === "manual_review") requiresHumanReview = true;

  const answerChecks = input.checks.filter((c) => c.checkCategory === "answer");
  const toolChecks = input.checks.filter((c) => c.checkCategory === "tool_call");
  const actionChecks = input.checks.filter((c) => c.checkCategory === "action");
  const budgetChecks = input.checks.filter((c) => c.checkCategory === "budget");

  return {
    gateDecision,
    enforcementMode: input.enforcementMode,
    decisionReason: input.decisionReason,
    confidence,
    requiresHumanReview,
    remediation: [...new Set(input.remediation)],
    evidenceCompleteness: input.evidenceCompleteness,
    wouldBlockCount: input.wouldBlockCount,
    checkCounts: {
      answer: {
        total: answerChecks.length,
        passed: answerChecks.filter((c) => c.enforcementOutcome === "passed")
          .length,
        failed: answerChecks.filter((c) => c.enforcementOutcome !== "passed")
          .length,
      },
      tool_call: {
        total: toolChecks.length,
        passed: toolChecks.filter((c) => c.enforcementOutcome === "passed")
          .length,
        failed: toolChecks.filter((c) => c.enforcementOutcome !== "passed")
          .length,
      },
      action: {
        total: actionChecks.length,
        passed: actionChecks.filter((c) => c.enforcementOutcome === "passed")
          .length,
        failed: actionChecks.filter((c) => c.enforcementOutcome !== "passed")
          .length,
      },
      budget: {
        total: budgetChecks.length,
        passed: budgetChecks.filter((c) => c.enforcementOutcome === "passed")
          .length,
        failed: budgetChecks.filter((c) => c.enforcementOutcome !== "passed")
          .length,
      },
    },
  };
}

export function resolveCheckEnforcement(input: {
  passed: boolean;
  severity: EvalSeverity;
  enforcementMode: EnforcementMode;
  forceManualReview?: boolean;
  forceBlock?: boolean;
  lowConfidence?: boolean;
}): {
  enforcementOutcome: EnforcementOutcome;
  confidence: "high" | "medium" | "low";
  wouldHaveBlocked: boolean;
} {
  if (input.passed) {
    return {
      enforcementOutcome: "passed",
      confidence: "high",
      wouldHaveBlocked: false,
    };
  }

  const wouldHaveBlocked =
    input.severity === "blocking" || Boolean(input.forceBlock);

  if (input.forceManualReview || input.lowConfidence) {
    const outcome: EnforcementOutcome =
      input.enforcementMode === "observe"
        ? "warning"
        : input.lowConfidence
          ? "manual_review"
          : severityToDefaultOutcome(input.severity, "enforce") === "blocked"
            ? "manual_review"
            : "manual_review";
    return {
      enforcementOutcome: outcome,
      confidence: input.lowConfidence ? "low" : "medium",
      wouldHaveBlocked,
    };
  }

  if (input.enforcementMode === "observe") {
    return {
      enforcementOutcome: "warning",
      confidence: "high",
      wouldHaveBlocked,
    };
  }

  if (input.enforcementMode === "warn") {
    const outcome =
      input.severity === "blocking" ? "manual_review" : "warning";
    return {
      enforcementOutcome: outcome,
      confidence: "medium",
      wouldHaveBlocked,
    };
  }

  const outcome = severityToDefaultOutcome(input.severity, input.enforcementMode);
  return {
    enforcementOutcome: outcome,
    confidence: outcome === "manual_review" ? "medium" : "high",
    wouldHaveBlocked,
  };
}

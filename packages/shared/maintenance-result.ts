import type { EvalEnvironment, EvalSeverity } from "./eval-spec";

export type MaintenanceRunStatus =
  | "healthy"
  | "at_risk"
  | "failed"
  | "misconfigured";

export type ProductionHealthStatus =
  | "healthy"
  | "at_risk"
  | "degraded"
  | "unknown";

/** Agent QA gate decision — manual_review is never treated as pass. */
export type GateDecision = "pass" | "block" | "manual_review";

export type EnforcementMode = "observe" | "warn" | "enforce";

export type ConfidenceLevel = "high" | "medium" | "low";

export type CheckCategory =
  | "answer"
  | "tool_call"
  | "action"
  | "budget"
  | "deploy"
  | "setup";

export type CheckMethod =
  | "deterministic"
  | "schema"
  | "semantic"
  | "budget";

export type EnforcementOutcome =
  | "passed"
  | "blocked"
  | "manual_review"
  | "warning";

export interface EvidenceCompleteness {
  outputCaptured: boolean;
  toolTraceCaptured: boolean;
  actionTraceCaptured: boolean;
  budgetStateLoaded: boolean;
  pricingConfigLoaded: boolean;
  ledgerWriteSucceeded: boolean;
}

export interface AgentQaDecision {
  gateDecision: GateDecision;
  enforcementMode: EnforcementMode;
  decisionReason: string;
  confidence: ConfidenceLevel;
  requiresHumanReview: boolean;
  remediation: string[];
}

export interface AgentQaCategoryCounts {
  total: number;
  passed: number;
  failed: number;
}

export interface AgentQaSummary extends AgentQaDecision {
  evidenceCompleteness: EvidenceCompleteness;
  wouldBlockCount: number;
  checkCounts: {
    answer: AgentQaCategoryCounts;
    tool_call: AgentQaCategoryCounts;
    action: AgentQaCategoryCounts;
    budget: AgentQaCategoryCounts;
  };
}

export interface AgentQaCheckResult {
  id: string;
  name: string;
  checkCategory: CheckCategory;
  checkMethod: CheckMethod;
  enforcementOutcome: EnforcementOutcome;
  expected?: string;
  observed?: string;
  evidenceSummary?: string;
  missingEvidence: string[];
  remediation: string[];
  severity: EvalSeverity;
  testCaseId?: string;
  confidence?: ConfidenceLevel;
  /** Present in observe mode when a blocking check would have blocked under enforce. */
  wouldHaveBlocked?: boolean;
}

export interface MaintenanceRunInput {
  runId: string;
  specId: string;
  specVersion: number;
  workflowName: string;
  environment: EvalEnvironment;
  triggeredBy: "schedule" | "manual" | "webhook" | "ci";
  /** ISO timestamp */
  startedAt: string;
}

export interface RecommendedAction {
  id: string;
  title: string;
  detail: string;
  priority: "low" | "medium" | "high";
}

export interface PolicyCheckResult {
  policyId: string;
  policySummary: string;
  passed: boolean;
  severity: EvalSeverity;
  evidence?: string[];
}

export interface ToolCallCheckResult {
  testCaseId: string;
  toolName: string;
  required: boolean;
  observed: boolean;
  passed: boolean;
  severity: EvalSeverity;
  /** wrong_tool | missing | no_trace | present */
  outcome?: "present" | "missing" | "wrong_tool" | "no_trace";
  wrongToolObserved?: string;
}

export interface ActionCheckResult {
  testCaseId: string;
  action: string;
  forbidden: boolean;
  observed: boolean;
  passed: boolean;
  severity: EvalSeverity;
  source?: "action_trace" | "tool_trace";
}

export interface BudgetCheckResult {
  passed: boolean;
  routedCallAllowed: boolean;
  reason: string;
  reasonCode?: string;
  gateDecision?: GateDecision;
  enforcementOutcome?: EnforcementOutcome;
  remediation?: string[];
  estimatedCostUsd: number;
  monthlyBudgetRemainingUsd?: number;
  perRunBudgetRemainingUsd?: number;
}

export interface DriftOrRegressionResult {
  id: string;
  description: string;
  detected: boolean;
  severity: EvalSeverity;
  detail?: string;
}

export interface MaintenanceCheckResult {
  id: string;
  name: string;
  kind:
    | "policy"
    | "tool_call"
    | "action"
    | "output"
    | "behavior"
    | "budget"
    | "spec_validity"
    | "escalation"
    | "evidence"
    | "ledger";
  passed: boolean;
  severity: EvalSeverity;
  message: string;
  testCaseId?: string;
  checkCategory?: CheckCategory;
  checkMethod?: CheckMethod;
  enforcementOutcome?: EnforcementOutcome;
  expected?: string;
  observed?: string;
  evidenceSummary?: string;
  missingEvidence?: string[];
  remediation?: string[];
}

export interface BudgetGateSummary {
  monthlyBudgetLimitUsd: number;
  perRunBudgetLimitUsd?: number;
  monthlySpendUsdAfterRun: number;
  routedCallsAttempted: number;
  routedCallsBlocked: number;
  failClosed: boolean;
}

export interface MaintenanceRunResult {
  runId: string;
  specId: string;
  specVersion: number;
  workflowName: string;
  environment: EvalEnvironment;
  status: MaintenanceRunStatus;
  productionHealthStatus: ProductionHealthStatus;
  checksRun: number;
  checksPassed: number;
  checksFailed: number;
  blockingFailures: number;
  warnings: number;
  evidence: string[];
  budgetGateSummary?: BudgetGateSummary;
  policyResults?: PolicyCheckResult[];
  toolCallResults?: ToolCallCheckResult[];
  actionResults?: ActionCheckResult[];
  budgetResults?: BudgetCheckResult[];
  driftOrRegression?: DriftOrRegressionResult[];
  checks: MaintenanceCheckResult[];
  recommendedActions: RecommendedAction[];
  agentQa?: AgentQaSummary;
  agentQaChecks?: AgentQaCheckResult[];
  /** ISO timestamp */
  generatedAt: string;
}

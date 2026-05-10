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
}

export interface ActionCheckResult {
  testCaseId: string;
  action: string;
  forbidden: boolean;
  observed: boolean;
  passed: boolean;
  severity: EvalSeverity;
}

export interface BudgetCheckResult {
  passed: boolean;
  routedCallAllowed: boolean;
  reason: string;
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
    | "escalation";
  passed: boolean;
  severity: EvalSeverity;
  message: string;
  testCaseId?: string;
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
  /** ISO timestamp */
  generatedAt: string;
}

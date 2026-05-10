import {
  assertProviderCallAllowed,
  type AssertProviderCallAllowedInput,
} from "./budget-gate";
import type { EvalSpec, EvalSpecTestCase } from "./eval-spec";
import { validateEvalSpec } from "./eval-spec";
import type {
  ActionCheckResult,
  BudgetCheckResult,
  BudgetGateSummary,
  MaintenanceCheckResult,
  MaintenanceRunResult,
  MaintenanceRunStatus,
  PolicyCheckResult,
  ProductionHealthStatus,
  RecommendedAction,
  ToolCallCheckResult,
} from "./maintenance-result";

export interface SimulatedCaseObservation {
  output: string;
  toolCalls: string[];
  actions: string[];
}

export interface RoutedProviderCallAttempt {
  callId: string;
  planId: string;
  subscriptionActive?: boolean;
  creditsRemaining: number;
  monthlyBudgetRemainingUsd: number;
  currentRunSpendUsd: number;
  estimatedCreditsRequired: number;
  estimatedCostUsd: number;
  provider: string;
  model: string;
  pricingKnown?: boolean;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

export interface RunMaintenanceCheckInput {
  runId: string;
  spec: EvalSpec;
  /** Per test-case id: simulated model output and traces */
  observations: Record<string, SimulatedCaseObservation>;
  /** Single routed call attempt for this maintenance run (optional). */
  routedCall?: RoutedProviderCallAttempt;
  generatedAt: string;
}

function normalizeText(s: string): string {
  return s.trim().toLowerCase();
}

function behaviorMatches(observed: string, expectedBehavior: string): boolean {
  const o = normalizeText(observed);
  const key = normalizeText(expectedBehavior);
  if (!key.length) return true;
  return o.includes(key) || key.split(/\s+/).every((w) => w.length > 1 && o.includes(w));
}

export function runMaintenanceCheck(
  input: RunMaintenanceCheckInput,
): MaintenanceRunResult {
  const spec = input.spec;
  const checks: MaintenanceCheckResult[] = [];
  const policyResults: PolicyCheckResult[] = [];
  const toolCallResults: ToolCallCheckResult[] = [];
  const actionResults: ActionCheckResult[] = [];
  const budgetResults: BudgetCheckResult[] = [];
  const evidence: string[] = [];
  const recommendedActions: RecommendedAction[] = [];

  const validation = validateEvalSpec(spec);
  if (!validation.ok) {
    for (const i of validation.issues) {
      checks.push({
        id: `spec:${i.path}`,
        name: "Spec validity",
        kind: "spec_validity",
        passed: false,
        severity: "blocking",
        message: `${i.code}: ${i.message}`,
      });
      evidence.push(`spec_invalid:${i.path}`);
    }
    return finalizeResult({
      input,
      status: "misconfigured",
      productionHealthStatus: "unknown",
      checks,
      policyResults,
      toolCallResults,
      actionResults,
      budgetResults,
      evidence,
      recommendedActions,
      budgetGateSummary: undefined,
    });
  }

  let misconfigured = false;

  if (spec.policies && spec.policies.length > 0) {
    spec.policies.forEach((p, idx) => {
      const passed = true;
      policyResults.push({
        policyId: `policy-${idx}`,
        policySummary: p,
        passed,
        severity: "info",
      });
      checks.push({
        id: `policy-${idx}`,
        name: `Policy acknowledged: ${p.slice(0, 80)}`,
        kind: "policy",
        passed,
        severity: "info",
        message: "Policy recorded in spec; customer is source of truth.",
      });
    });
  }

  const allToolCalls = new Set<string>();
  const allActions = new Set<string>();
  for (const tc of spec.testCases) {
    const obs = input.observations[tc.id];
    if (!obs) {
      checks.push({
        id: `missing_obs:${tc.id}`,
        name: tc.name,
        kind: "behavior",
        passed: false,
        severity: tc.severity,
        message: `No observation provided for test case ${tc.id}`,
        testCaseId: tc.id,
      });
      evidence.push(`missing_observation:${tc.id}`);
      continue;
    }
    obs.toolCalls.forEach((t) => allToolCalls.add(t));
    obs.actions.forEach((a) => allActions.add(a));

    if (tc.expectedOutput !== undefined) {
      const ok =
        normalizeText(obs.output) === normalizeText(tc.expectedOutput) ||
        obs.output.includes(tc.expectedOutput);
      checks.push({
        id: `output:${tc.id}`,
        name: `Expected output (${tc.name})`,
        kind: "output",
        passed: ok,
        severity: tc.severity,
        message: ok
          ? "Output matches spec-defined expectation."
          : "Output does not match spec-defined expectedOutput.",
        testCaseId: tc.id,
      });
      if (!ok) evidence.push(`output_mismatch:${tc.id}`);
    }

    const behOk = behaviorMatches(obs.output, tc.expectedBehavior);
    checks.push({
      id: `behavior:${tc.id}`,
      name: `Expected behavior (${tc.name})`,
      kind: "behavior",
      passed: behOk,
      severity: tc.severity,
      message: behOk
        ? "Observed output reflects spec-defined expected behavior."
        : "Observed output does not reflect spec-defined expected behavior.",
      testCaseId: tc.id,
    });
    if (!behOk) evidence.push(`behavior_mismatch:${tc.id}`);

    for (const tool of tc.requiredToolCalls ?? []) {
      const observed = obs.toolCalls.includes(tool);
      toolCallResults.push({
        testCaseId: tc.id,
        toolName: tool,
        required: true,
        observed,
        passed: observed,
        severity: tc.severity,
      });
      checks.push({
        id: `tool:${tc.id}:${tool}`,
        name: `Required tool ${tool}`,
        kind: "tool_call",
        passed: observed,
        severity: tc.severity,
        message: observed
          ? `Tool ${tool} present in routed trace.`
          : `Required tool ${tool} missing from routed trace.`,
        testCaseId: tc.id,
      });
      if (!observed) evidence.push(`missing_tool:${tc.id}:${tool}`);
    }

    for (const act of tc.forbiddenActions ?? []) {
      const observed = obs.actions.includes(act);
      actionResults.push({
        testCaseId: tc.id,
        action: act,
        forbidden: true,
        observed,
        passed: !observed,
        severity: tc.severity,
      });
      checks.push({
        id: `action:${tc.id}:${act}`,
        name: `Forbidden action ${act}`,
        kind: "action",
        passed: !observed,
        severity: tc.severity,
        message: observed
          ? `Forbidden action ${act} observed in trace.`
          : `Forbidden action ${act} not observed.`,
        testCaseId: tc.id,
      });
      if (observed) evidence.push(`forbidden_action:${tc.id}:${act}`);
    }

    for (const ev of tc.requiredEvidence ?? []) {
      const ok = obs.output.includes(ev) || obs.toolCalls.some((t) => t.includes(ev));
      checks.push({
        id: `evidence:${tc.id}:${ev}`,
        name: `Required evidence ${ev}`,
        kind: "behavior",
        passed: ok,
        severity: tc.severity,
        message: ok ? "Evidence present." : "Required evidence not found.",
        testCaseId: tc.id,
      });
      if (!ok) evidence.push(`missing_evidence:${tc.id}`);
    }
  }

  for (const tool of spec.requiredToolCalls ?? []) {
    const observed = allToolCalls.has(tool);
    toolCallResults.push({
      testCaseId: "_spec",
      toolName: tool,
      required: true,
      observed,
      passed: observed,
      severity: "blocking",
    });
    checks.push({
      id: `spec_tool:${tool}`,
      name: `Spec-level required tool ${tool}`,
      kind: "tool_call",
      passed: observed,
      severity: "blocking",
      message: observed
        ? `Tool ${tool} present in maintenance trace.`
        : `Spec-level required tool ${tool} missing.`,
    });
    if (!observed) evidence.push(`spec_missing_tool:${tool}`);
  }

  for (const act of spec.forbiddenActions ?? []) {
    const observed = allActions.has(act);
    actionResults.push({
      testCaseId: "_spec",
      action: act,
      forbidden: true,
      observed,
      passed: !observed,
      severity: "blocking",
    });
    checks.push({
      id: `spec_action:${act}`,
      name: `Spec-level forbidden action ${act}`,
      kind: "action",
      passed: !observed,
      severity: "blocking",
      message: observed
        ? `Forbidden action ${act} observed.`
        : `Forbidden action ${act} not observed.`,
    });
    if (observed) evidence.push(`spec_forbidden_action:${act}`);
  }

  if (spec.escalationRules && spec.escalationRules.length > 0) {
    spec.escalationRules.forEach((rule, idx) => {
      checks.push({
        id: `escalation:${idx}`,
        name: `Escalation rule recorded`,
        kind: "escalation",
        passed: true,
        severity: "info",
        message: rule,
      });
    });
  }

  let budgetGateSummary: BudgetGateSummary | undefined;
  if (input.routedCall) {
    const rc = input.routedCall;
    const gateInput: AssertProviderCallAllowedInput = {
      planId: rc.planId,
      subscriptionActive: rc.subscriptionActive,
      creditsRemaining: rc.creditsRemaining,
      monthlyBudgetRemainingUsd: rc.monthlyBudgetRemainingUsd,
      currentRunSpendUsd: rc.currentRunSpendUsd,
      estimatedCreditsRequired: rc.estimatedCreditsRequired,
      estimatedCostUsd: rc.estimatedCostUsd,
      provider: rc.provider,
      model: rc.model,
      budgetGate: spec.budgetGate,
      pricingKnown: rc.pricingKnown,
    };
    const gate = assertProviderCallAllowed(gateInput);
    const allowed = gate.decision === "allowed";
    if (gate.decision === "misconfigured") misconfigured = true;
    const b: BudgetCheckResult = {
      passed: allowed,
      routedCallAllowed: allowed,
      reason: gate.reason,
      estimatedCostUsd: rc.estimatedCostUsd,
      monthlyBudgetRemainingUsd: rc.monthlyBudgetRemainingUsd,
      perRunBudgetRemainingUsd: spec.budgetGate.perRunBudgetLimitUsd,
    };
    budgetResults.push(b);
    checks.push({
      id: "budget:routed_call",
      name: "Routed provider call budget gate",
      kind: "budget",
      passed: allowed,
      severity: gate.decision === "misconfigured" ? "blocking" : "blocking",
      message: gate.reason,
    });
    if (!allowed) evidence.push(`budget_gate:${gate.reason}`);

    budgetGateSummary = {
      monthlyBudgetLimitUsd: spec.budgetGate.monthlyBudgetLimitUsd,
      perRunBudgetLimitUsd: spec.budgetGate.perRunBudgetLimitUsd,
      monthlySpendUsdAfterRun: allowed
        ? spec.budgetGate.monthlyBudgetLimitUsd - rc.monthlyBudgetRemainingUsd + rc.estimatedCostUsd
        : spec.budgetGate.monthlyBudgetLimitUsd - rc.monthlyBudgetRemainingUsd,
      routedCallsAttempted: 1,
      routedCallsBlocked: allowed ? 0 : 1,
      failClosed: spec.budgetGate.failClosed,
    };
  }

  const blockingFailed = checks.filter((c) => !c.passed && c.severity === "blocking").length;
  const warningFailed = checks.filter((c) => !c.passed && c.severity === "warning").length;
  const infoFailed = checks.filter((c) => !c.passed && c.severity === "info").length;

  let status: MaintenanceRunStatus;
  let productionHealthStatus: ProductionHealthStatus;

  if (misconfigured) {
    status = "misconfigured";
    productionHealthStatus = "unknown";
    recommendedActions.push({
      id: "fix-config",
      title: "Correct maintenance configuration",
      detail: "Resolve spec validity, budget state, or pricing signals flagged as misconfigured.",
      priority: "high",
    });
  } else if (blockingFailed > 0) {
    status = "failed";
    productionHealthStatus = "degraded";
    recommendedActions.push({
      id: "remediate-blocking",
      title: "Remediate blocking maintenance findings",
      detail: "Address policy, tool, action, or output checks marked blocking before treating production as healthy.",
      priority: "high",
    });
  } else if (warningFailed > 0 || infoFailed > 0) {
    status = "at_risk";
    productionHealthStatus = "at_risk";
    recommendedActions.push({
      id: "review-warnings",
      title: "Review warnings",
      detail: "Non-blocking findings should be triaged on the maintenance dashboard.",
      priority: "medium",
    });
  } else {
    status = "healthy";
    productionHealthStatus = "healthy";
  }

  return finalizeResult({
    input,
    status,
    productionHealthStatus,
    checks,
    policyResults,
    toolCallResults,
    actionResults,
    budgetResults,
    evidence,
    recommendedActions,
    budgetGateSummary,
  });
}

function finalizeResult(input: {
  input: RunMaintenanceCheckInput;
  status: MaintenanceRunStatus;
  productionHealthStatus: ProductionHealthStatus;
  checks: MaintenanceCheckResult[];
  policyResults: PolicyCheckResult[];
  toolCallResults: ToolCallCheckResult[];
  actionResults: ActionCheckResult[];
  budgetResults: BudgetCheckResult[];
  evidence: string[];
  recommendedActions: RecommendedAction[];
  budgetGateSummary: BudgetGateSummary | undefined;
}): MaintenanceRunResult {
  const { checks } = input;
  const checksRun = checks.length;
  const checksPassed = checks.filter((c) => c.passed).length;
  const checksFailed = checksRun - checksPassed;
  const blockingFailures = checks.filter((c) => !c.passed && c.severity === "blocking").length;
  const warnings = checks.filter((c) => !c.passed && c.severity === "warning").length;

  return {
    runId: input.input.runId,
    specId: input.input.spec.specId,
    specVersion: input.input.spec.version,
    workflowName: input.input.spec.workflowName,
    environment: input.input.spec.environment,
    status: input.status,
    productionHealthStatus: input.productionHealthStatus,
    checksRun,
    checksPassed,
    checksFailed,
    blockingFailures,
    warnings,
    evidence: input.evidence,
    budgetGateSummary: input.budgetGateSummary,
    policyResults: input.policyResults,
    toolCallResults: input.toolCallResults,
    actionResults: input.actionResults,
    budgetResults: input.budgetResults,
    driftOrRegression: [],
    checks,
    recommendedActions: input.recommendedActions,
    generatedAt: input.input.generatedAt,
  };
}

/** Export for tests: evaluate single test case observation */
export function evaluateTestCase(
  tc: EvalSpecTestCase,
  obs: SimulatedCaseObservation,
): { outputOk: boolean; behaviorOk: boolean; toolsOk: boolean; actionsOk: boolean } {
  const outputOk =
    tc.expectedOutput === undefined ||
    normalizeText(obs.output) === normalizeText(tc.expectedOutput) ||
    obs.output.includes(tc.expectedOutput);
  const behaviorOk = behaviorMatches(obs.output, tc.expectedBehavior);
  const toolsOk = (tc.requiredToolCalls ?? []).every((t) => obs.toolCalls.includes(t));
  const actionsOk = (tc.forbiddenActions ?? []).every((a) => !obs.actions.includes(a));
  return { outputOk, behaviorOk, toolsOk, actionsOk };
}

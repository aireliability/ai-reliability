import {
  buildAgentQaSummary,
  isPassingGateDecision,
  mapCheckKindToCategory,
  mapCheckKindToMethod,
  REMEDIATION_LEDGER_WRITE,
  REMEDIATION_OUTPUT_EVIDENCE,
  REMEDIATION_TOOL_TRACE,
  resolveCheckEnforcement,
} from "./agent-qa";
import {
  assertProviderCallAllowed,
  type AssertProviderCallAllowedInput,
} from "./budget-gate";
import type { EvalSpec, EvalSpecTestCase } from "./eval-spec";
import { validateEvalSpec } from "./eval-spec";
import type {
  ActionCheckResult,
  AgentQaCheckResult,
  AgentQaSummary,
  BudgetCheckResult,
  BudgetGateSummary,
  EnforcementMode,
  EvidenceCompleteness,
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
  /** Omit when no tool trace was captured for this step. */
  toolCalls?: string[];
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
  budgetStatePresent?: boolean;
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
  enforcementMode?: EnforcementMode;
  /** Override evidence flags; inferred from observations when omitted. */
  evidenceCompleteness?: Partial<EvidenceCompleteness>;
  /** When false, run fails closed on ledger persistence. */
  ledgerWriteSucceeded?: boolean;
  generatedAt: string;
}

function normalizeText(s: string): string {
  return s.trim().toLowerCase();
}

function behaviorMatches(observed: string, expectedBehavior: string): boolean {
  const o = normalizeText(observed);
  const key = normalizeText(expectedBehavior);
  if (!key.length) return true;
  return (
    o.includes(key) ||
    key.split(/\s+/).every((w) => w.length > 1 && o.includes(w))
  );
}

const KNOWN_FORBIDDEN_ACTIONS = new Set([
  "issue_refund",
  "cancel_subscription",
  "apply_discount",
  "delete_record",
  "send_customer_message",
  "approve_request",
  "invent_plan_price",
]);

function collectObservedActions(obs: SimulatedCaseObservation): string[] {
  const fromTools = (obs.toolCalls ?? []).filter((t) =>
    KNOWN_FORBIDDEN_ACTIONS.has(t),
  );
  return [...new Set([...obs.actions, ...fromTools])];
}

function inferEvidenceCompleteness(
  input: RunMaintenanceCheckInput,
): EvidenceCompleteness {
  const obsValues = Object.values(input.observations);
  const outputCaptured =
    input.evidenceCompleteness?.outputCaptured ??
    obsValues.every((o) => typeof o.output === "string" && o.output.length > 0);
  const toolTraceCaptured =
    input.evidenceCompleteness?.toolTraceCaptured ??
    obsValues.every((o) => o.toolCalls !== undefined);
  const actionTraceCaptured =
    input.evidenceCompleteness?.actionTraceCaptured ??
    obsValues.every((o) => Array.isArray(o.actions));
  const budgetStateLoaded =
    input.evidenceCompleteness?.budgetStateLoaded ??
    (input.routedCall === undefined
      ? true
      : input.routedCall.budgetStatePresent !== false);
  const pricingConfigLoaded =
    input.evidenceCompleteness?.pricingConfigLoaded ??
    (input.routedCall === undefined
      ? true
      : input.routedCall.pricingKnown !== false);
  const ledgerWriteSucceeded =
    input.evidenceCompleteness?.ledgerWriteSucceeded ??
    input.ledgerWriteSucceeded ??
    true;

  return {
    outputCaptured,
    toolTraceCaptured,
    actionTraceCaptured,
    budgetStateLoaded,
    pricingConfigLoaded,
    ledgerWriteSucceeded,
  };
}

function toAgentQaCheck(
  check: MaintenanceCheckResult,
  enforcementMode: EnforcementMode,
  extra?: Partial<AgentQaCheckResult>,
): AgentQaCheckResult {
  const category =
    check.checkCategory ?? mapCheckKindToCategory(check.kind);
  const method = check.checkMethod ?? mapCheckKindToMethod(check.kind);
  const resolved = resolveCheckEnforcement({
    passed: check.passed,
    severity: check.severity,
    enforcementMode,
    forceManualReview: check.enforcementOutcome === "manual_review",
    forceBlock: check.enforcementOutcome === "blocked",
    lowConfidence: method === "semantic" && !check.passed,
  });
  const enforcementOutcome =
    check.enforcementOutcome ?? resolved.enforcementOutcome;

  const remediation =
    check.remediation && check.remediation.length > 0
      ? check.remediation
      : !check.passed
        ? category === "tool_call"
          ? [REMEDIATION_TOOL_TRACE]
          : category === "answer"
            ? [REMEDIATION_OUTPUT_EVIDENCE]
            : []
        : [];

  return {
    id: check.id,
    name: check.name,
    checkCategory: category,
    checkMethod: method,
    enforcementOutcome,
    confidence: resolved.confidence,
    expected: check.expected,
    observed: check.observed,
    evidenceSummary: check.evidenceSummary,
    missingEvidence: check.missingEvidence ?? [],
    remediation,
    severity: check.severity,
    testCaseId: check.testCaseId,
    wouldHaveBlocked: resolved.wouldHaveBlocked,
    ...extra,
  };
}

export function runMaintenanceCheck(
  input: RunMaintenanceCheckInput,
): MaintenanceRunResult {
  const enforcementMode = input.enforcementMode ?? "enforce";
  const evidenceCompleteness = inferEvidenceCompleteness(input);
  const spec = input.spec;
  const checks: MaintenanceCheckResult[] = [];
  const agentQaChecks: AgentQaCheckResult[] = [];
  const policyResults: PolicyCheckResult[] = [];
  const toolCallResults: ToolCallCheckResult[] = [];
  const actionResults: ActionCheckResult[] = [];
  const budgetResults: BudgetCheckResult[] = [];
  const evidence: string[] = [];
  const recommendedActions: RecommendedAction[] = [];
  const runRemediation: string[] = [];

  const pushCheck = (check: MaintenanceCheckResult) => {
    checks.push(check);
    agentQaChecks.push(toAgentQaCheck(check, enforcementMode));
  };

  const validation = validateEvalSpec(spec);
  if (!validation.ok) {
    for (const i of validation.issues) {
      pushCheck({
        id: `spec:${i.path}`,
        name: "Spec validity",
        kind: "spec_validity",
        passed: false,
        severity: "blocking",
        message: `${i.code}: ${i.message}`,
        checkCategory: "setup",
        checkMethod: "schema",
        enforcementOutcome: "blocked",
        remediation: ["Fix eval spec validation issues before running Agent QA."],
      });
      evidence.push(`spec_invalid:${i.path}`);
    }
    return finalizeResult({
      input,
      enforcementMode,
      evidenceCompleteness,
      status: "misconfigured",
      productionHealthStatus: "unknown",
      checks,
      agentQaChecks,
      policyResults,
      toolCallResults,
      actionResults,
      budgetResults,
      evidence,
      recommendedActions,
      runRemediation,
      budgetGateSummary: undefined,
    });
  }

  let misconfigured = false;

  if (spec.policies && spec.policies.length > 0) {
    spec.policies.forEach((p, idx) => {
      policyResults.push({
        policyId: `policy-${idx}`,
        policySummary: p,
        passed: true,
        severity: "info",
      });
      pushCheck({
        id: `policy-${idx}`,
        name: `Policy acknowledged: ${p.slice(0, 80)}`,
        kind: "policy",
        passed: true,
        severity: "info",
        message: "Policy recorded in spec; customer is source of truth.",
        checkCategory: "setup",
        checkMethod: "deterministic",
        enforcementOutcome: "passed",
      });
    });
  }

  const allToolCalls = new Set<string>();
  const allActions = new Set<string>();

  for (const tc of spec.testCases) {
    const obs = input.observations[tc.id];
    if (!obs) {
      pushCheck({
        id: `missing_obs:${tc.id}`,
        name: tc.name,
        kind: "evidence",
        passed: false,
        severity: tc.severity,
        message: `No observation provided for test case ${tc.id}`,
        testCaseId: tc.id,
        checkCategory: "answer",
        checkMethod: "deterministic",
        enforcementOutcome:
          enforcementMode === "observe" ? "warning" : "manual_review",
        missingEvidence: ["observation"],
        remediation: [REMEDIATION_OUTPUT_EVIDENCE],
        evidenceSummary: "No observation artifact for this test case.",
      });
      evidence.push(`missing_observation:${tc.id}`);
      continue;
    }

    if (!evidenceCompleteness.outputCaptured || !obs.output?.trim()) {
      pushCheck({
        id: `output_evidence:${tc.id}`,
        name: `Output evidence (${tc.name})`,
        kind: "evidence",
        passed: false,
        severity: tc.severity,
        message: "Agent output was not captured for this step.",
        testCaseId: tc.id,
        checkCategory: "answer",
        checkMethod: "deterministic",
        enforcementOutcome:
          enforcementMode === "enforce" && tc.severity === "blocking"
            ? "blocked"
            : "manual_review",
        missingEvidence: ["output"],
        remediation: [REMEDIATION_OUTPUT_EVIDENCE],
      });
      evidence.push(`missing_output_evidence:${tc.id}`);
    }

    const observedActions = collectObservedActions(obs);
    (obs.toolCalls ?? []).forEach((t) => allToolCalls.add(t));
    observedActions.forEach((a) => allActions.add(a));

    const toolTraceMissing = obs.toolCalls === undefined;
    const hasRequiredTools = (tc.requiredToolCalls ?? []).length > 0;

    if (toolTraceMissing && hasRequiredTools) {
      toolCallResults.push({
        testCaseId: tc.id,
        toolName: tc.requiredToolCalls![0]!,
        required: true,
        observed: false,
        passed: false,
        severity: tc.severity,
        outcome: "no_trace",
      });
      pushCheck({
        id: `tool_trace:${tc.id}`,
        name: `Tool trace (${tc.name})`,
        kind: "tool_call",
        passed: false,
        severity: tc.severity,
        message: "No tool trace captured for a step that requires tool verification.",
        testCaseId: tc.id,
        checkCategory: "tool_call",
        checkMethod: "deterministic",
        enforcementOutcome:
          enforcementMode === "observe"
            ? "warning"
            : tc.severity === "blocking"
              ? "blocked"
              : "manual_review",
        missingEvidence: ["tool_trace"],
        remediation: [REMEDIATION_TOOL_TRACE],
        expected: (tc.requiredToolCalls ?? []).join(", "),
        observed: "(no trace)",
      });
      evidence.push(`no_tool_trace:${tc.id}`);
    } else if (!toolTraceMissing) {
      const required = tc.requiredToolCalls ?? [];
      const wrongTools = obs.toolCalls!.filter((t) => !required.includes(t));
      if (
        required.length > 0 &&
        wrongTools.length > 0 &&
        required.some((r) => !obs.toolCalls!.includes(r))
      ) {
        const wrong = wrongTools[0]!;
        toolCallResults.push({
          testCaseId: tc.id,
          toolName: required[0]!,
          required: true,
          observed: false,
          passed: false,
          severity: tc.severity,
          outcome: "wrong_tool",
          wrongToolObserved: wrong,
        });
        pushCheck({
          id: `wrong_tool:${tc.id}`,
          name: `Wrong tool observed (${tc.name})`,
          kind: "tool_call",
          passed: false,
          severity: tc.severity,
          message: `Expected tool(s) ${required.join(", ")} but observed ${wrong}.`,
          testCaseId: tc.id,
          checkCategory: "tool_call",
          checkMethod: "deterministic",
          enforcementOutcome:
            enforcementMode === "observe"
              ? "warning"
              : tc.severity === "blocking"
                ? "blocked"
                : "manual_review",
          expected: required.join(", "),
          observed: obs.toolCalls!.join(", "),
          remediation: [
            REMEDIATION_TOOL_TRACE,
            `Ensure the agent calls ${required.join(" or ")} for this step.`,
          ],
        });
        evidence.push(`wrong_tool:${tc.id}:${wrong}`);
      }

      for (const tool of required) {
        const observed = obs.toolCalls!.includes(tool);
        toolCallResults.push({
          testCaseId: tc.id,
          toolName: tool,
          required: true,
          observed,
          passed: observed,
          severity: tc.severity,
          outcome: observed ? "present" : "missing",
        });
        pushCheck({
          id: `tool:${tc.id}:${tool}`,
          name: `Required tool ${tool}`,
          kind: "tool_call",
          passed: observed,
          severity: tc.severity,
          message: observed
            ? `Tool ${tool} present in routed trace.`
            : `Required tool ${tool} missing from routed trace.`,
          testCaseId: tc.id,
          checkCategory: "tool_call",
          checkMethod: "deterministic",
          expected: tool,
          observed: observed ? tool : "(missing)",
          remediation: observed ? [] : [REMEDIATION_TOOL_TRACE],
        });
        if (!observed) evidence.push(`missing_tool:${tc.id}:${tool}`);
      }
    }

    if (tc.expectedOutput !== undefined) {
      const ok =
        evidenceCompleteness.outputCaptured &&
        (normalizeText(obs.output) === normalizeText(tc.expectedOutput) ||
          obs.output.includes(tc.expectedOutput));
      pushCheck({
        id: `output:${tc.id}`,
        name: `Expected output (${tc.name})`,
        kind: "output",
        passed: ok,
        severity: tc.severity,
        message: ok
          ? "Output matches spec-defined expectation."
          : "Output does not match spec-defined expectedOutput.",
        testCaseId: tc.id,
        checkCategory: "answer",
        checkMethod: "deterministic",
        expected: tc.expectedOutput,
        observed: obs.output,
        enforcementOutcome: ok
          ? "passed"
          : enforcementMode === "observe"
            ? "warning"
            : tc.severity === "blocking"
              ? "blocked"
              : "manual_review",
      });
      if (!ok) evidence.push(`output_mismatch:${tc.id}`);
    }

    const behOk =
      evidenceCompleteness.outputCaptured &&
      behaviorMatches(obs.output, tc.expectedBehavior);
    const behaviorOutcome = behOk
      ? "passed"
      : enforcementMode === "observe"
        ? "warning"
        : enforcementMode === "warn"
          ? "manual_review"
          : tc.severity === "blocking"
            ? "blocked"
            : "manual_review";
    pushCheck({
      id: `behavior:${tc.id}`,
      name: `Expected behavior (${tc.name})`,
      kind: "behavior",
      passed: behOk,
      severity: tc.severity,
      message: behOk
        ? "Observed output reflects spec-defined expected behavior."
        : "Observed output does not reflect spec-defined expected behavior.",
      testCaseId: tc.id,
      checkCategory: "answer",
      checkMethod: "semantic",
      expected: tc.expectedBehavior,
      observed: obs.output,
      enforcementOutcome: behaviorOutcome,
      remediation: behOk
        ? []
        : ["Review agent output against spec-defined expectedBehavior."],
    });
    if (!behOk) evidence.push(`behavior_mismatch:${tc.id}`);

    for (const act of tc.forbiddenActions ?? []) {
      const observed = observedActions.includes(act);
      const fromTool = (obs.toolCalls ?? []).includes(act);
      actionResults.push({
        testCaseId: tc.id,
        action: act,
        forbidden: true,
        observed,
        passed: !observed,
        severity: tc.severity,
        source: fromTool ? "tool_trace" : "action_trace",
      });
      pushCheck({
        id: `action:${tc.id}:${act}`,
        name: `Forbidden action ${act}`,
        kind: "action",
        passed: !observed,
        severity: tc.severity,
        message: observed
          ? `Forbidden action ${act} observed in trace.`
          : `Forbidden action ${act} not observed.`,
        testCaseId: tc.id,
        checkCategory: "action",
        checkMethod: "deterministic",
        expected: "not observed",
        observed: observed ? act : "not observed",
        enforcementOutcome: observed
          ? enforcementMode === "enforce"
            ? "blocked"
            : enforcementMode === "observe"
              ? "warning"
              : "manual_review"
          : "passed",
        remediation: observed
          ? [`Remove or block forbidden action ${act} in production agent flows.`]
          : [],
      });
      if (observed) evidence.push(`forbidden_action:${tc.id}:${act}`);
    }

    for (const ev of tc.requiredEvidence ?? []) {
      const ok =
        evidenceCompleteness.outputCaptured &&
        (obs.output.includes(ev) ||
          (obs.toolCalls ?? []).some((t) => t.includes(ev)));
      pushCheck({
        id: `evidence:${tc.id}:${ev}`,
        name: `Required evidence ${ev}`,
        kind: "evidence",
        passed: ok,
        severity: tc.severity,
        message: ok ? "Evidence present." : "Required evidence not found.",
        testCaseId: tc.id,
        checkCategory: "answer",
        checkMethod: "deterministic",
        enforcementOutcome: ok
          ? "passed"
          : enforcementMode === "observe"
            ? "warning"
            : "manual_review",
        missingEvidence: ok ? [] : [ev],
        remediation: ok ? [] : [REMEDIATION_OUTPUT_EVIDENCE, REMEDIATION_TOOL_TRACE],
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
      outcome: observed ? "present" : "missing",
    });
    pushCheck({
      id: `spec_tool:${tool}`,
      name: `Spec-level required tool ${tool}`,
      kind: "tool_call",
      passed: observed,
      severity: "blocking",
      message: observed
        ? `Tool ${tool} present in maintenance trace.`
        : `Spec-level required tool ${tool} missing.`,
      checkCategory: "tool_call",
      checkMethod: "deterministic",
      remediation: observed ? [] : [REMEDIATION_TOOL_TRACE],
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
    pushCheck({
      id: `spec_action:${act}`,
      name: `Spec-level forbidden action ${act}`,
      kind: "action",
      passed: !observed,
      severity: "blocking",
      message: observed
        ? `Forbidden action ${act} observed.`
        : `Forbidden action ${act} not observed.`,
      checkCategory: "action",
      checkMethod: "deterministic",
      enforcementOutcome: observed
        ? enforcementMode === "enforce"
          ? "blocked"
          : "warning"
        : "passed",
      remediation: observed
        ? [`Remove or block forbidden action ${act} in production agent flows.`]
        : [],
    });
    if (observed) evidence.push(`spec_forbidden_action:${act}`);
  }

  if (spec.escalationRules && spec.escalationRules.length > 0) {
    spec.escalationRules.forEach((rule, idx) => {
      pushCheck({
        id: `escalation:${idx}`,
        name: `Escalation rule recorded`,
        kind: "escalation",
        passed: true,
        severity: "info",
        message: rule,
        checkCategory: "setup",
        enforcementOutcome: "passed",
      });
    });
  }

  if (!evidenceCompleteness.ledgerWriteSucceeded) {
    pushCheck({
      id: "ledger:write",
      name: "Provider-call ledger write",
      kind: "ledger",
      passed: false,
      severity: "blocking",
      message: "Ledger write did not succeed; routed-call audit trail is incomplete.",
      checkCategory: "budget",
      checkMethod: "budget",
      enforcementOutcome: "blocked",
      remediation: [REMEDIATION_LEDGER_WRITE],
    });
    evidence.push("ledger_write_failed");
    runRemediation.push(REMEDIATION_LEDGER_WRITE);
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
      budgetStatePresent: rc.budgetStatePresent ?? evidenceCompleteness.budgetStateLoaded,
    };
    const gate = assertProviderCallAllowed(gateInput);
    const allowed = gate.decision === "allowed";
    if (gate.decision === "misconfigured") misconfigured = true;

    const budgetPassed =
      allowed &&
      evidenceCompleteness.budgetStateLoaded &&
      evidenceCompleteness.pricingConfigLoaded;

    const budgetEnforcement =
      enforcementMode === "observe" && !allowed
        ? "warning"
        : gate.enforcementOutcome;

    budgetResults.push({
      passed: budgetPassed,
      routedCallAllowed: allowed,
      reason: gate.reason,
      reasonCode: gate.reasonCode,
      gateDecision: gate.gateDecision,
      enforcementOutcome: budgetEnforcement,
      remediation: gate.remediation,
      estimatedCostUsd: rc.estimatedCostUsd,
      monthlyBudgetRemainingUsd: rc.monthlyBudgetRemainingUsd,
      perRunBudgetRemainingUsd: spec.budgetGate.perRunBudgetLimitUsd,
    });

    pushCheck({
      id: "budget:routed_call",
      name: "Routed provider call budget gate",
      kind: "budget",
      passed: budgetPassed,
      severity: "blocking",
      message: gate.reason,
      checkCategory: "budget",
      checkMethod: "budget",
      enforcementOutcome: budgetEnforcement,
      expected: "routed_call_allowed",
      observed: gate.reasonCode,
      remediation: gate.remediation,
    });
    if (!allowed) {
      evidence.push(`budget_gate:${gate.reasonCode}`);
      runRemediation.push(...gate.remediation);
    }
  }

  const wouldBlockCount = agentQaChecks.filter((c) => c.wouldHaveBlocked).length;

  const blockingFailed = checks.filter(
    (c) =>
      !c.passed &&
      (c.severity === "blocking" ||
        c.enforcementOutcome === "blocked" ||
        c.enforcementOutcome === "manual_review"),
  ).length;
  const warningFailed = checks.filter(
    (c) => !c.passed && c.severity === "warning",
  ).length;

  let status: MaintenanceRunStatus;
  let productionHealthStatus: ProductionHealthStatus;

  const agentQa = buildAgentQaSummary({
    checks: agentQaChecks,
    evidenceCompleteness,
    enforcementMode,
    decisionReason: deriveDecisionReason(agentQaChecks, evidenceCompleteness),
    remediation: [...new Set([...runRemediation, ...collectRemediation(agentQaChecks)])],
    wouldBlockCount,
  });

  if (misconfigured || !isPassingGateDecision(agentQa.gateDecision)) {
    if (misconfigured) {
      status = "misconfigured";
      productionHealthStatus = "unknown";
      recommendedActions.push({
        id: "fix-config",
        title: "Correct maintenance configuration",
        detail:
          "Resolve spec validity, budget state, pricing signals, or ledger persistence flagged as misconfigured.",
        priority: "high",
      });
    } else if (agentQa.gateDecision === "block") {
      status = enforcementMode === "observe" ? "at_risk" : "failed";
      productionHealthStatus =
        enforcementMode === "observe" ? "at_risk" : "degraded";
      recommendedActions.push({
        id: "remediate-blocking",
        title: "Remediate blocking Agent QA findings",
        detail:
          "Address answer, tool, action, or budget checks that blocked the gate under the current enforcement mode.",
        priority: "high",
      });
    } else {
      status = "at_risk";
      productionHealthStatus = "at_risk";
      recommendedActions.push({
        id: "human-review",
        title: "Complete human review",
        detail:
          "One or more checks require manual review before treating this agent run as production-ready.",
        priority: "high",
      });
    }
  } else if (warningFailed > 0 || blockingFailed > 0) {
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

  if (enforcementMode === "observe" && wouldBlockCount > 0 && status === "healthy") {
    status = "at_risk";
    productionHealthStatus = "at_risk";
  }

  return finalizeResult({
    input,
    enforcementMode,
    evidenceCompleteness,
    status,
    productionHealthStatus,
    checks,
    agentQaChecks,
    policyResults,
    toolCallResults,
    actionResults,
    budgetResults,
    evidence,
    recommendedActions,
    runRemediation,
    budgetGateSummary,
    agentQa,
  });
}

function deriveDecisionReason(
  checks: AgentQaCheckResult[],
  evidence: EvidenceCompleteness,
): string {
  if (!evidence.budgetStateLoaded) return "missing_budget_state";
  if (!evidence.pricingConfigLoaded) return "missing_pricing_config";
  if (!evidence.ledgerWriteSucceeded) return "ledger_write_failed";
  const blocked = checks.find((c) => c.enforcementOutcome === "blocked");
  if (blocked) return `${blocked.checkCategory}:${blocked.id}`;
  const review = checks.find((c) => c.enforcementOutcome === "manual_review");
  if (review) return `${review.checkCategory}:${review.id}`;
  return "all_checks_passed";
}

function collectRemediation(checks: AgentQaCheckResult[]): string[] {
  const out: string[] = [];
  for (const c of checks) {
    if (c.enforcementOutcome !== "passed") out.push(...c.remediation);
  }
  return out;
}

function finalizeResult(input: {
  input: RunMaintenanceCheckInput;
  enforcementMode: EnforcementMode;
  evidenceCompleteness: EvidenceCompleteness;
  status: MaintenanceRunStatus;
  productionHealthStatus: ProductionHealthStatus;
  checks: MaintenanceCheckResult[];
  agentQaChecks: AgentQaCheckResult[];
  policyResults: PolicyCheckResult[];
  toolCallResults: ToolCallCheckResult[];
  actionResults: ActionCheckResult[];
  budgetResults: BudgetCheckResult[];
  evidence: string[];
  recommendedActions: RecommendedAction[];
  runRemediation: string[];
  budgetGateSummary: BudgetGateSummary | undefined;
  agentQa?: AgentQaSummary;
}): MaintenanceRunResult {
  const { checks } = input;
  const checksRun = checks.length;
  const checksPassed = checks.filter((c) => c.passed).length;
  const checksFailed = checksRun - checksPassed;
  const blockingFailures = checks.filter(
    (c) =>
      !c.passed &&
      (c.severity === "blocking" || c.enforcementOutcome === "blocked"),
  ).length;
  const warnings = checks.filter(
    (c) =>
      !c.passed &&
      (c.severity === "warning" || c.enforcementOutcome === "warning"),
  ).length;

  const agentQa =
    input.agentQa ??
    buildAgentQaSummary({
      checks: input.agentQaChecks,
      evidenceCompleteness: input.evidenceCompleteness,
      enforcementMode: input.enforcementMode,
      decisionReason: deriveDecisionReason(
        input.agentQaChecks,
        input.evidenceCompleteness,
      ),
      remediation: input.runRemediation,
      wouldBlockCount: input.agentQaChecks.filter((c) => c.wouldHaveBlocked)
        .length,
    });

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
    agentQa,
    agentQaChecks: input.agentQaChecks,
    generatedAt: input.input.generatedAt,
  };
}

/** Export for tests: evaluate single test case observation */
export function evaluateTestCase(
  tc: EvalSpecTestCase,
  obs: SimulatedCaseObservation,
): {
  outputOk: boolean;
  behaviorOk: boolean;
  toolsOk: boolean;
  actionsOk: boolean;
} {
  const outputOk =
    tc.expectedOutput === undefined ||
    normalizeText(obs.output) === normalizeText(tc.expectedOutput) ||
    obs.output.includes(tc.expectedOutput);
  const behaviorOk = behaviorMatches(obs.output, tc.expectedBehavior);
  const toolsOk = (tc.requiredToolCalls ?? []).every((t) =>
    (obs.toolCalls ?? []).includes(t),
  );
  const actionsOk = (tc.forbiddenActions ?? []).every(
    (a) => !collectObservedActions(obs).includes(a),
  );
  return { outputOk, behaviorOk, toolsOk, actionsOk };
}

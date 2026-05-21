import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EvalSpec, EvalSpecTestCase } from "./eval-spec";
import type { EvidenceCompleteness } from "./maintenance-result";
import type {
  RoutedProviderCallAttempt,
  SimulatedCaseObservation,
} from "./maintenance-check";
import type { BudgetState } from "./budget-gate";

export interface AgentQaToolCallObservation {
  name: string;
  input?: unknown;
  output?: unknown;
  status?: string;
  timestamp?: string;
}

export interface AgentQaActionObservation {
  name: string;
  status?: string;
  approved?: boolean;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentQaRoutedCallObservation {
  provider: string;
  model: string;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  status?: string;
  timestamp?: string;
  currentRunSpendUsd?: number;
  creditsRequired?: number;
}

export interface AgentQaObservationEvidenceMetadata {
  outputCaptured?: boolean;
  toolTraceCaptured?: boolean;
  actionTraceCaptured?: boolean;
  budgetStateLoaded?: boolean;
  pricingConfigLoaded?: boolean;
  ledgerWriteSucceeded?: boolean;
}

export interface AgentQaObservationOutputEntry {
  testCaseId?: string;
  text: string;
}

export interface AgentQaTestCaseObservation {
  agentOutput?: string;
  toolCalls?: AgentQaToolCallObservation[] | string[];
  actions?: AgentQaActionObservation[] | string[];
}

export interface AgentQaObservationFile {
  observationId: string;
  observedAt: string;
  specId?: string;
  workflowName?: string;
  environment?: string;
  agentOutput?: string;
  outputs?: Array<string | AgentQaObservationOutputEntry>;
  toolCalls?: AgentQaToolCallObservation[] | string[];
  actions?: AgentQaActionObservation[] | string[];
  routedCalls?: AgentQaRoutedCallObservation[];
  testCases?: Record<string, AgentQaTestCaseObservation>;
  evidenceMetadata?: AgentQaObservationEvidenceMetadata;
  notes?: string;
}

export interface AgentQaObservationValidationIssue {
  path: string;
  code: string;
  message: string;
  remediation: string;
  severity: "error" | "warning";
}

export interface AgentQaObservationsValidationResult {
  valid: boolean;
  errors: AgentQaObservationValidationIssue[];
  warnings: AgentQaObservationValidationIssue[];
  remediation: string[];
  data?: AgentQaObservationFile;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function toIssue(
  issuePath: string,
  code: string,
  message: string,
  remediation: string,
  severity: "error" | "warning" = "error",
): AgentQaObservationValidationIssue {
  return { path: issuePath, code, message, remediation, severity };
}

function collectRemediation(
  errors: AgentQaObservationValidationIssue[],
  warnings: AgentQaObservationValidationIssue[],
): string[] {
  const set = new Set<string>();
  for (const i of [...errors, ...warnings]) set.add(i.remediation);
  return [...set];
}

function normalizeToolCalls(
  raw: AgentQaToolCallObservation[] | string[] | undefined,
): AgentQaToolCallObservation[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  return raw.map((t) =>
    typeof t === "string" ? { name: t } : t,
  );
}

function normalizeActions(
  raw: AgentQaActionObservation[] | string[] | undefined,
): AgentQaActionObservation[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  return raw.map((a) =>
    typeof a === "string" ? { name: a } : a,
  );
}

function toolNames(
  raw: AgentQaToolCallObservation[] | string[] | undefined,
): string[] | undefined {
  const normalized = normalizeToolCalls(raw);
  if (normalized === undefined) return undefined;
  return normalized.map((t) => t.name).filter((n) => n.length > 0);
}

function actionNames(
  raw: AgentQaActionObservation[] | string[] | undefined,
): string[] | undefined {
  const normalized = normalizeActions(raw);
  if (normalized === undefined) return undefined;
  return normalized.map((a) => a.name).filter((n) => n.length > 0);
}

function specHasAnswerChecks(spec: EvalSpec): boolean {
  const checks = (spec as { checks?: Array<{ category?: string }> }).checks;
  if (Array.isArray(checks) && checks.some((c) => c.category === "answer")) return true;
  return spec.testCases.some(
    (tc) => tc.expectedOutput !== undefined || tc.expectedBehavior?.length,
  );
}

function specHasToolChecks(spec: EvalSpec): boolean {
  const checks = (spec as { checks?: Array<{ category?: string }> }).checks;
  if (Array.isArray(checks) && checks.some((c) => c.category === "tool_call")) return true;
  return spec.testCases.some((tc) => (tc.requiredToolCalls ?? []).length > 0);
}

function specHasActionChecks(spec: EvalSpec): boolean {
  const checks = (spec as { checks?: Array<{ category?: string }> }).checks;
  if (Array.isArray(checks) && checks.some((c) => c.category === "action")) return true;
  return (
    (spec.forbiddenActions ?? []).length > 0 ||
    spec.testCases.some((tc) => (tc.forbiddenActions ?? []).length > 0)
  );
}

function specHasBudgetChecks(spec: EvalSpec): boolean {
  const checks = (spec as { checks?: Array<{ category?: string }> }).checks;
  if (Array.isArray(checks) && checks.some((c) => c.category === "budget")) return true;
  return spec.budgetGate !== undefined;
}

function resolveOutputForCase(
  file: AgentQaObservationFile,
  tc: EvalSpecTestCase,
): string | undefined {
  const caseObs = file.testCases?.[tc.id];
  if (caseObs?.agentOutput !== undefined) return caseObs.agentOutput;

  if (file.outputs?.length) {
    for (const entry of file.outputs) {
      if (typeof entry === "string" && file.testCases === undefined && specSingleCase(file, tc)) {
        return entry;
      }
      if (typeof entry === "object" && entry !== null && "text" in entry) {
        const o = entry as AgentQaObservationOutputEntry;
        if (!o.testCaseId || o.testCaseId === tc.id) return o.text;
      }
    }
  }

  if (file.agentOutput !== undefined && (!file.testCases || Object.keys(file.testCases).length === 0)) {
    return file.agentOutput;
  }

  return file.agentOutput;
}

function specSingleCase(file: AgentQaObservationFile, tc: EvalSpecTestCase): boolean {
  return file.outputs?.length === 1 && !file.testCases;
}

function hasAnswerEvidence(file: AgentQaObservationFile, tc: EvalSpecTestCase): boolean {
  const out = resolveOutputForCase(file, tc);
  return typeof out === "string" && out.trim().length > 0;
}

function hasToolTrace(file: AgentQaObservationFile, tc: EvalSpecTestCase): boolean {
  const caseObs = file.testCases?.[tc.id];
  if (caseObs && "toolCalls" in caseObs) return caseObs.toolCalls !== undefined;
  if (file.toolCalls !== undefined) return true;
  return false;
}

function hasActionTrace(file: AgentQaObservationFile, tc: EvalSpecTestCase): boolean {
  const caseObs = file.testCases?.[tc.id];
  if (caseObs && "actions" in caseObs) return caseObs.actions !== undefined;
  if (file.actions !== undefined) return true;
  return false;
}

export function validateAgentQaObservations(
  raw: unknown,
  spec?: EvalSpec,
): AgentQaObservationsValidationResult {
  const errors: AgentQaObservationValidationIssue[] = [];
  const warnings: AgentQaObservationValidationIssue[] = [];

  if (!isPlainObject(raw)) {
    errors.push(
      toIssue("$", "invalid_root", "Observations must be a JSON object.", "Provide a JSON object root."),
    );
    return { valid: false, errors, warnings, remediation: collectRemediation(errors, warnings) };
  }

  const o = raw;

  if (!isNonEmptyString(o.observationId)) {
    errors.push(
      toIssue("observationId", "missing_observation_id", "observationId is required.", "Add a unique observationId."),
    );
  }
  if (!isNonEmptyString(o.observedAt)) {
    errors.push(
      toIssue("observedAt", "missing_observed_at", "observedAt is required (ISO-8601).", "Set observedAt to the capture timestamp."),
    );
  }

  if (o.specId !== undefined && !isNonEmptyString(o.specId)) {
    errors.push(toIssue("specId", "invalid_spec_id", "specId must be a non-empty string.", "Set specId to match your eval spec."));
  } else if (spec && isNonEmptyString(o.specId) && o.specId !== spec.specId) {
    warnings.push(
      toIssue(
        "specId",
        "spec_id_mismatch",
        `Observation specId "${o.specId}" does not match spec "${spec.specId}".`,
        "Align observation specId with the spec file you pass to agentqa:run.",
        "warning",
      ),
    );
  }

  if (o.toolCalls !== undefined) {
    if (!Array.isArray(o.toolCalls)) {
      errors.push(toIssue("toolCalls", "invalid_tool_calls", "toolCalls must be an array.", "Provide toolCalls as an array of tool names or objects."));
    } else {
      o.toolCalls.forEach((t, idx) => {
        if (typeof t === "string") {
          if (!t.trim()) errors.push(toIssue(`toolCalls[${idx}]`, "empty_tool_name", "Tool name cannot be empty.", "Use a non-empty tool name."));
        } else if (!isPlainObject(t) || !isNonEmptyString(t.name)) {
          errors.push(toIssue(`toolCalls[${idx}]`, "invalid_tool_call", "Each tool call object needs a name.", "Add name to each tool call entry."));
        }
      });
    }
  }

  if (o.actions !== undefined) {
    if (!Array.isArray(o.actions)) {
      errors.push(toIssue("actions", "invalid_actions", "actions must be an array.", "Provide actions as an array of action names or objects."));
    } else {
      o.actions.forEach((a, idx) => {
        if (typeof a === "string") {
          if (!a.trim()) errors.push(toIssue(`actions[${idx}]`, "empty_action_name", "Action name cannot be empty.", "Use a non-empty action name."));
        } else if (!isPlainObject(a) || !isNonEmptyString(a.name)) {
          errors.push(toIssue(`actions[${idx}]`, "invalid_action", "Each action object needs a name.", "Add name to each action entry."));
        }
      });
    }
  }

  if (o.routedCalls !== undefined) {
    if (!Array.isArray(o.routedCalls)) {
      errors.push(toIssue("routedCalls", "invalid_routed_calls", "routedCalls must be an array.", "Provide routedCalls as an array."));
    } else {
      o.routedCalls.forEach((c, idx) => {
        if (!isPlainObject(c)) {
          errors.push(toIssue(`routedCalls[${idx}]`, "invalid_routed_call", "Routed call must be an object.", "Fix routed call entry shape."));
          return;
        }
        if (!isNonEmptyString(c.provider)) {
          errors.push(toIssue(`routedCalls[${idx}].provider`, "missing_provider", "provider is required.", "Set provider on each routed call."));
        }
        if (!isNonEmptyString(c.model)) {
          errors.push(toIssue(`routedCalls[${idx}].model`, "missing_model", "model is required.", "Set model on each routed call."));
        }
        if (!isFiniteNumber(c.estimatedCostUsd) || c.estimatedCostUsd < 0) {
          errors.push(
            toIssue(
              `routedCalls[${idx}].estimatedCostUsd`,
              "invalid_estimated_cost",
              "estimatedCostUsd must be a non-negative number.",
              "Fix estimatedCostUsd on routed call entries.",
            ),
          );
        }
        if (c.actualCostUsd !== undefined && (!isFiniteNumber(c.actualCostUsd) || c.actualCostUsd < 0)) {
          errors.push(
            toIssue(
              `routedCalls[${idx}].actualCostUsd`,
              "invalid_actual_cost",
              "actualCostUsd must be a non-negative number when provided.",
              "Fix actualCostUsd or omit it.",
            ),
          );
        }
        if (c.inputTokens !== undefined && (!isFiniteNumber(c.inputTokens) || c.inputTokens < 0)) {
          errors.push(
            toIssue(`routedCalls[${idx}].inputTokens`, "invalid_input_tokens", "inputTokens must be a non-negative number.", "Fix token counts."),
          );
        }
        if (c.outputTokens !== undefined && (!isFiniteNumber(c.outputTokens) || c.outputTokens < 0)) {
          errors.push(
            toIssue(`routedCalls[${idx}].outputTokens`, "invalid_output_tokens", "outputTokens must be a non-negative number.", "Fix token counts."),
          );
        }
      });
    }
  }

  if (o.testCases !== undefined) {
    if (!isPlainObject(o.testCases)) {
      errors.push(toIssue("testCases", "invalid_test_cases", "testCases must be an object keyed by test case id.", "Use testCases as a record of per-case observations."));
    }
  }

  const hasAnyOutput =
    isNonEmptyString(o.agentOutput) ||
    (Array.isArray(o.outputs) && o.outputs.length > 0) ||
    (isPlainObject(o.testCases) &&
      Object.values(o.testCases).some(
        (c) => isPlainObject(c) && isNonEmptyString((c as AgentQaTestCaseObservation).agentOutput),
      ));

  if (spec) {
    if (specHasAnswerChecks(spec) && !hasAnyOutput) {
      errors.push(
        toIssue(
          "agentOutput",
          "missing_answer_output",
          "Spec includes answer checks but no agentOutput, outputs[], or per-testCase agentOutput was provided.",
          "Add agentOutput, outputs[], or testCases.{id}.agentOutput from your agent run.",
        ),
      );
    }

    if (specHasToolChecks(spec) && o.toolCalls === undefined && !isPlainObject(o.testCases)) {
      warnings.push(
        toIssue(
          "toolCalls",
          "missing_tool_trace",
          "Spec includes tool_call checks but no toolCalls array or testCases tool traces were provided.",
          "Export tool traces from your agent workflow into toolCalls or testCases.{id}.toolCalls.",
          "warning",
        ),
      );
    }

    if (specHasActionChecks(spec) && o.actions === undefined && !isPlainObject(o.testCases)) {
      warnings.push(
        toIssue(
          "actions",
          "missing_action_trace",
          "Spec includes action checks but no actions array or testCases action traces were provided.",
          "Export action traces into actions or testCases.{id}.actions.",
          "warning",
        ),
      );
    }

    if (specHasBudgetChecks(spec) && (!Array.isArray(o.routedCalls) || o.routedCalls.length === 0)) {
      warnings.push(
        toIssue(
          "routedCalls",
          "missing_routed_calls",
          "Spec includes budget checks; provide routedCalls observed through the AI Reliability gate.",
          "Add routedCalls[] with provider, model, and estimatedCostUsd for gate-routed provider calls only.",
          "warning",
        ),
      );
    }

    const usingPerCase =
      isPlainObject(o.testCases) && Object.keys(o.testCases).length > 0;
    const fileDraft = {
      observationId: String(o.observationId ?? ""),
      observedAt: String(o.observedAt ?? ""),
      specId: typeof o.specId === "string" ? o.specId : undefined,
      agentOutput: typeof o.agentOutput === "string" ? o.agentOutput : undefined,
      outputs: o.outputs as AgentQaObservationFile["outputs"],
      toolCalls: o.toolCalls as AgentQaObservationFile["toolCalls"],
      actions: o.actions as AgentQaObservationFile["actions"],
      testCases: o.testCases as Record<string, AgentQaTestCaseObservation>,
    } satisfies Partial<AgentQaObservationFile> as AgentQaObservationFile;

    for (const tc of spec.testCases) {
      const caseObs = isPlainObject(o.testCases) ? o.testCases[tc.id] : undefined;
      if (usingPerCase && !caseObs) {
        errors.push(
          toIssue(
            `testCases.${tc.id}`,
            "missing_test_case_observation",
            `No observation provided for test case ${tc.id}.`,
            `Add testCases.${tc.id} with agentOutput, toolCalls, and actions from your agent run.`,
          ),
        );
        continue;
      }
      if (!usingPerCase && !hasAnyOutput && !o.agentOutput) {
        errors.push(
          toIssue(
            `testCases.${tc.id}`,
            "missing_test_case_observation",
            `No observation provided for test case ${tc.id}.`,
            `Add testCases.${tc.id} or top-level agentOutput/outputs[].`,
          ),
        );
        continue;
      }

      if ((tc.expectedOutput || tc.expectedBehavior) && !hasAnswerEvidence(fileDraft, tc)) {
        const strict = (tc.requiredToolCalls ?? []).length > 0 || tc.severity === "blocking";
        const issue = toIssue(
          `testCases.${tc.id}.agentOutput`,
          "missing_case_output",
          `Test case ${tc.id} requires captured agent output for answer checks.`,
          `Add testCases.${tc.id}.agentOutput or outputs[] entry with testCaseId "${tc.id}".`,
          strict ? "error" : "warning",
        );
        if (strict) errors.push(issue);
        else warnings.push(issue);
      }

      if ((tc.requiredToolCalls ?? []).length > 0 && !hasToolTrace(fileDraft, tc)) {
        errors.push(
          toIssue(
            `testCases.${tc.id}.toolCalls`,
            "missing_case_tool_trace",
            `Test case ${tc.id} requires toolCalls but no tool trace was captured.`,
            `Add testCases.${tc.id}.toolCalls with required tools: ${tc.requiredToolCalls!.join(", ")}.`,
          ),
        );
      }
    }
  }

  if (o.evidenceMetadata !== undefined && !isPlainObject(o.evidenceMetadata)) {
    errors.push(
      toIssue("evidenceMetadata", "invalid_evidence_metadata", "evidenceMetadata must be an object.", "Fix evidenceMetadata shape."),
    );
  }

  const valid = errors.length === 0;
  const data: AgentQaObservationFile | undefined = valid
    ? {
        observationId: o.observationId as string,
        observedAt: o.observedAt as string,
        specId: typeof o.specId === "string" ? o.specId : undefined,
        workflowName: typeof o.workflowName === "string" ? o.workflowName : undefined,
        environment: typeof o.environment === "string" ? o.environment : undefined,
        agentOutput: typeof o.agentOutput === "string" ? o.agentOutput : undefined,
        outputs: o.outputs as AgentQaObservationFile["outputs"],
        toolCalls: o.toolCalls as AgentQaObservationFile["toolCalls"],
        actions: o.actions as AgentQaObservationFile["actions"],
        routedCalls: o.routedCalls as AgentQaRoutedCallObservation[],
        testCases: o.testCases as Record<string, AgentQaTestCaseObservation>,
        evidenceMetadata: o.evidenceMetadata as AgentQaObservationEvidenceMetadata,
        notes: typeof o.notes === "string" ? o.notes : undefined,
      }
    : undefined;

  return {
    valid,
    errors,
    warnings,
    remediation: collectRemediation(errors, warnings),
    data,
  };
}

export function parseAgentQaObservations(
  raw: unknown,
  spec?: EvalSpec,
): AgentQaObservationFile {
  const result = validateAgentQaObservations(raw, spec);
  if (!result.valid || !result.data) {
    const msg = result.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`Invalid Agent QA observations: ${msg}`);
  }
  return result.data;
}

export function mapObservationsToMaintenanceInput(
  spec: EvalSpec,
  file: AgentQaObservationFile,
): Record<string, SimulatedCaseObservation> {
  const observations: Record<string, SimulatedCaseObservation> = {};

  for (const tc of spec.testCases) {
    const caseObs = file.testCases?.[tc.id];
    const output =
      caseObs?.agentOutput ??
      resolveOutputForCase(file, tc) ??
      "";

    let toolCalls: string[] | undefined;
    if (caseObs && "toolCalls" in caseObs) {
      toolCalls = toolNames(caseObs.toolCalls);
    } else if (file.toolCalls !== undefined) {
      toolCalls = toolNames(file.toolCalls);
    }

    let actions: string[];
    if (caseObs && "actions" in caseObs) {
      actions = actionNames(caseObs.actions) ?? [];
    } else if (file.actions !== undefined) {
      actions = actionNames(file.actions) ?? [];
    } else {
      actions = [];
    }

    observations[tc.id] = {
      output,
      toolCalls,
      actions,
    };
  }

  return observations;
}

export function mapObservationEvidenceMetadata(
  file: AgentQaObservationFile,
): Partial<EvidenceCompleteness> | undefined {
  if (!file.evidenceMetadata) return undefined;
  return { ...file.evidenceMetadata };
}

export function buildRoutedCallFromObservations(
  runId: string,
  spec: EvalSpec,
  budget: BudgetState,
  file: AgentQaObservationFile,
): RoutedProviderCallAttempt | undefined {
  const gate = spec.budgetGate;
  if (!gate || !file.routedCalls?.length) {
    return undefined;
  }

  const rc = file.routedCalls[0]!;
  const monthlyCap = gate.monthlyBudgetLimitUsd;

  return {
    callId: `call-${runId}`,
    planId: budget.planId,
    subscriptionActive: true,
    creditsRemaining: budget.creditsRemaining,
    monthlyBudgetRemainingUsd: Math.min(budget.budgetRemainingUsd, monthlyCap),
    currentRunSpendUsd: rc.currentRunSpendUsd ?? 0,
    estimatedCreditsRequired: rc.creditsRequired ?? 1,
    estimatedCostUsd: rc.estimatedCostUsd,
    provider: rc.provider,
    model: rc.model,
    pricingKnown: file.evidenceMetadata?.pricingConfigLoaded !== false,
    budgetStatePresent: file.evidenceMetadata?.budgetStateLoaded !== false,
    estimatedInputTokens: rc.inputTokens ?? 300,
    estimatedOutputTokens: rc.outputTokens ?? 100,
  };
}

export async function loadObservationsForAgentQaRun(
  observationsPath: string,
  spec: EvalSpec,
  cwd: string = process.cwd(),
): Promise<
  | { ok: true; data: AgentQaObservationFile; resolvedPath: string }
  | {
      ok: false;
      resolvedPath: string;
      reason: "missing_file" | "invalid_json" | "invalid_observations";
      message: string;
      errors: AgentQaObservationValidationIssue[];
      warnings: AgentQaObservationValidationIssue[];
      remediation: string[];
    }
> {
  const resolvedPath = path.resolve(cwd, observationsPath);

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolvedPath, "utf-8")) as unknown;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code =
      (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing_file" : "invalid_json";
    return {
      ok: false,
      resolvedPath,
      reason: code,
      message:
        code === "missing_file"
          ? `Observation file not found: ${resolvedPath}`
          : `Could not parse observation JSON: ${msg}`,
      errors: [
        toIssue(
          resolvedPath,
          code,
          code === "missing_file" ? "Observation file does not exist." : `Invalid JSON: ${msg}`,
          code === "missing_file"
            ? "Provide a valid path to your observation JSON file."
            : "Fix JSON syntax in the observation file.",
        ),
      ],
      warnings: [],
      remediation: [],
    };
  }

  const validation = validateAgentQaObservations(raw, spec);
  if (!validation.valid) {
    return {
      ok: false,
      resolvedPath,
      reason: "invalid_observations",
      message: "Agent QA observation validation failed.",
      errors: validation.errors,
      warnings: validation.warnings,
      remediation: validation.remediation,
    };
  }

  return { ok: true, data: validation.data!, resolvedPath };
}

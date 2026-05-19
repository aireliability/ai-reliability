import type { EnforcementMode } from "./maintenance-result";
import {
  validateEvalSpec,
  type EvalSpec,
  type EvalSpecValidationIssue,
} from "./eval-spec";

export type AgentQaCheckCategory =
  | "answer"
  | "tool_call"
  | "action"
  | "budget"
  | "deploy"
  | "setup";

const ENFORCEMENT_MODES: ReadonlySet<string> = new Set([
  "observe",
  "warn",
  "enforce",
]);

const CHECK_CATEGORIES: ReadonlySet<string> = new Set([
  "answer",
  "tool_call",
  "action",
  "budget",
  "deploy",
  "setup",
]);

const REMEDIATION_BY_CODE: Record<string, string> = {
  missing_enforcement_mode:
    "Add enforcementMode at the spec root: observe, warn, or enforce.",
  invalid_enforcement_mode:
    "Set enforcementMode to one of: observe, warn, enforce.",
  empty_checks:
    "Add at least one entry to checks or a non-empty testCases array.",
  missing_required_tool_calls:
    "Add requiredToolCalls on the check, test case, or spec root for tool_call checks.",
  missing_forbidden_actions:
    "Add forbiddenActions on the check, test case, or spec root for action checks.",
  missing_budget_limit:
    "Set budgetGate.monthlyBudgetLimitUsd to a positive number for routed-call budget checks.",
  invalid_budget_limit:
    "Budget limits must be positive finite numbers (USD for routed calls through the gate).",
  missing_expected_output:
    "Add expectedOutput on the check or test case, or expectedOutputs at spec root for answer checks.",
  missing_expected_behavior:
    "Add expectedBehavior on the check or test case for answer checks.",
  unsupported_check_category:
    "Use a supported category: answer, tool_call, action, budget, deploy, or setup.",
  missing_spec_id: "Add a unique specId string at the spec root.",
  missing_spec_name: "Add specName (human-readable title) at the spec root.",
  missing_workflow: "Add workflowName identifying the agent or workflow.",
  missing_version: "Add version as a number >= 1.",
  invalid_budget_providers:
    "Set budgetGate.allowedProviders to a non-empty array of provider ids for routed calls.",
  invalid_budget_models:
    "Set budgetGate.allowedModels to a non-empty array of model ids for routed calls.",
};

export interface AgentQaSpecValidationError {
  code: string;
  message: string;
  path: string;
  remediation: string;
}

export interface AgentQaSpecValidationResult {
  valid: boolean;
  errors: AgentQaSpecValidationError[];
  warnings: AgentQaSpecValidationError[];
  remediation: string[];
}

export interface AgentQaCheckDefinition {
  id: string;
  name: string;
  category: AgentQaCheckCategory;
  severity: "info" | "warning" | "blocking";
  description?: string;
  expectedBehavior?: string;
  expectedOutput?: string;
  requiredToolCalls?: string[];
  forbiddenActions?: string[];
}

export interface AgentQaEvalSpec extends EvalSpec {
  description?: string;
  enforcementMode: EnforcementMode;
  checks?: AgentQaCheckDefinition[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyStringArray(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((item) => isNonEmptyString(item))
  );
}

function toError(
  path: string,
  code: string,
  message: string,
  remediation?: string,
): AgentQaSpecValidationError {
  return {
    path,
    code,
    message,
    remediation: remediation ?? REMEDIATION_BY_CODE[code] ?? message,
  };
}

function mapBaseIssues(issues: EvalSpecValidationIssue[]): AgentQaSpecValidationError[] {
  return issues.map((i) =>
    toError(
      i.path,
      i.code === "required" ? `missing_${i.path.replace(/\./g, "_")}` : i.code,
      i.message,
    ),
  );
}

function collectRemediation(
  errors: AgentQaSpecValidationError[],
  warnings: AgentQaSpecValidationError[],
): string[] {
  return [...new Set([...errors, ...warnings].map((e) => e.remediation))];
}

function specHasRequiredTools(spec: Record<string, unknown>): boolean {
  if (isNonEmptyStringArray(spec.requiredToolCalls)) return true;
  const tcs = spec.testCases;
  if (!Array.isArray(tcs)) return false;
  return tcs.some(
    (tc) =>
      isPlainObject(tc) && isNonEmptyStringArray(tc.requiredToolCalls),
  );
}

function specHasForbiddenActions(spec: Record<string, unknown>): boolean {
  if (isNonEmptyStringArray(spec.forbiddenActions)) return true;
  const tcs = spec.testCases;
  if (!Array.isArray(tcs)) return false;
  return tcs.some(
    (tc) => isPlainObject(tc) && isNonEmptyStringArray(tc.forbiddenActions),
  );
}

function checkHasExpectedAnswerData(
  check: AgentQaCheckDefinition,
  spec: Record<string, unknown>,
): boolean {
  if (isNonEmptyString(check.expectedOutput)) return true;
  if (isNonEmptyString(check.expectedBehavior)) return true;
  if (isNonEmptyStringArray(spec.expectedOutputs as unknown)) return true;
  const tcs = spec.testCases;
  if (!Array.isArray(tcs)) return false;
  return tcs.some((tc) => {
    if (!isPlainObject(tc)) return false;
    return (
      isNonEmptyString(tc.expectedOutput) || isNonEmptyString(tc.expectedBehavior)
    );
  });
}

/**
 * Validate an Agent QA eval spec before runtime.
 * Fails closed on structural errors; warnings do not set valid=false.
 */
export function validateAgentQaSpec(raw: unknown): AgentQaSpecValidationResult {
  const errors: AgentQaSpecValidationError[] = [];
  const warnings: AgentQaSpecValidationError[] = [];

  if (!isPlainObject(raw)) {
    errors.push(
      toError("$", "invalid_root", "Spec must be a JSON object."),
    );
    return {
      valid: false,
      errors,
      warnings,
      remediation: collectRemediation(errors, warnings),
    };
  }

  const o = raw;

  const base = validateEvalSpec(raw);
  if (!base.ok) {
    errors.push(...mapBaseIssues(base.issues));
  }

  if (!isNonEmptyString(o.specId)) {
    errors.push(
      toError("specId", "missing_spec_id", "specId is required."),
    );
  }
  if (!isNonEmptyString(o.specName)) {
    errors.push(
      toError("specName", "missing_spec_name", "specName is required."),
    );
  }
  if (!isNonEmptyString(o.workflowName)) {
    errors.push(
      toError("workflowName", "missing_workflow", "workflowName is required."),
    );
  }
  if (!isFiniteNumber(o.version) || o.version < 1) {
    errors.push(
      toError("version", "missing_version", "version must be a number >= 1."),
    );
  }

  if (!isNonEmptyString(o.enforcementMode)) {
    errors.push(
      toError(
        "enforcementMode",
        "missing_enforcement_mode",
        "enforcementMode is required for Agent QA specs.",
      ),
    );
  } else if (!ENFORCEMENT_MODES.has(o.enforcementMode)) {
    errors.push(
      toError(
        "enforcementMode",
        "invalid_enforcement_mode",
        `Invalid enforcementMode "${o.enforcementMode}".`,
      ),
    );
  }

  const hasTestCases = Array.isArray(o.testCases) && o.testCases.length > 0;
  const hasChecks = Array.isArray(o.checks) && o.checks.length > 0;

  if (o.checks !== undefined && Array.isArray(o.checks) && o.checks.length === 0) {
    errors.push(
      toError(
        "checks",
        "empty_checks",
        "checks array must not be empty when present.",
      ),
    );
  }

  if (!hasTestCases && !hasChecks) {
    errors.push(
      toError(
        "testCases",
        "empty_checks",
        "Provide at least one test case or check definition.",
      ),
    );
  }

  if (Array.isArray(o.checks)) {
    o.checks.forEach((check: unknown, idx: number) => {
      const path = `checks[${idx}]`;
      if (!isPlainObject(check)) {
        errors.push(toError(path, "invalid", "Each check must be an object."));
        return;
      }
      if (!isNonEmptyString(check.id)) {
        errors.push(toError(`${path}.id`, "required", "Check id is required."));
      }
      if (!isNonEmptyString(check.name)) {
        errors.push(toError(`${path}.name`, "required", "Check name is required."));
      }
      if (!isNonEmptyString(check.category)) {
        errors.push(
          toError(`${path}.category`, "required", "Check category is required."),
        );
      } else if (!CHECK_CATEGORIES.has(check.category)) {
        errors.push(
          toError(
            `${path}.category`,
            "unsupported_check_category",
            `Unsupported check category "${check.category}".`,
          ),
        );
      } else {
        const cat = check.category as AgentQaCheckCategory;
        const sev = check.severity;
        if (!isNonEmptyString(sev) || !["info", "warning", "blocking"].includes(sev)) {
          errors.push(
            toError(
              `${path}.severity`,
              "invalid_enum",
              "Check severity must be info, warning, or blocking.",
            ),
          );
        }

        if (cat === "tool_call") {
          const tools =
            isNonEmptyStringArray(check.requiredToolCalls) ||
            specHasRequiredTools(o);
          if (!tools) {
            errors.push(
              toError(
                `${path}.requiredToolCalls`,
                "missing_required_tool_calls",
                "tool_call checks require requiredToolCalls on the check or spec.",
              ),
            );
          }
        }

        if (cat === "action") {
          const actions =
            isNonEmptyStringArray(check.forbiddenActions) ||
            specHasForbiddenActions(o);
          if (!actions) {
            errors.push(
              toError(
                `${path}.forbiddenActions`,
                "missing_forbidden_actions",
                "action checks require forbiddenActions on the check or spec.",
              ),
            );
          }
        }

        if (cat === "budget") {
          const bg = o.budgetGate;
          if (!isPlainObject(bg)) {
            errors.push(
              toError(
                "budgetGate",
                "missing_budget_limit",
                "budget checks require a budgetGate object.",
              ),
            );
          } else {
            if (
              !isFiniteNumber(bg.monthlyBudgetLimitUsd) ||
              bg.monthlyBudgetLimitUsd <= 0
            ) {
              errors.push(
                toError(
                  "budgetGate.monthlyBudgetLimitUsd",
                  bg.monthlyBudgetLimitUsd === undefined ||
                    bg.monthlyBudgetLimitUsd === null
                    ? "missing_budget_limit"
                    : "invalid_budget_limit",
                  "monthlyBudgetLimitUsd must be a positive number for routed-call budget checks.",
                ),
              );
            }
            if (
              bg.perRunBudgetLimitUsd !== undefined &&
              (!isFiniteNumber(bg.perRunBudgetLimitUsd) ||
                bg.perRunBudgetLimitUsd <= 0)
            ) {
              errors.push(
                toError(
                  "budgetGate.perRunBudgetLimitUsd",
                  "invalid_budget_limit",
                  "perRunBudgetLimitUsd must be a positive number when set.",
                ),
              );
            }
            if (
              bg.allowedProviders !== undefined &&
              !isNonEmptyStringArray(bg.allowedProviders)
            ) {
              errors.push(
                toError(
                  "budgetGate.allowedProviders",
                  "invalid_budget_providers",
                  "allowedProviders must be a non-empty string array when set for budget checks.",
                ),
              );
            }
            if (
              bg.allowedModels !== undefined &&
              !isNonEmptyStringArray(bg.allowedModels)
            ) {
              errors.push(
                toError(
                  "budgetGate.allowedModels",
                  "invalid_budget_models",
                  "allowedModels must be a non-empty string array when set for budget checks.",
                ),
              );
            }
          }
        }

        if (cat === "answer") {
          if (
            !checkHasExpectedAnswerData(
              check as unknown as AgentQaCheckDefinition,
              o,
            )
          ) {
            errors.push(
              toError(
                path,
                "missing_expected_output",
                "answer checks require expectedOutput, expectedBehavior, or matching test case fields.",
              ),
            );
          }
        }
      }
    });
  }

  if (isPlainObject(o.budgetGate)) {
    const bg = o.budgetGate;
    if (
      isFiniteNumber(bg.monthlyBudgetLimitUsd) &&
      bg.monthlyBudgetLimitUsd <= 0
    ) {
      errors.push(
        toError(
          "budgetGate.monthlyBudgetLimitUsd",
          "invalid_budget_limit",
          "monthlyBudgetLimitUsd must be greater than zero.",
        ),
      );
    }
    if (
      bg.perRunBudgetLimitUsd !== undefined &&
      isFiniteNumber(bg.perRunBudgetLimitUsd) &&
      bg.perRunBudgetLimitUsd <= 0
    ) {
      errors.push(
        toError(
          "budgetGate.perRunBudgetLimitUsd",
          "invalid_budget_limit",
          "perRunBudgetLimitUsd must be greater than zero when set.",
        ),
      );
    }
  }

  if (isNonEmptyString(o.description) && o.description.length > 2000) {
    warnings.push(
      toError(
        "description",
        "description_long",
        "description is very long; consider moving detail into policies or metadata.notes.",
        "Shorten description or use metadata.notes for extended guidance.",
      ),
    );
  }

  const valid = errors.length === 0;
  return {
    valid,
    errors,
    warnings,
    remediation: collectRemediation(errors, warnings),
  };
}

export function parseAgentQaSpec(raw: unknown): AgentQaEvalSpec {
  const result = validateAgentQaSpec(raw);
  if (!result.valid) {
    const msg = result.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`Invalid Agent QA spec: ${msg}`);
  }
  return raw as AgentQaEvalSpec;
}

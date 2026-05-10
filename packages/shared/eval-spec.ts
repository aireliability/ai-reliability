/**
 * Customer-defined evaluation specs are the source of truth for maintenance checks.
 * AI Reliability compares model output, tool calls, and actions against these definitions.
 */

export type EvalEnvironment =
  | "development"
  | "staging"
  | "production"
  | "pre_production";

export type EvalSeverity = "info" | "warning" | "blocking";

export interface EvalSpecBudgetGate {
  monthlyBudgetLimitUsd: number;
  perRunBudgetLimitUsd?: number;
  allowedProviders?: string[];
  allowedModels?: string[];
  /** When true, unknown pricing or missing gate inputs fail closed (misconfigured / blocked). */
  failClosed: boolean;
}

export interface EvalSpecTestCase {
  id: string;
  name: string;
  input: string;
  expectedBehavior: string;
  expectedOutput?: string;
  requiredToolCalls?: string[];
  forbiddenActions?: string[];
  requiredEvidence?: string[];
  severity: EvalSeverity;
  tags?: string[];
}

export interface EvalSpec {
  specId: string;
  specName: string;
  workflowName: string;
  environment: EvalEnvironment;
  version: number;
  policies?: string[];
  expectedOutputs?: string[];
  expectedBehaviors?: string[];
  testCases: EvalSpecTestCase[];
  requiredToolCalls?: string[];
  forbiddenActions?: string[];
  escalationRules?: string[];
  budgetGate: EvalSpecBudgetGate;
  severity: EvalSeverity;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

const ENVIRONMENTS: ReadonlySet<string> = new Set([
  "development",
  "staging",
  "production",
  "pre_production",
]);

const SEVERITIES: ReadonlySet<string> = new Set([
  "info",
  "warning",
  "blocking",
]);

export interface EvalSpecValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface EvalSpecValidationResult {
  ok: boolean;
  issues: EvalSpecValidationIssue[];
}

function issue(
  path: string,
  code: string,
  message: string,
): EvalSpecValidationIssue {
  return { path, code, message };
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

/**
 * Validate structure and required fields. Invalid specs fail closed (ok: false with issues).
 */
export function validateEvalSpec(raw: unknown): EvalSpecValidationResult {
  const issues: EvalSpecValidationIssue[] = [];

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      issues: [issue("$", "invalid_root", "Spec must be a JSON object")],
    };
  }

  const o = raw;

  if (!isNonEmptyString(o.specId)) {
    issues.push(issue("specId", "required", "specId is required"));
  }
  if (!isNonEmptyString(o.specName)) {
    issues.push(issue("specName", "required", "specName is required"));
  }
  if (!isNonEmptyString(o.workflowName)) {
    issues.push(issue("workflowName", "required", "workflowName is required"));
  }
  if (!isNonEmptyString(o.environment) || !ENVIRONMENTS.has(o.environment)) {
    issues.push(
      issue(
        "environment",
        "invalid_enum",
        "environment must be development | staging | production | pre_production",
      ),
    );
  }
  if (!isFiniteNumber(o.version) || o.version < 1) {
    issues.push(issue("version", "invalid", "version must be a number >= 1"));
  }
  if (!isNonEmptyString(o.severity) || !SEVERITIES.has(o.severity)) {
    issues.push(
      issue(
        "severity",
        "invalid_enum",
        "severity must be info | warning | blocking",
      ),
    );
  }

  if (!isPlainObject(o.budgetGate)) {
    issues.push(issue("budgetGate", "required", "budgetGate object is required"));
  } else {
    const bg = o.budgetGate;
    if (
      !isFiniteNumber(bg.monthlyBudgetLimitUsd) ||
      bg.monthlyBudgetLimitUsd < 0
    ) {
      issues.push(
        issue(
          "budgetGate.monthlyBudgetLimitUsd",
          "invalid",
          "monthlyBudgetLimitUsd must be a non-negative finite number",
        ),
      );
    }
    if (
      bg.perRunBudgetLimitUsd !== undefined &&
      (!isFiniteNumber(bg.perRunBudgetLimitUsd) || bg.perRunBudgetLimitUsd < 0)
    ) {
      issues.push(
        issue(
          "budgetGate.perRunBudgetLimitUsd",
          "invalid",
          "perRunBudgetLimitUsd must be a non-negative finite number when set",
        ),
      );
    }
    if (typeof bg.failClosed !== "boolean") {
      issues.push(
        issue(
          "budgetGate.failClosed",
          "required",
          "budgetGate.failClosed must be a boolean",
        ),
      );
    }
    if (
      bg.allowedProviders !== undefined &&
      !Array.isArray(bg.allowedProviders)
    ) {
      issues.push(
        issue(
          "budgetGate.allowedProviders",
          "invalid",
          "allowedProviders must be an array of strings when set",
        ),
      );
    } else if (Array.isArray(bg.allowedProviders)) {
      for (let i = 0; i < bg.allowedProviders.length; i++) {
        if (!isNonEmptyString(bg.allowedProviders[i])) {
          issues.push(
            issue(
              `budgetGate.allowedProviders[${i}]`,
              "invalid",
              "each entry must be a non-empty string",
            ),
          );
        }
      }
    }
    if (bg.allowedModels !== undefined && !Array.isArray(bg.allowedModels)) {
      issues.push(
        issue(
          "budgetGate.allowedModels",
          "invalid",
          "allowedModels must be an array of strings when set",
        ),
      );
    } else if (Array.isArray(bg.allowedModels)) {
      for (let i = 0; i < bg.allowedModels.length; i++) {
        if (!isNonEmptyString(bg.allowedModels[i])) {
          issues.push(
            issue(
              `budgetGate.allowedModels[${i}]`,
              "invalid",
              "each entry must be a non-empty string",
            ),
          );
        }
      }
    }
  }

  if (!Array.isArray(o.testCases)) {
    issues.push(issue("testCases", "required", "testCases must be a non-empty array"));
  } else if (o.testCases.length === 0) {
    issues.push(issue("testCases", "required", "testCases must be non-empty"));
  } else {
    o.testCases.forEach((tc: unknown, idx: number) => {
      const p = `testCases[${idx}]`;
      if (!isPlainObject(tc)) {
        issues.push(issue(p, "invalid", "each test case must be an object"));
        return;
      }
      if (!isNonEmptyString(tc.id)) {
        issues.push(issue(`${p}.id`, "required", "id is required"));
      }
      if (!isNonEmptyString(tc.name)) {
        issues.push(issue(`${p}.name`, "required", "name is required"));
      }
      if (!isNonEmptyString(tc.input)) {
        issues.push(issue(`${p}.input`, "required", "input is required"));
      }
      if (!isNonEmptyString(tc.expectedBehavior)) {
        issues.push(
          issue(`${p}.expectedBehavior`, "required", "expectedBehavior is required"),
        );
      }
      if (!isNonEmptyString(tc.severity) || !SEVERITIES.has(tc.severity)) {
        issues.push(
          issue(
            `${p}.severity`,
            "invalid_enum",
            "severity must be info | warning | blocking",
          ),
        );
      }
      if (tc.requiredToolCalls !== undefined) {
        if (!Array.isArray(tc.requiredToolCalls)) {
          issues.push(issue(`${p}.requiredToolCalls`, "invalid", "must be an array"));
        } else {
          tc.requiredToolCalls.forEach((t: unknown, j: number) => {
            if (!isNonEmptyString(t)) {
              issues.push(
                issue(`${p}.requiredToolCalls[${j}]`, "invalid", "must be a non-empty string"),
              );
            }
          });
        }
      }
      if (tc.forbiddenActions !== undefined) {
        if (!Array.isArray(tc.forbiddenActions)) {
          issues.push(issue(`${p}.forbiddenActions`, "invalid", "must be an array"));
        } else {
          tc.forbiddenActions.forEach((t: unknown, j: number) => {
            if (!isNonEmptyString(t)) {
              issues.push(
                issue(`${p}.forbiddenActions[${j}]`, "invalid", "must be a non-empty string"),
              );
            }
          });
        }
      }
      if (tc.requiredEvidence !== undefined) {
        if (!Array.isArray(tc.requiredEvidence)) {
          issues.push(issue(`${p}.requiredEvidence`, "invalid", "must be an array"));
        } else {
          tc.requiredEvidence.forEach((t: unknown, j: number) => {
            if (!isNonEmptyString(t)) {
              issues.push(
                issue(`${p}.requiredEvidence[${j}]`, "invalid", "must be a non-empty string"),
              );
            }
          });
        }
      }
      if (tc.tags !== undefined) {
        if (!Array.isArray(tc.tags)) {
          issues.push(issue(`${p}.tags`, "invalid", "must be an array"));
        }
      }
    });
  }

  const optionalStringArrays: [string, unknown][] = [
    ["policies", o.policies],
    ["expectedOutputs", o.expectedOutputs],
    ["expectedBehaviors", o.expectedBehaviors],
    ["requiredToolCalls", o.requiredToolCalls],
    ["forbiddenActions", o.forbiddenActions],
    ["escalationRules", o.escalationRules],
  ];
  for (const [key, val] of optionalStringArrays) {
    if (val === undefined) continue;
    if (!Array.isArray(val)) {
      issues.push(issue(key, "invalid", `${key} must be an array when set`));
      continue;
    }
    val.forEach((item: unknown, i: number) => {
      if (!isNonEmptyString(item)) {
        issues.push(
          issue(`${key}[${i}]`, "invalid", "each entry must be a non-empty string"),
        );
      }
    });
  }

  if (o.metadata !== undefined && !isPlainObject(o.metadata)) {
    issues.push(issue("metadata", "invalid", "metadata must be an object when set"));
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Parse and validate; throws only if you prefer — callers should use validateEvalSpec for fail-closed flows.
 */
export function parseEvalSpec(raw: unknown): EvalSpec {
  const v = validateEvalSpec(raw);
  if (!v.ok) {
    const msg = v.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new Error(`Invalid eval spec: ${msg}`);
  }
  return raw as EvalSpec;
}

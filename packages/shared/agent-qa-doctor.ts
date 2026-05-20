import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  loadArtifactBundle,
  reconcileAgentQaArtifacts,
  wrapDoctorResult,
} from "./agent-qa-artifacts";
import { isPassingGateDecision } from "./agent-qa";
import { validateAgentQaSpec } from "./agent-qa-spec-validator";
import type { GateDecision } from "./maintenance-result";
import type { MaintenanceRunResult } from "./maintenance-result";

export type DoctorStatus = "ready" | "warning" | "blocked";

export type DoctorCheckStatus = "pass" | "warning" | "fail";

export type DoctorCheckCategory =
  | "spec"
  | "template"
  | "budget"
  | "pricing"
  | "ledger"
  | "evidence"
  | "artifacts"
  | "gate"
  | "environment";

export interface DoctorCheck {
  id: string;
  category: DoctorCheckCategory;
  status: DoctorCheckStatus;
  title: string;
  message: string;
  path?: string;
  remediation: string[];
}

export interface DoctorResult {
  status: DoctorStatus;
  checks: DoctorCheck[];
  summary: string;
  nextActions: string[];
  evaluatedAt: string;
}

export interface RunDoctorInput {
  cwd?: string;
  specPaths?: string[];
  artifactsDir?: string;
  packageJsonPath?: string;
  writeArtifact?: boolean;
}

export const DEFAULT_TEMPLATE_PATHS = [
  "examples/eval-specs/support-agent-qa.spec.json",
  "examples/eval-specs/tool-call-required.spec.json",
  "examples/eval-specs/forbidden-action.spec.json",
  "examples/eval-specs/agent-budget-gate.spec.json",
  "examples/eval-specs/pricing-plan-agent.spec.json",
];

export const REQUIRED_NPM_SCRIPTS = [
  "test:maintenance-gate",
  "test:budget-gate",
  "demo:maintenance-gate",
  "agentqa:run",
  "gate:release",
  "validate:spec",
  "doctor",
  "firewall:check",
] as const;

function check(
  partial: Omit<DoctorCheck, "remediation"> & { remediation?: string[] },
): DoctorCheck {
  return {
    ...partial,
    remediation: partial.remediation ?? [],
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasBudgetChecksInSpec(spec: Record<string, unknown>): boolean {
  const checks = spec.checks;
  if (Array.isArray(checks)) {
    if (checks.some((c) => isPlainObject(c) && c.category === "budget")) return true;
  }
  return isPlainObject(spec.budgetGate);
}

function mentionsRoutedScope(spec: Record<string, unknown>): boolean {
  const text = [
    typeof spec.description === "string" ? spec.description : "",
    isPlainObject(spec.metadata) && typeof spec.metadata.notes === "string"
      ? spec.metadata.notes
      : "",
    isPlainObject(spec.metadata) &&
    typeof spec.metadata.budgetScope === "string"
      ? spec.metadata.budgetScope
      : "",
  ]
    .join(" ")
    .toLowerCase();
  return text.includes("routed");
}

function deriveOverallStatus(checks: DoctorCheck[]): DoctorStatus {
  if (checks.some((c) => c.status === "fail")) return "blocked";
  if (checks.some((c) => c.status === "warning")) return "warning";
  return "ready";
}

function buildSummary(checks: DoctorCheck[]): string {
  const passed = checks.filter((c) => c.status === "pass").length;
  const warnings = checks.filter((c) => c.status === "warning").length;
  const fails = checks.filter((c) => c.status === "fail").length;
  return `${passed} checks passed, ${warnings} warnings, ${fails} blocking issues`;
}

function buildNextActions(checks: DoctorCheck[], status: DoctorStatus): string[] {
  const actions = new Set<string>();
  for (const c of checks) {
    if (c.status === "fail" || c.status === "warning") {
      for (const r of c.remediation) actions.add(r);
    }
  }
  if (status !== "ready") {
    actions.add("Run npm run validate:spec");
  }
  if (checks.some((c) => c.id.startsWith("artifacts:") && c.status !== "pass")) {
    actions.add("Run npm run agentqa:run");
    actions.add("Run npm run gate:release");
  }
  if (checks.some((c) => c.category === "ledger" && c.status === "warning")) {
    actions.add(
      "Run npm run agentqa:run to record a sample routed provider-call in the ledger.",
    );
  }
  if (status === "ready" && actions.size === 0) {
    actions.add("Run npm run validate:spec before changes to eval specs.");
    actions.add("Run npm run agentqa:run after spec or observation updates.");
    actions.add("Run npm run gate:release in CI/CD before deploy.");
  }
  return [...actions];
}

export async function runDoctor(input: RunDoctorInput = {}): Promise<DoctorResult> {
  const cwd = input.cwd ?? process.cwd();
  const artifactsDir = path.resolve(
    cwd,
    input.artifactsDir ?? path.join("deliverables", "maintenance"),
  );
  const specPaths = (input.specPaths ?? DEFAULT_TEMPLATE_PATHS).map((p) =>
    path.resolve(cwd, p),
  );
  const packageJsonPath = path.resolve(
    cwd,
    input.packageJsonPath ?? "package.json",
  );

  const checks: DoctorCheck[] = [];
  const evaluatedAt = new Date().toISOString();

  if (await fileExists(packageJsonPath)) {
    try {
      const pkg = JSON.parse(
        await readFile(packageJsonPath, "utf-8"),
      ) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      for (const script of REQUIRED_NPM_SCRIPTS) {
        if (scripts[script]) {
          checks.push(
            check({
              id: `environment:script:${script}`,
              category: "environment",
              status: "pass",
              title: `npm script ${script}`,
              message: `package.json defines "${script}".`,
              path: "package.json",
            }),
          );
        } else {
          checks.push(
            check({
              id: `environment:script:${script}`,
              category: "environment",
              status: script === "doctor" ? "warning" : "fail",
              title: `npm script ${script}`,
              message: `package.json is missing script "${script}".`,
              path: "package.json",
              remediation: [`Add "${script}" to package.json scripts.`],
            }),
          );
        }
      }
    } catch {
      checks.push(
        check({
          id: "environment:package-json",
          category: "environment",
          status: "fail",
          title: "package.json readable",
          message: "package.json could not be parsed.",
          path: packageJsonPath,
          remediation: ["Fix package.json syntax."],
        }),
      );
    }
  } else {
    checks.push(
      check({
        id: "environment:package-json",
        category: "environment",
        status: "fail",
        title: "package.json exists",
        message: "package.json was not found in the project root.",
        path: packageJsonPath,
        remediation: ["Run doctor from the ai-reliability repository root."],
      }),
    );
  }

  for (const specPath of specPaths) {
    const rel = path.relative(cwd, specPath);
    const category: DoctorCheckCategory = rel.includes("examples/eval-specs")
      ? "template"
      : "spec";

    if (!(await fileExists(specPath))) {
      checks.push(
        check({
          id: `spec:exists:${rel}`,
          category,
          status: "fail",
          title: `Spec file exists (${rel})`,
          message: `Spec file not found: ${rel}`,
          path: rel,
          remediation: [`Create or restore the spec at ${rel}.`],
        }),
      );
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(specPath, "utf-8")) as unknown;
      checks.push(
        check({
          id: `spec:json:${rel}`,
          category,
          status: "pass",
          title: `Spec parses as JSON (${rel})`,
          message: "Spec file is valid JSON.",
          path: rel,
        }),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      checks.push(
        check({
          id: `spec:json:${rel}`,
          category,
          status: "fail",
          title: `Spec parses as JSON (${rel})`,
          message: `Invalid JSON: ${msg}`,
          path: rel,
          remediation: ["Fix JSON syntax in the spec file."],
        }),
      );
      continue;
    }

    const validation = validateAgentQaSpec(raw);
    if (validation.valid) {
      checks.push(
        check({
          id: `spec:agent-qa:${rel}`,
          category,
          status: "pass",
          title: `Agent QA spec validation (${rel})`,
          message: "validateAgentQaSpec passed.",
          path: rel,
        }),
      );
    } else {
      for (const err of validation.errors) {
        checks.push(
          check({
            id: `spec:agent-qa:${rel}:${err.code}`,
            category,
            status: "fail",
            title: `Agent QA validation (${rel})`,
            message: `${err.path}: ${err.message}`,
            path: rel,
            remediation: [err.remediation],
          }),
        );
      }
    }
    for (const warn of validation.warnings) {
      checks.push(
        check({
          id: `spec:agent-qa-warn:${rel}:${warn.code}`,
          category,
          status: "warning",
          title: `Agent QA validation warning (${rel})`,
          message: `${warn.path}: ${warn.message}`,
          path: rel,
          remediation: [warn.remediation],
        }),
      );
    }

    if (isPlainObject(raw)) {
      const mode = raw.enforcementMode;
      if (
        mode === "observe" ||
        mode === "warn" ||
        mode === "enforce"
      ) {
        checks.push(
          check({
            id: `spec:enforcement:${rel}`,
            category,
            status: "pass",
            title: `enforcementMode (${rel})`,
            message: `enforcementMode is "${mode}".`,
            path: rel,
          }),
        );
      }

      const hasCases =
        (Array.isArray(raw.testCases) && raw.testCases.length > 0) ||
        (Array.isArray(raw.checks) && raw.checks.length > 0);
      checks.push(
        check({
          id: `spec:checks:${rel}`,
          category,
          status: hasCases ? "pass" : "fail",
          title: `Checks or test cases (${rel})`,
          message: hasCases
            ? "At least one check or test case is defined."
            : "No checks or test cases found.",
          path: rel,
          remediation: hasCases
            ? []
            : ["Add checks[] or a non-empty testCases array."],
        }),
      );

      const hasSourceOfTruth =
        (Array.isArray(raw.policies) && raw.policies.length > 0) ||
        typeof raw.description === "string" ||
        (isPlainObject(raw.metadata) &&
          typeof raw.metadata.sourceOfTruth === "string");
      checks.push(
        check({
          id: `spec:source-of-truth:${rel}`,
          category,
          status: hasSourceOfTruth ? "pass" : "warning",
          title: `Source-of-truth fields (${rel})`,
          message: hasSourceOfTruth
            ? "Spec includes policies, description, or metadata.sourceOfTruth."
            : "No policies or description declaring customer source of truth.",
          path: rel,
          remediation: hasSourceOfTruth
            ? []
            : [
                "Add policies[] or description stating customer-defined rules and catalog.",
              ],
        }),
      );

      if (hasBudgetChecksInSpec(raw)) {
        const bg = raw.budgetGate;
        if (isPlainObject(bg)) {
          const monthly = bg.monthlyBudgetLimitUsd;
          const perRun = bg.perRunBudgetLimitUsd;
          checks.push(
            check({
              id: `budget:monthly:${rel}`,
              category: "budget",
              status:
                typeof monthly === "number" && monthly > 0 ? "pass" : "fail",
              title: `Monthly routed-call budget (${rel})`,
              message:
                typeof monthly === "number" && monthly > 0
                  ? `monthlyBudgetLimitUsd is ${monthly}.`
                  : "monthlyBudgetLimitUsd must be a positive number.",
              path: `${rel} → budgetGate.monthlyBudgetLimitUsd`,
              remediation:
                typeof monthly === "number" && monthly > 0
                  ? []
                  : [
                      "Set budgetGate.monthlyBudgetLimitUsd to a positive USD limit for routed calls.",
                    ],
            }),
          );
          if (perRun !== undefined) {
            checks.push(
              check({
                id: `budget:per-run:${rel}`,
                category: "budget",
                status:
                  typeof perRun === "number" && perRun > 0 ? "pass" : "fail",
                title: `Per-run routed-call budget (${rel})`,
                message:
                  typeof perRun === "number" && perRun > 0
                    ? `perRunBudgetLimitUsd is ${perRun}.`
                    : "perRunBudgetLimitUsd must be positive when set.",
                path: `${rel} → budgetGate.perRunBudgetLimitUsd`,
                remediation:
                  typeof perRun === "number" && perRun > 0
                    ? []
                    : ["Set perRunBudgetLimitUsd to a positive number."],
              }),
            );
          }
          if (bg.allowedProviders !== undefined) {
            checks.push(
              check({
                id: `budget:providers:${rel}`,
                category: "budget",
                status:
                  Array.isArray(bg.allowedProviders) &&
                  bg.allowedProviders.length > 0 &&
                  bg.allowedProviders.every(
                    (p) => typeof p === "string" && p.length > 0,
                  )
                    ? "pass"
                    : "fail",
                title: `allowedProviders (${rel})`,
                message: "allowedProviders is a non-empty string array.",
                path: `${rel} → budgetGate.allowedProviders`,
                remediation: [
                  "Set budgetGate.allowedProviders to provider ids used for routed calls.",
                ],
              }),
            );
          }
          if (bg.allowedModels !== undefined) {
            checks.push(
              check({
                id: `budget:models:${rel}`,
                category: "budget",
                status:
                  Array.isArray(bg.allowedModels) &&
                  bg.allowedModels.length > 0 &&
                  bg.allowedModels.every(
                    (m) => typeof m === "string" && m.length > 0,
                  )
                    ? "pass"
                    : "fail",
                title: `allowedModels (${rel})`,
                message: "allowedModels is a non-empty string array.",
                path: `${rel} → budgetGate.allowedModels`,
                remediation: [
                  "Set budgetGate.allowedModels to model ids used for routed calls.",
                ],
              }),
            );
          }
          checks.push(
            check({
              id: `budget:scope:${rel}`,
              category: "budget",
              status: mentionsRoutedScope(raw) ? "pass" : "warning",
              title: `Routed-call scope wording (${rel})`,
              message: mentionsRoutedScope(raw)
                ? "Description or metadata mentions routed-call scope."
                : "Add description noting budget applies to routed calls through the gate only.",
              path: rel,
              remediation: mentionsRoutedScope(raw)
                ? []
                : [
                    'Add description or metadata.notes: budget applies to provider calls "routed through the AI Reliability gate" only.',
                  ],
            }),
          );
        }
      }
    }
  }

  const maintenancePath = path.join(artifactsDir, "maintenance-result.json");
  const agentQaPath = path.join(artifactsDir, "agent-quality-result.json");
  const gatePath = path.join(artifactsDir, "gate-result.json");
  const ledgerPath = path.join(artifactsDir, "provider-call-ledger.jsonl");
  const budgetStatePath = path.join(artifactsDir, "budget-state.json");

  const artifactsExist = await fileExists(maintenancePath);
  if (artifactsExist) {
    checks.push(
      check({
        id: "artifacts:maintenance-result",
        category: "artifacts",
        status: "pass",
        title: "maintenance-result.json",
        message: "Maintenance run artifact is present.",
        path: path.relative(cwd, maintenancePath),
      }),
    );
  } else {
    checks.push(
      check({
        id: "artifacts:maintenance-result",
        category: "artifacts",
        status: "warning",
        title: "maintenance-result.json",
        message: "No maintenance run artifact found.",
        path: path.relative(cwd, maintenancePath),
        remediation: ["Run npm run agentqa:run to generate maintenance artifacts."],
      }),
    );
  }

  if (await fileExists(agentQaPath)) {
    checks.push(
      check({
        id: "artifacts:agent-quality-result",
        category: "artifacts",
        status: "pass",
        title: "agent-quality-result.json",
        message: "Agent QA summary artifact is present.",
        path: path.relative(cwd, agentQaPath),
      }),
    );
  } else if (artifactsExist) {
    checks.push(
      check({
        id: "artifacts:agent-quality-result",
        category: "artifacts",
        status: "warning",
        title: "agent-quality-result.json",
        message: "Agent QA summary artifact is missing (optional).",
        path: path.relative(cwd, agentQaPath),
        remediation: ["Re-run npm run demo:maintenance-gate to refresh agent-quality-result.json."],
      }),
    );
  }

  if (await fileExists(gatePath)) {
    checks.push(
      check({
        id: "artifacts:gate-result",
        category: "artifacts",
        status: "pass",
        title: "gate-result.json",
        message: "Deploy gate artifact is present.",
        path: path.relative(cwd, gatePath),
      }),
    );
  } else {
    checks.push(
      check({
        id: "artifacts:gate-result",
        category: "artifacts",
        status: "warning",
        title: "gate-result.json",
        message: "Deploy gate artifact not found.",
        path: path.relative(cwd, gatePath),
        remediation: ["Run npm run gate:release after a maintenance run."],
      }),
    );
  }

  if (await fileExists(budgetStatePath)) {
    checks.push(
      check({
        id: "pricing:budget-state",
        category: "pricing",
        status: "pass",
        title: "budget-state.json",
        message: "Routed-call budget state artifact is present.",
        path: path.relative(cwd, budgetStatePath),
      }),
    );
  } else {
    const anySpecNeedsBudget = specPaths.length > 0;
    checks.push(
      check({
        id: "pricing:budget-state",
        category: "pricing",
        status: anySpecNeedsBudget ? "warning" : "pass",
        title: "budget-state.json",
        message: "No budget-state.json in artifacts (fresh setup).",
        path: path.relative(cwd, budgetStatePath),
        remediation: [
          "Run npm run demo:maintenance-gate to initialize routed-call budget state.",
        ],
      }),
    );
  }

  if (await fileExists(ledgerPath)) {
    const raw = await readFile(ledgerPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    let malformed = 0;
    let parsed = 0;
    for (let i = 0; i < lines.length; i++) {
      try {
        JSON.parse(lines[i]!);
        parsed++;
      } catch {
        malformed++;
        checks.push(
          check({
            id: `ledger:malformed:${i}`,
            category: "ledger",
            status: "fail",
            title: "Ledger line parse",
            message: `Malformed JSONL at line ${i + 1}.`,
            path: path.relative(cwd, ledgerPath),
            remediation: ["Fix or remove the malformed line in provider-call-ledger.jsonl."],
          }),
        );
      }
    }
    if (malformed === 0) {
      checks.push(
        check({
          id: "ledger:parseable",
          category: "ledger",
          status: "pass",
          title: "provider-call-ledger.jsonl",
          message: `Ledger is parseable (${parsed} entries).`,
          path: path.relative(cwd, ledgerPath),
        }),
      );
    }
    if (parsed === 0 && malformed === 0) {
      checks.push(
        check({
          id: "ledger:empty",
          category: "ledger",
          status: "warning",
          title: "provider-call-ledger.jsonl",
          message: "Ledger file is empty (fresh setup).",
          path: path.relative(cwd, ledgerPath),
          remediation: [
            "Run npm run demo:maintenance-gate to record a sample routed provider-call in the ledger.",
          ],
        }),
      );
    }
  } else {
    checks.push(
      check({
        id: "ledger:exists",
        category: "ledger",
        status: "warning",
        title: "provider-call-ledger.jsonl",
        message: "Ledger file not found.",
        path: path.relative(cwd, ledgerPath),
        remediation: [
          "Run npm run demo:maintenance-gate to create provider-call-ledger.jsonl.",
        ],
      }),
    );
  }

  if (artifactsExist) {
    try {
      const maintenance = JSON.parse(
        await readFile(maintenancePath, "utf-8"),
      ) as MaintenanceRunResult;
      const agentQa = maintenance.agentQa;
      if (agentQa) {
        const decision = agentQa.gateDecision as GateDecision;
        if (decision === "manual_review") {
          checks.push(
            check({
              id: "evidence:manual-review",
              category: "evidence",
              status: "warning",
              title: "Manual review required",
              message: `gateDecision is manual_review (${agentQa.decisionReason}).`,
              path: path.relative(cwd, maintenancePath),
              remediation: [
                "Complete human review before treating this agent run as production-ready.",
                "manual_review is not treated as pass.",
              ],
            }),
          );
        } else if (!isPassingGateDecision(decision)) {
          checks.push(
            check({
              id: "evidence:gate-decision",
              category: "evidence",
              status: "fail",
              title: "Agent QA gate decision",
              message: `gateDecision is ${decision}.`,
              path: path.relative(cwd, maintenancePath),
              remediation: agentQa.remediation.length
                ? agentQa.remediation
                : ["Remediate blocking Agent QA findings in the maintenance run."],
            }),
          );
        } else {
          checks.push(
            check({
              id: "evidence:gate-decision",
              category: "evidence",
              status: "pass",
              title: "Agent QA gate decision",
              message: "gateDecision is pass.",
              path: path.relative(cwd, maintenancePath),
            }),
          );
        }

        const ev = agentQa.evidenceCompleteness;
        if (ev) {
          const evidenceFields: {
            key: keyof typeof ev;
            label: string;
            remediation: string;
          }[] = [
            {
              key: "outputCaptured",
              label: "output captured",
              remediation: REMEDIATION_OUTPUT,
            },
            {
              key: "toolTraceCaptured",
              label: "tool trace captured",
              remediation: REMEDIATION_TOOL,
            },
            {
              key: "actionTraceCaptured",
              label: "action trace captured",
              remediation:
                "Capture action trace artifacts for steps with forbidden-action checks.",
            },
            {
              key: "budgetStateLoaded",
              label: "budget state loaded",
              remediation:
                "Load routed-call budget state before evaluating provider calls.",
            },
            {
              key: "pricingConfigLoaded",
              label: "pricing config loaded",
              remediation:
                "Configure provider/model pricing for routed calls or set pricingKnown appropriately.",
            },
            {
              key: "ledgerWriteSucceeded",
              label: "ledger write succeeded",
              remediation:
                "Fix provider-call ledger persistence; ledger write failures must not pass.",
            },
          ];
          for (const field of evidenceFields) {
            const ok = ev[field.key];
            const severity =
              ok === false && agentQa.enforcementMode === "enforce"
                ? "fail"
                : ok === false
                  ? "warning"
                  : "pass";
            checks.push(
              check({
                id: `evidence:${field.key}`,
                category: "evidence",
                status: severity,
                title: `Evidence: ${field.label}`,
                message: ok
                  ? `${field.label} is complete.`
                  : `Missing: ${field.label}.`,
                path: path.relative(cwd, maintenancePath),
                remediation: ok ? [] : [field.remediation],
              }),
            );
          }
        }
      } else {
        checks.push(
          check({
            id: "evidence:agent-qa-missing",
            category: "evidence",
            status: "warning",
            title: "agentQa on maintenance result",
            message: "maintenance-result.json has no agentQa block (legacy run).",
            path: path.relative(cwd, maintenancePath),
            remediation: ["Re-run npm run demo:maintenance-gate with the current engine."],
          }),
        );
      }
    } catch {
      checks.push(
        check({
          id: "artifacts:maintenance-parse",
          category: "artifacts",
          status: "fail",
          title: "maintenance-result.json",
          message: "Could not parse maintenance-result.json.",
          path: path.relative(cwd, maintenancePath),
          remediation: ["Regenerate with npm run demo:maintenance-gate."],
        }),
      );
    }
  }

  if (await fileExists(gatePath)) {
    try {
      const gate = JSON.parse(await readFile(gatePath, "utf-8")) as {
        deployAllowed?: boolean;
        exitCode?: number;
        agentQaGateDecision?: string;
        requiresHumanReview?: boolean;
      };
      const decision = gate.agentQaGateDecision;
      if (decision === "manual_review") {
        checks.push(
          check({
            id: "gate:manual-review",
            category: "gate",
            status: "warning",
            title: "Deploy gate manual review",
            message: "agentQaGateDecision is manual_review; deploy is not a pass.",
            path: path.relative(cwd, gatePath),
            remediation: ["Complete human review before deploy."],
          }),
        );
      } else if (decision === "block" || gate.deployAllowed === false) {
        checks.push(
          check({
            id: "gate:blocked",
            category: "gate",
            status: "fail",
            title: "Deploy gate blocked",
            message: `deployAllowed=${String(gate.deployAllowed)}, exitCode=${String(gate.exitCode)}.`,
            path: path.relative(cwd, gatePath),
            remediation: ["Remediate blocking maintenance findings, then re-run gate:release."],
          }),
        );
      } else if (gate.exitCode === 2) {
        checks.push(
          check({
            id: "gate:misconfigured",
            category: "gate",
            status: "fail",
            title: "Deploy gate misconfigured",
            message: "exitCode 2 indicates misconfigured maintenance setup.",
            path: path.relative(cwd, gatePath),
            remediation: ["Fix spec or budget configuration, then re-run maintenance gate."],
          }),
        );
      } else if (gate.exitCode === 1) {
        checks.push(
          check({
            id: "gate:failed",
            category: "gate",
            status: "fail",
            title: "Deploy gate failed",
            message: "exitCode 1 indicates blocking maintenance failures.",
            path: path.relative(cwd, gatePath),
            remediation: ["Remediate blocking failures before deploy."],
          }),
        );
      } else {
        checks.push(
          check({
            id: "gate:deploy",
            category: "gate",
            status: "pass",
            title: "Deploy gate",
            message: `deployAllowed=${String(gate.deployAllowed)}, exitCode=${String(gate.exitCode ?? 0)} (0 = allowed for healthy/at-risk).`,
            path: path.relative(cwd, gatePath),
          }),
        );
      }
      if (gate.requiresHumanReview) {
        checks.push(
          check({
            id: "gate:requires-human-review",
            category: "gate",
            status: "warning",
            title: "requiresHumanReview",
            message: "Gate result flags requiresHumanReview=true.",
            path: path.relative(cwd, gatePath),
            remediation: ["Complete human review before production deploy."],
          }),
        );
      }
    } catch {
      checks.push(
        check({
          id: "gate:parse",
          category: "gate",
          status: "fail",
          title: "gate-result.json",
          message: "Could not parse gate-result.json.",
          path: path.relative(cwd, gatePath),
          remediation: ["Run npm run gate:release after a valid maintenance run."],
        }),
      );
    }
  }

  const bundle = await loadArtifactBundle(artifactsDir);
  const reconcile = reconcileAgentQaArtifacts(bundle);

  for (const issue of reconcile.issues) {
    checks.push(
      check({
        id: `consistency:${issue.code}`,
        category: "artifacts",
        status: issue.severity === "error" ? "fail" : "warning",
        title: issue.code.replace(/_/g, " "),
        message: issue.message,
        path: issue.path,
        remediation: issue.remediation,
      }),
    );
  }

  if (bundle.maintenance) {
    checks.push(
      check({
        id: "run:summary",
        category: "artifacts",
        status: "pass",
        title: "Run summary",
        message: `runId=${bundle.maintenance.runId} specId=${bundle.maintenance.specId} env=${bundle.maintenance.environment} workflow=${bundle.maintenance.workflowName}`,
        path: path.relative(cwd, path.join(artifactsDir, "maintenance-result.json")),
      }),
    );
  }

  let status = deriveOverallStatus(checks);
  if (reconcile.staleGate || !reconcile.ok) {
    if (status === "ready") status = reconcile.staleGate ? "blocked" : "warning";
    if (reconcile.issues.some((i) => i.severity === "error") && status !== "blocked") {
      status = "blocked";
    }
  }

  const summary = buildSummary(checks);
  const nextActions = buildNextActions(checks, status);

  const runSummary = bundle.maintenance
    ? {
        runId: bundle.maintenance.runId,
        specId: bundle.maintenance.specId,
        environment: bundle.maintenance.environment,
        workflowName: bundle.maintenance.workflowName,
        gateDecision: bundle.maintenance.agentQa?.gateDecision,
      }
    : bundle.agentQuality
      ? {
          runId: bundle.agentQuality.runId,
          specId: bundle.agentQuality.specId,
          environment: bundle.agentQuality.environment,
          workflowName: bundle.agentQuality.workflowName,
          gateDecision: bundle.agentQuality.gateDecision,
        }
      : undefined;

  const result: DoctorResult = {
    status,
    checks,
    summary,
    nextActions,
    evaluatedAt,
  };

  if (input.writeArtifact) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(artifactsDir, { recursive: true });
    const artifact = wrapDoctorResult(result, runSummary);
    await writeFile(
      path.join(artifactsDir, "doctor-result.json"),
      JSON.stringify(artifact, null, 2),
      "utf-8",
    );
  }

  return result;
}

const REMEDIATION_OUTPUT =
  "Capture agent output and attach it to the maintenance run observation.";
const REMEDIATION_TOOL =
  "Provide a tool trace artifact or route the agent step through the AI Reliability wrapper.";

export function formatDoctorReport(result: DoctorResult): string {
  const lines: string[] = [];
  const header = result.status.toUpperCase();
  lines.push(`AGENT QA FIREWALL DOCTOR: ${header}`);
  lines.push("");
  lines.push("Summary:");
  lines.push(`- ${result.summary}`);

  const blocking = result.checks.filter((c) => c.status === "fail");
  const warnings = result.checks.filter((c) => c.status === "warning");

  if (blocking.length > 0) {
    lines.push("");
    lines.push("Blocking issues:");
    for (const c of blocking) {
      lines.push(`- ${c.title}`);
      lines.push(`  ${c.message}`);
      for (const r of c.remediation) {
        lines.push(`  Fix: ${r}`);
      }
    }
  }

  if (warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const c of warnings) {
      lines.push(`- ${c.title}`);
      lines.push(`  ${c.message}`);
      for (const r of c.remediation) {
        lines.push(`  Fix: ${r}`);
      }
    }
  }

  if (result.nextActions.length > 0) {
    lines.push("");
    lines.push("Next actions:");
    for (const a of result.nextActions) {
      lines.push(`- ${a}`);
    }
  }

  return lines.join("\n");
}

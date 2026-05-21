import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  applyBudgetUsage,
  assertProviderCallAllowed,
  type BudgetState,
} from "./budget-gate";
import {
  buildAgentQualityArtifact,
  buildBudgetStateArtifact,
  wrapMaintenanceResult,
} from "./agent-qa-artifacts";
import { validateAgentQaSpec } from "./agent-qa-spec-validator";
import {
  buildRoutedCallFromObservations,
  loadObservationsForAgentQaRun,
  mapObservationEvidenceMetadata,
  mapObservationsToMaintenanceInput,
  type AgentQaObservationFile,
  type AgentQaObservationValidationIssue,
} from "./agent-qa-observations";
import { parseEvalSpec, type EvalSpec, type EvalSpecTestCase } from "./eval-spec";
import type { ObservationArtifactMeta } from "./agent-qa-artifacts";
import type { EnforcementMode, GateDecision } from "./maintenance-result";
import {
  runMaintenanceCheck,
  type RoutedProviderCallAttempt,
  type SimulatedCaseObservation,
} from "./maintenance-check";
import {
  appendProviderCallLedgerEntry,
  writeProviderCallLedger,
  type ProviderCallLedgerEntry,
} from "./provider-call-ledger";

export const DEFAULT_AGENTQA_SPEC_PATH = path.join(
  "examples",
  "eval-specs",
  "support-agent-qa.spec.json",
);

export const DEFAULT_AGENTQA_ARTIFACTS_DIR = path.join(
  "deliverables",
  "maintenance",
);

export type AgentQaRunLabel =
  | "PASS"
  | "BLOCK"
  | "MANUAL REVIEW"
  | "INVALID"
  | "INVALID OBSERVATIONS";

export interface AgentQaRunArgv {
  specPath: string;
  artifactsDir: string;
  observationsPath?: string;
}

export interface AgentQaRunSuccess {
  ok: true;
  label: Exclude<AgentQaRunLabel, "INVALID">;
  exitCode: number;
  runId: string;
  specId: string;
  workflowName: string;
  environment: string;
  enforcementMode: EnforcementMode;
  gateDecision: GateDecision;
  requiresHumanReview: boolean;
  decisionReason: string;
  checksRun: number;
  checksPassed: number;
  checksFailed: number;
  evidenceCompleteness: NonNullable<
    import("./maintenance-result").MaintenanceRunResult["agentQa"]
  >["evidenceCompleteness"];
  checkCounts: NonNullable<
    import("./maintenance-result").MaintenanceRunResult["agentQa"]
  >["checkCounts"];
  remediation: string[];
  observationsUsed: boolean;
  observationPath?: string;
  observationId?: string;
  artifactPaths: {
    maintenance: string;
    agentQuality: string;
    budgetState: string;
    ledger: string;
  };
}

export interface AgentQaRunInvalid {
  ok: false;
  label: "INVALID";
  exitCode: 1;
  specPath: string;
  reason: "missing_file" | "invalid_json" | "invalid_spec";
  message: string;
  errors: Array<{ code: string; path: string; message: string; remediation: string }>;
}

export interface AgentQaRunInvalidObservations {
  ok: false;
  label: "INVALID OBSERVATIONS";
  exitCode: 1;
  specPath: string;
  observationsPath: string;
  message: string;
  errors: AgentQaObservationValidationIssue[];
  warnings: AgentQaObservationValidationIssue[];
  remediation: string[];
}

export type AgentQaRunResult =
  | AgentQaRunSuccess
  | AgentQaRunInvalid
  | AgentQaRunInvalidObservations;

export function parseAgentQaRunArgv(argv: string[]): AgentQaRunArgv {
  let specPath = DEFAULT_AGENTQA_SPEC_PATH;
  let artifactsDir = DEFAULT_AGENTQA_ARTIFACTS_DIR;
  let observationsPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--spec" && argv[i + 1]) {
      specPath = argv[++i]!;
      continue;
    }
    if (arg === "--artifacts" && argv[i + 1]) {
      artifactsDir = argv[++i]!;
      continue;
    }
    if (arg === "--observations" && argv[i + 1]) {
      observationsPath = argv[++i]!;
      continue;
    }
    if (!arg.startsWith("-")) {
      specPath = arg;
    }
  }

  return { specPath, artifactsDir, observationsPath };
}

/** Build spec-conformant simulated observations for a customer self-serve run. */
export function buildSpecConformantObservations(
  spec: EvalSpec,
): Record<string, SimulatedCaseObservation> {
  const observations: Record<string, SimulatedCaseObservation> = {};

  for (const tc of spec.testCases) {
    observations[tc.id] = observationForTestCase(tc, spec);
  }

  return observations;
}

function observationForTestCase(
  tc: EvalSpecTestCase,
  spec: EvalSpec,
): SimulatedCaseObservation {
  const toolCalls = [
    ...(tc.requiredToolCalls ?? []),
    ...(spec.requiredToolCalls ?? []).filter(
      (t) => !(tc.requiredToolCalls ?? []).includes(t),
    ),
  ];
  const uniqueTools = [...new Set(toolCalls)];

  let output = tc.expectedOutput?.trim() ?? "";
  if (!output.length) {
    output = `Response aligned with spec: ${tc.expectedBehavior}`;
  }
  if (tc.requiredEvidence?.length) {
    for (const fragment of tc.requiredEvidence) {
      if (!output.toLowerCase().includes(fragment.toLowerCase())) {
        output = `${output} ${fragment}`.trim();
      }
    }
  }

  return {
    output,
    toolCalls: uniqueTools.length > 0 ? uniqueTools : [],
    actions: [],
  };
}

function defaultBudgetState(): BudgetState {
  return {
    planId: "starter",
    creditsRemaining: 500,
    budgetRemainingUsd: 400,
    creditsUsed: 0,
    budgetUsedUsd: 0,
  };
}

function buildRoutedCall(
  runId: string,
  spec: EvalSpec,
  budget: BudgetState,
): RoutedProviderCallAttempt | undefined {
  const gate = spec.budgetGate;
  if (!gate) return undefined;

  const provider = gate.allowedProviders?.[0] ?? "openai";
  const model = gate.allowedModels?.[0] ?? "gpt-4.1-mini";
  const monthlyCap = gate.monthlyBudgetLimitUsd;

  return {
    callId: `call-${runId}`,
    planId: budget.planId,
    subscriptionActive: true,
    creditsRemaining: budget.creditsRemaining,
    monthlyBudgetRemainingUsd: Math.min(budget.budgetRemainingUsd, monthlyCap),
    currentRunSpendUsd: 0,
    estimatedCreditsRequired: 1,
    estimatedCostUsd: 0.15,
    provider,
    model,
    pricingKnown: true,
    budgetStatePresent: true,
    estimatedInputTokens: 300,
    estimatedOutputTokens: 100,
  };
}

function labelForGateDecision(decision: GateDecision): Exclude<AgentQaRunLabel, "INVALID"> {
  if (decision === "pass") return "PASS";
  if (decision === "manual_review") return "MANUAL REVIEW";
  return "BLOCK";
}

function exitCodeForRun(
  gateDecision: GateDecision,
  maintenanceStatus: string,
): number {
  if (maintenanceStatus === "misconfigured") return 2;
  if (gateDecision === "pass") return 0;
  return 1;
}

export async function loadSpecForAgentQaRun(
  specPath: string,
  cwd: string = process.cwd(),
): Promise<
  | { ok: true; spec: EvalSpec; resolvedPath: string }
  | { ok: false; result: AgentQaRunInvalid }
> {
  const resolvedPath = path.resolve(cwd, specPath);

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolvedPath, "utf-8")) as unknown;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code =
      (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing_file" : "invalid_json";
    return {
      ok: false,
      result: {
        ok: false,
        label: "INVALID",
        exitCode: 1,
        specPath: resolvedPath,
        reason: code,
        message:
          code === "missing_file"
            ? `Spec file not found: ${resolvedPath}`
            : `Could not parse spec JSON: ${msg}`,
        errors: [
          {
            code,
            path: resolvedPath,
            message:
              code === "missing_file"
                ? "Spec file does not exist."
                : `Invalid JSON: ${msg}`,
            remediation:
              code === "missing_file"
                ? "Provide a valid path to your Agent QA spec JSON file."
                : "Fix JSON syntax in the spec file.",
          },
        ],
      },
    };
  }

  const validation = validateAgentQaSpec(raw);
  if (!validation.valid) {
    return {
      ok: false,
      result: {
        ok: false,
        label: "INVALID",
        exitCode: 1,
        specPath: resolvedPath,
        reason: "invalid_spec",
        message: "Agent QA spec validation failed.",
        errors: validation.errors.map((err) => ({
          code: err.code,
          path: err.path,
          message: err.message,
          remediation: err.remediation,
        })),
      },
    };
  }

  return { ok: true, spec: parseEvalSpec(raw), resolvedPath };
}

export async function runAgentQaFirewall(input: {
  specPath?: string;
  artifactsDir?: string;
  observationsPath?: string;
  cwd?: string;
}): Promise<AgentQaRunResult> {
  const cwd = input.cwd ?? process.cwd();
  const specPath = input.specPath ?? DEFAULT_AGENTQA_SPEC_PATH;
  const observationsPath = input.observationsPath;
  const resolvedArtifacts = path.resolve(
    cwd,
    input.artifactsDir ?? DEFAULT_AGENTQA_ARTIFACTS_DIR,
  );
  const loaded = await loadSpecForAgentQaRun(specPath, cwd);
  if (!loaded.ok) return loaded.result;

  const spec = loaded.spec;
  let observationFile: AgentQaObservationFile | undefined;
  let observationResolvedPath: string | undefined;
  let observationMeta: ObservationArtifactMeta | undefined;
  const observationsUsed = Boolean(observationsPath);

  if (observationsPath) {
    const obsLoaded = await loadObservationsForAgentQaRun(observationsPath, spec, cwd);
    if (!obsLoaded.ok) {
      return {
        ok: false,
        label: "INVALID OBSERVATIONS",
        exitCode: 1,
        specPath: loaded.resolvedPath,
        observationsPath: obsLoaded.resolvedPath,
        message: obsLoaded.message,
        errors: obsLoaded.errors,
        warnings: obsLoaded.warnings,
        remediation: obsLoaded.remediation,
      };
    }
    observationFile = obsLoaded.data;
    observationResolvedPath = obsLoaded.resolvedPath;
    observationMeta = {
      observationId: observationFile.observationId,
      observationSource: "agentqa:run:observations",
      observationPath: observationResolvedPath,
      observedAt: observationFile.observedAt,
    };
  }

  const runId = `maint-${randomUUID()}`;
  const now = new Date().toISOString();
  const maintenanceObservations = observationFile
    ? mapObservationsToMaintenanceInput(spec, observationFile)
    : buildSpecConformantObservations(spec);
  const enforcementMode =
    (spec as { enforcementMode?: EnforcementMode }).enforcementMode ?? "enforce";

  let budget = defaultBudgetState();
  let ledgerWriteSucceeded = true;
  const evidenceOverride = observationFile
    ? mapObservationEvidenceMetadata(observationFile)
    : undefined;

  const maintenancePath = path.join(resolvedArtifacts, "maintenance-result.json");
  const agentQualityPath = path.join(resolvedArtifacts, "agent-quality-result.json");
  const budgetStatePath = path.join(resolvedArtifacts, "budget-state.json");
  const ledgerPath = path.join(resolvedArtifacts, "provider-call-ledger.jsonl");

  await mkdir(resolvedArtifacts, { recursive: true });
  await writeProviderCallLedger(ledgerPath, []);

  const routedCall = observationFile
    ? buildRoutedCallFromObservations(runId, spec, budget, observationFile) ??
      buildRoutedCall(runId, spec, budget)
    : buildRoutedCall(runId, spec, budget);

  const artifactSource = observationsUsed
    ? "agentqa:run:observations"
    : "agentqa:run";

  const result = runMaintenanceCheck({
    runId,
    spec,
    observations: maintenanceObservations,
    routedCall,
    enforcementMode,
    ledgerWriteSucceeded,
    evidenceCompleteness: evidenceOverride,
    generatedAt: now,
  });

  if (routedCall) {
    const gate = assertProviderCallAllowed({
      planId: routedCall.planId,
      subscriptionActive: routedCall.subscriptionActive,
      creditsRemaining: routedCall.creditsRemaining,
      monthlyBudgetRemainingUsd: Math.min(
        routedCall.monthlyBudgetRemainingUsd,
        spec.budgetGate.monthlyBudgetLimitUsd,
      ),
      currentRunSpendUsd: routedCall.currentRunSpendUsd,
      estimatedCreditsRequired: routedCall.estimatedCreditsRequired,
      estimatedCostUsd: routedCall.estimatedCostUsd,
      provider: routedCall.provider,
      model: routedCall.model,
      budgetGate: spec.budgetGate,
      pricingKnown: routedCall.pricingKnown,
      budgetStatePresent: routedCall.budgetStatePresent,
    });

    const baseEntry: Omit<
      ProviderCallLedgerEntry,
      "status" | "blockReason" | "actualCostUsd" | "actualInputTokens" | "actualOutputTokens"
    > = {
      callId: routedCall.callId,
      runId,
      specId: spec.specId,
      provider: routedCall.provider,
      model: routedCall.model,
      estimatedInputTokens: routedCall.estimatedInputTokens,
      estimatedOutputTokens: routedCall.estimatedOutputTokens,
      estimatedCostUsd: routedCall.estimatedCostUsd,
      createdAt: now,
    };

    try {
      if (gate.decision === "allowed") {
        await appendProviderCallLedgerEntry(ledgerPath, {
          ...baseEntry,
          status: "completed",
          actualInputTokens: routedCall.estimatedInputTokens,
          actualOutputTokens: routedCall.estimatedOutputTokens,
          actualCostUsd: routedCall.estimatedCostUsd,
        });
        budget = applyBudgetUsage(budget, {
          creditsUsed: routedCall.estimatedCreditsRequired,
          actualCostUsd: routedCall.estimatedCostUsd,
        });
      } else if (gate.decision === "blocked") {
        await appendProviderCallLedgerEntry(ledgerPath, {
          ...baseEntry,
          status: "blocked",
          blockReason: gate.reasonCode,
          actualCostUsd: 0,
        });
      } else {
        await appendProviderCallLedgerEntry(ledgerPath, {
          ...baseEntry,
          status: "failed",
          blockReason: gate.reasonCode,
          actualCostUsd: 0,
        });
      }
    } catch {
      ledgerWriteSucceeded = false;
    }
  }

  const agentQa = result.agentQa;
  if (!agentQa) {
    return {
      ok: false,
      label: "INVALID",
      exitCode: 1,
      specPath: loaded.resolvedPath,
      reason: "invalid_spec",
      message: "Maintenance run did not produce an agentQa summary.",
      errors: [
        {
          code: "missing_agent_qa",
          path: loaded.resolvedPath,
          message: "Engine returned no agentQa block.",
          remediation:
            "Report this issue; the Agent QA engine should always emit agentQa.",
        },
      ],
    };
  }
  const gateDecision = agentQa.gateDecision;

  const maintenanceArtifact = wrapMaintenanceResult(
    result,
    resolvedArtifacts,
    artifactSource,
    observationMeta,
  );
  const agentQualityPayload = buildAgentQualityArtifact({
    result,
    artifactsDir: resolvedArtifacts,
    source: artifactSource,
    observation: observationMeta,
  });
  const budgetArtifact = buildBudgetStateArtifact(budget, {
    runId,
    specId: spec.specId,
    generatedAt: now,
    source: artifactSource,
  });

  await writeFile(maintenancePath, JSON.stringify(maintenanceArtifact, null, 2), "utf-8");
  await writeFile(agentQualityPath, JSON.stringify(agentQualityPayload, null, 2), "utf-8");
  await writeFile(budgetStatePath, JSON.stringify(budgetArtifact, null, 2), "utf-8");

  return {
    ok: true,
    label: labelForGateDecision(gateDecision),
    exitCode: exitCodeForRun(gateDecision, result.status),
    runId,
    specId: spec.specId,
    workflowName: spec.workflowName,
    environment: spec.environment,
    enforcementMode: agentQa.enforcementMode,
    gateDecision,
    requiresHumanReview: agentQa.requiresHumanReview,
    decisionReason: agentQa.decisionReason,
    checksRun: result.checksRun,
    checksPassed: result.checksPassed,
    checksFailed: result.checksFailed,
    evidenceCompleteness: agentQa.evidenceCompleteness,
    checkCounts: agentQa.checkCounts,
    remediation: agentQa.remediation,
    observationsUsed,
    observationPath: observationResolvedPath,
    observationId: observationFile?.observationId,
    artifactPaths: {
      maintenance: maintenancePath,
      agentQuality: agentQualityPath,
      budgetState: budgetStatePath,
      ledger: ledgerPath,
    },
  };
}

export function formatAgentQaRunReport(
  result: AgentQaRunResult,
  opts?: { specPath?: string; observationsPath?: string },
): string {
  if (!result.ok) {
    const invalidObs = result.label === "INVALID OBSERVATIONS";
    const lines = [
      invalidObs
        ? "AGENT QA FIREWALL RUN: INVALID OBSERVATIONS"
        : "AGENT QA FIREWALL RUN: INVALID",
      "",
      `spec: ${result.specPath}`,
    ];
    if (invalidObs) {
      lines.push(`observations: ${result.observationsPath}`);
    } else {
      lines.push(`reason: ${result.reason}`);
    }
    lines.push(result.message, "");
    if (result.errors.length > 0) {
      lines.push("Errors:");
      for (const err of result.errors) {
        lines.push(`  [${err.code}] ${err.path}: ${err.message}`);
        lines.push(`    remediation: ${err.remediation}`);
      }
    }
    if (invalidObs && result.warnings.length > 0) {
      lines.push("Warnings:");
      for (const warn of result.warnings) {
        lines.push(`  [${warn.code}] ${warn.path}: ${warn.message}`);
      }
    }
    if ("remediation" in result && result.remediation.length > 0) {
      lines.push("", "Remediation:");
      for (const r of result.remediation) {
        lines.push(`  - ${r}`);
      }
    }
    lines.push("");
    lines.push("Next commands:");
    lines.push("  npm run validate:spec");
    lines.push(
      invalidObs
        ? "  Fix the observation file, then npm run agentqa:run"
        : "  Fix the spec, then npm run agentqa:run",
    );
    return lines.join("\n");
  }

  const lines = [
    `AGENT QA FIREWALL RUN: ${result.label}`,
    "",
    `specId: ${result.specId}`,
    `workflow: ${result.workflowName}`,
    `environment: ${result.environment}`,
    `enforcementMode: ${result.enforcementMode}`,
    `gateDecision: ${result.gateDecision}`,
    `requiresHumanReview: ${result.requiresHumanReview}`,
    `decisionReason: ${result.decisionReason}`,
    "",
    `checks: ${result.checksRun} run, ${result.checksPassed} passed, ${result.checksFailed} failed`,
    "evidence completeness:",
    `  outputCaptured: ${result.evidenceCompleteness.outputCaptured}`,
    `  toolTraceCaptured: ${result.evidenceCompleteness.toolTraceCaptured}`,
    `  actionTraceCaptured: ${result.evidenceCompleteness.actionTraceCaptured}`,
    `  budgetStateLoaded: ${result.evidenceCompleteness.budgetStateLoaded}`,
    `  pricingConfigLoaded: ${result.evidenceCompleteness.pricingConfigLoaded}`,
    `  ledgerWriteSucceeded: ${result.evidenceCompleteness.ledgerWriteSucceeded}`,
    "",
    "check counts:",
    `  answer: ${result.checkCounts.answer.total} total, ${result.checkCounts.answer.passed} passed, ${result.checkCounts.answer.failed} failed`,
    `  tool_call: ${result.checkCounts.tool_call.total} total, ${result.checkCounts.tool_call.passed} passed, ${result.checkCounts.tool_call.failed} failed`,
    `  action: ${result.checkCounts.action.total} total, ${result.checkCounts.action.passed} passed, ${result.checkCounts.action.failed} failed`,
    `  budget: ${result.checkCounts.budget.total} total, ${result.checkCounts.budget.passed} passed, ${result.checkCounts.budget.failed} failed`,
  ];

  if (result.remediation.length > 0) {
    lines.push("", "remediation:");
    for (const r of result.remediation) {
      lines.push(`  - ${r}`);
    }
  }

  lines.push(
    "",
    `observationsUsed: ${result.observationsUsed}`,
  );
  if (result.observationsUsed && result.observationPath) {
    lines.push(`observations: ${result.observationPath}`);
    if (result.observationId) {
      lines.push(`observationId: ${result.observationId}`);
    }
  } else if (opts?.observationsPath) {
    lines.push(`observations: ${opts.observationsPath}`);
  }
  if (opts?.specPath) {
    lines.push(`spec: ${opts.specPath}`);
  }
  lines.push("", "artifacts:");
  lines.push(`  ${result.artifactPaths.maintenance}`);
  lines.push(`  ${result.artifactPaths.agentQuality}`);
  lines.push(`  ${result.artifactPaths.budgetState}`);
  lines.push(`  ${result.artifactPaths.ledger}`);
  lines.push("", "Next commands:");
  lines.push("  npm run gate:release");
  lines.push("  npm run doctor");

  return lines.join("\n");
}

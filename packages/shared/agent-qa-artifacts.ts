import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { gateDecisionAllowsDeploy, isPassingGateDecision } from "./agent-qa";
import type { BudgetState } from "./budget-gate";
import type { DoctorResult } from "./agent-qa-doctor";
import type {
  AgentQaSummary,
  EnforcementMode,
  EvidenceCompleteness,
  GateDecision,
  MaintenanceRunResult,
} from "./maintenance-result";
import type { ProviderCallLedgerEntry } from "./provider-call-ledger";

export const ARTIFACT_SCHEMA_VERSION = 1;

export type ArtifactType =
  | "maintenance_result"
  | "agent_quality_result"
  | "budget_state"
  | "provider_call_ledger"
  | "gate_result"
  | "doctor_result";

export interface ArtifactEnvelopeBase {
  artifactType: ArtifactType;
  schemaVersion: number;
  generatedAt: string;
  runId?: string;
  source?: string;
}

export interface RelatedArtifacts {
  maintenanceResult?: string;
  agentQualityResult?: string;
  gateResult?: string;
  budgetState?: string;
  providerCallLedger?: string;
  doctorResult?: string;
}

export interface MaintenanceResultArtifact extends MaintenanceRunResult {
  artifactType: "maintenance_result";
  schemaVersion: number;
  source?: string;
  relatedArtifacts?: RelatedArtifacts;
}

export interface AgentQualityResultArtifact extends ArtifactEnvelopeBase {
  artifactType: "agent_quality_result";
  runId: string;
  specId: string;
  specVersion: number;
  workflowName: string;
  environment: string;
  enforcementMode: EnforcementMode;
  gateDecision: GateDecision;
  requiresHumanReview: boolean;
  decisionReason: string;
  confidence?: string;
  remediation: string[];
  evidenceCompleteness?: EvidenceCompleteness;
  wouldBlockCount?: number;
  checkCounts?: AgentQaSummary["checkCounts"];
  maintenanceStatus: string;
  scenario?: string;
  relatedArtifacts?: RelatedArtifacts;
}

export interface BudgetStateArtifact extends BudgetState, ArtifactEnvelopeBase {
  artifactType: "budget_state";
  runId?: string;
  specId?: string;
}

export interface GateResultArtifact extends ArtifactEnvelopeBase {
  artifactType: "gate_result";
  runId: string;
  specId: string;
  specVersion: number;
  workflowName: string;
  environment: string;
  sourceMaintenancePath: string;
  sourceAgentQualityPath?: string;
  maintenanceStatus: string;
  agentQaGateDecision: GateDecision | null;
  enforcementMode: EnforcementMode;
  requiresHumanReview: boolean;
  decisionReason: string;
  remediation: string[];
  blockingFailures: number;
  misconfiguredCount: number;
  staleArtifactWarning?: string;
  deployAllowed: boolean;
  exitCode: number;
  relatedArtifacts?: RelatedArtifacts;
}

export interface DoctorResultArtifact extends DoctorResult, ArtifactEnvelopeBase {
  artifactType: "doctor_result";
  schemaVersion: number;
  runSummary?: {
    runId?: string;
    specId?: string;
    environment?: string;
    workflowName?: string;
    gateDecision?: string;
  };
}

export interface ArtifactReadError {
  path: string;
  code: string;
  message: string;
}

export interface ArtifactConsistencyIssue {
  code: string;
  message: string;
  path?: string;
  remediation: string[];
  severity: "error" | "warning";
}

export interface ArtifactBundle {
  dir: string;
  maintenance?: MaintenanceResultArtifact;
  agentQuality?: AgentQualityResultArtifact;
  gate?: GateResultArtifact;
  budgetState?: BudgetStateArtifact;
  ledger: ProviderCallLedgerEntry[];
  doctor?: DoctorResultArtifact;
  ledgerMalformedLines: number[];
  readErrors: ArtifactReadError[];
}

export interface ReconcileAgentQaArtifactsResult {
  ok: boolean;
  issues: ArtifactConsistencyIssue[];
  bundle: ArtifactBundle;
  staleGate: boolean;
  readErrors: ArtifactReadError[];
}

export const DEFAULT_ARTIFACTS_DIR = path.join("deliverables", "maintenance");

export const ARTIFACT_FILES = {
  maintenance: "maintenance-result.json",
  agentQuality: "agent-quality-result.json",
  budgetState: "budget-state.json",
  ledger: "provider-call-ledger.jsonl",
  gate: "gate-result.json",
  doctor: "doctor-result.json",
} as const;

export function artifactPath(dir: string, key: keyof typeof ARTIFACT_FILES): string {
  return path.join(dir, ARTIFACT_FILES[key]);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonArtifact<T>(
  filePath: string,
): Promise<{ ok: true; data: T } | { ok: false; error: ArtifactReadError }> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as T;
    return { ok: true, data };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.includes("JSON") || msg.includes("Unexpected") ? "malformed_json" : "read_failed";
    return {
      ok: false,
      error: { path: filePath, code, message: msg },
    };
  }
}

export async function readJsonlLedger(
  filePath: string,
): Promise<{
  entries: ProviderCallLedgerEntry[];
  malformedLineNumbers: number[];
  error?: ArtifactReadError;
}> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const entries: ProviderCallLedgerEntry[] = [];
    const malformedLineNumbers: number[] = [];
    lines.forEach((line, idx) => {
      try {
        entries.push(JSON.parse(line) as ProviderCallLedgerEntry);
      } catch {
        malformedLineNumbers.push(idx + 1);
      }
    });
    return { entries, malformedLineNumbers };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      entries: [],
      malformedLineNumbers: [],
      error: { path: filePath, code: "read_failed", message: msg },
    };
  }
}

export async function loadArtifactBundle(
  artifactsDir: string = DEFAULT_ARTIFACTS_DIR,
): Promise<ArtifactBundle> {
  const dir = path.resolve(artifactsDir);
  const bundle: ArtifactBundle = {
    dir,
    ledger: [],
    ledgerMalformedLines: [],
    readErrors: [],
  };

  const maintenancePath = artifactPath(dir, "maintenance");
  if (await fileExists(maintenancePath)) {
    const r = await readJsonArtifact<MaintenanceResultArtifact>(maintenancePath);
    if (r.ok) bundle.maintenance = r.data;
    else bundle.readErrors.push(r.error);
  }

  const agentPath = artifactPath(dir, "agentQuality");
  if (await fileExists(agentPath)) {
    const r = await readJsonArtifact<AgentQualityResultArtifact>(agentPath);
    if (r.ok) bundle.agentQuality = r.data;
    else bundle.readErrors.push(r.error);
  }

  const gatePath = artifactPath(dir, "gate");
  if (await fileExists(gatePath)) {
    const r = await readJsonArtifact<GateResultArtifact>(gatePath);
    if (r.ok) bundle.gate = r.data;
    else bundle.readErrors.push(r.error);
  }

  const budgetPath = artifactPath(dir, "budgetState");
  if (await fileExists(budgetPath)) {
    const r = await readJsonArtifact<BudgetStateArtifact>(budgetPath);
    if (r.ok) bundle.budgetState = r.data;
    else bundle.readErrors.push(r.error);
  }

  const ledgerPath = artifactPath(dir, "ledger");
  if (await fileExists(ledgerPath)) {
    const ledger = await readJsonlLedger(ledgerPath);
    bundle.ledger = ledger.entries;
    bundle.ledgerMalformedLines = ledger.malformedLineNumbers;
    if (ledger.error) bundle.readErrors.push(ledger.error);
  }

  const doctorPath = artifactPath(dir, "doctor");
  if (await fileExists(doctorPath)) {
    const r = await readJsonArtifact<DoctorResultArtifact>(doctorPath);
    if (r.ok) bundle.doctor = r.data;
    else bundle.readErrors.push(r.error);
  }

  return bundle;
}

export function isStaleGateResult(
  maintenance: MaintenanceResultArtifact | AgentQualityResultArtifact | undefined,
  gate: GateResultArtifact | undefined,
): boolean {
  if (!maintenance || !gate) return false;
  if (!maintenance.runId || !gate.runId) return false;
  if (maintenance.runId !== gate.runId) return true;
  const mTime = Date.parse(maintenance.generatedAt);
  const gTime = Date.parse(gate.generatedAt);
  if (Number.isFinite(mTime) && Number.isFinite(gTime) && gTime < mTime) {
    return true;
  }
  return false;
}

export function computeDeployAllowed(input: {
  maintenanceStatus: MaintenanceRunResult["status"];
  gateDecision?: GateDecision | null;
  enforcementMode: EnforcementMode;
  requiresHumanReview: boolean;
  blockingFailures: number;
  misconfigured: boolean;
  artifactConsistent: boolean;
}): { deployAllowed: boolean; exitCode: number } {
  if (!input.artifactConsistent) {
    return { deployAllowed: false, exitCode: 2 };
  }
  if (input.misconfigured || input.maintenanceStatus === "misconfigured") {
    return { deployAllowed: false, exitCode: 2 };
  }
  const decision = input.gateDecision;
  if (decision === "block" || decision === "manual_review") {
    return { deployAllowed: false, exitCode: 1 };
  }
  if (input.requiresHumanReview) {
    return { deployAllowed: false, exitCode: 1 };
  }
  if (decision && !isPassingGateDecision(decision)) {
    return { deployAllowed: false, exitCode: 1 };
  }
  if (decision && !gateDecisionAllowsDeploy(decision, input.enforcementMode)) {
    return { deployAllowed: false, exitCode: 1 };
  }
  if (input.maintenanceStatus === "failed" || input.blockingFailures > 0) {
    if (decision === "pass" || !decision) {
      if (input.maintenanceStatus === "failed") {
        return { deployAllowed: false, exitCode: 1 };
      }
    }
  }
  if (input.maintenanceStatus === "failed") {
    return { deployAllowed: false, exitCode: 1 };
  }
  if (
    decision === "pass" &&
    (input.maintenanceStatus === "healthy" || input.maintenanceStatus === "at_risk")
  ) {
    return { deployAllowed: true, exitCode: 0 };
  }
  if (
    !decision &&
    (input.maintenanceStatus === "healthy" || input.maintenanceStatus === "at_risk")
  ) {
    return { deployAllowed: true, exitCode: 0 };
  }
  return { deployAllowed: false, exitCode: 1 };
}

export function reconcileAgentQaArtifacts(bundle: ArtifactBundle): ReconcileAgentQaArtifactsResult {
  const issues: ArtifactConsistencyIssue[] = [];

  for (const err of bundle.readErrors) {
    issues.push({
      code: err.code,
      message: `${err.path}: ${err.message}`,
      path: err.path,
      remediation: ["Fix or regenerate the malformed artifact."],
      severity: "error",
    });
  }

  if (bundle.ledgerMalformedLines.length > 0) {
    issues.push({
      code: "malformed_ledger",
      message: `Malformed JSONL at lines: ${bundle.ledgerMalformedLines.join(", ")}`,
      path: artifactPath(bundle.dir, "ledger"),
      remediation: ["Fix provider-call-ledger.jsonl or regenerate with npm run demo:maintenance-gate."],
      severity: "error",
    });
  }

  const m = bundle.maintenance;
  const aq = bundle.agentQuality;
  const g = bundle.gate;

  if (!m && g) {
    issues.push({
      code: "gate_without_maintenance",
      message: "gate-result.json exists but maintenance-result.json is missing.",
      path: artifactPath(bundle.dir, "gate"),
      remediation: ["Run npm run demo:maintenance-gate before npm run gate:release."],
      severity: "error",
    });
  }

  if (m && !m.runId) {
    issues.push({
      code: "missing_run_id",
      message: "maintenance-result.json is missing runId.",
      path: artifactPath(bundle.dir, "maintenance"),
      remediation: ["Regenerate maintenance artifacts with npm run demo:maintenance-gate."],
      severity: "error",
    });
  }

  if (m?.agentQa && !aq) {
    issues.push({
      code: "missing_agent_quality",
      message: "maintenance-result has agentQa but agent-quality-result.json is missing.",
      path: artifactPath(bundle.dir, "agentQuality"),
      remediation: ["Run npm run demo:maintenance-gate to write agent-quality-result.json."],
      severity: "warning",
    });
  }

  if (m && aq) {
    if (m.runId !== aq.runId) {
      issues.push({
        code: "run_id_mismatch",
        message: `runId mismatch: maintenance=${m.runId} vs agent-quality=${aq.runId}`,
        remediation: ["Run npm run demo:maintenance-gate to refresh all artifacts for one run."],
        severity: "error",
      });
    }
    if (m.specId !== aq.specId) {
      issues.push({
        code: "spec_id_mismatch",
        message: `specId mismatch: maintenance=${m.specId} vs agent-quality=${aq.specId}`,
        remediation: ["Regenerate artifacts from a single maintenance run."],
        severity: "error",
      });
    }
    if (m.agentQa?.gateDecision && aq.gateDecision && m.agentQa.gateDecision !== aq.gateDecision) {
      issues.push({
        code: "gate_decision_mismatch",
        message: `gateDecision mismatch between maintenance and agent-quality.`,
        remediation: ["Run npm run demo:maintenance-gate to resync artifacts."],
        severity: "error",
      });
    }
  }

  const staleGate = isStaleGateResult(m ?? aq, g);
  if (staleGate) {
    issues.push({
      code: "stale_gate_result",
      message: "gate-result.json is stale or mismatched vs latest maintenance/agent-quality runId.",
      path: artifactPath(bundle.dir, "gate"),
      remediation: ["Run npm run gate:release after the latest npm run demo:maintenance-gate."],
      severity: "error",
    });
  }

  if (g) {
    if (m && g.runId && m.runId !== g.runId) {
      issues.push({
        code: "gate_run_id_mismatch",
        message: `gate runId ${g.runId} does not match maintenance runId ${m.runId}.`,
        remediation: ["Run npm run gate:release to refresh gate-result.json."],
        severity: "error",
      });
    }
    if (g.agentQaGateDecision === "manual_review" && g.deployAllowed) {
      issues.push({
        code: "manual_review_deploy_allowed",
        message: "gate-result has manual_review but deployAllowed is true.",
        remediation: ["Regenerate gate with npm run gate:release; manual_review must not deploy."],
        severity: "error",
      });
    }
    if (g.agentQaGateDecision === "block" && g.deployAllowed) {
      issues.push({
        code: "block_deploy_allowed",
        message: "gate-result has block decision but deployAllowed is true.",
        remediation: ["Regenerate gate with npm run gate:release."],
        severity: "error",
      });
    }
    if (g.requiresHumanReview && g.deployAllowed) {
      issues.push({
        code: "human_review_deploy_allowed",
        message: "requiresHumanReview is true but deployAllowed is true.",
        remediation: ["Regenerate gate with npm run gate:release."],
        severity: "error",
      });
    }
  }

  const blockingErrors = issues.filter((i) => i.severity === "error");
  return {
    ok: blockingErrors.length === 0,
    issues,
    bundle,
    staleGate,
    readErrors: bundle.readErrors,
  };
}

export function validateMaintenanceArtifacts(
  bundle: ArtifactBundle,
): ReconcileAgentQaArtifactsResult {
  return reconcileAgentQaArtifacts(bundle);
}

export function wrapMaintenanceResult(
  result: MaintenanceRunResult,
  relatedDir: string,
  source?: string,
): MaintenanceResultArtifact {
  return {
    ...result,
    artifactType: "maintenance_result",
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    source: source ?? "runMaintenanceCheck",
    relatedArtifacts: {
      agentQualityResult: artifactPath(relatedDir, "agentQuality"),
      budgetState: artifactPath(relatedDir, "budgetState"),
      providerCallLedger: artifactPath(relatedDir, "ledger"),
      gateResult: artifactPath(relatedDir, "gate"),
      doctorResult: artifactPath(relatedDir, "doctor"),
    },
  };
}

export function buildAgentQualityArtifact(input: {
  result: MaintenanceRunResult;
  scenario?: string;
  artifactsDir: string;
  source?: string;
}): AgentQualityResultArtifact {
  const aq = input.result.agentQa;
  const generatedAt = input.result.generatedAt;
  return {
    artifactType: "agent_quality_result",
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    generatedAt,
    runId: input.result.runId,
    source: input.source ?? "runMaintenanceCheck",
    specId: input.result.specId,
    specVersion: input.result.specVersion,
    workflowName: input.result.workflowName,
    environment: input.result.environment,
    enforcementMode: aq?.enforcementMode ?? "enforce",
    gateDecision: aq?.gateDecision ?? "block",
    requiresHumanReview: aq?.requiresHumanReview ?? false,
    decisionReason: aq?.decisionReason ?? "unknown",
    confidence: aq?.confidence,
    remediation: aq?.remediation ?? [],
    evidenceCompleteness: aq?.evidenceCompleteness,
    wouldBlockCount: aq?.wouldBlockCount,
    checkCounts: aq?.checkCounts,
    maintenanceStatus: input.result.status,
    scenario: input.scenario,
    relatedArtifacts: {
      maintenanceResult: artifactPath(input.artifactsDir, "maintenance"),
      gateResult: artifactPath(input.artifactsDir, "gate"),
      budgetState: artifactPath(input.artifactsDir, "budgetState"),
      providerCallLedger: artifactPath(input.artifactsDir, "ledger"),
    },
  };
}

export function buildBudgetStateArtifact(
  state: BudgetState,
  meta: { runId: string; specId: string; generatedAt: string; source?: string },
): BudgetStateArtifact {
  return {
    ...state,
    artifactType: "budget_state",
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    generatedAt: meta.generatedAt,
    runId: meta.runId,
    specId: meta.specId,
    source: meta.source ?? "demo-maintenance-gate",
  };
}

export function buildGateResultArtifact(input: {
  maintenance: MaintenanceRunResult;
  sourceMaintenancePath: string;
  artifactsDir: string;
  reconcile: ReconcileAgentQaArtifactsResult;
  evaluatedAt: string;
}): GateResultArtifact {
  const agentQa = input.maintenance.agentQa;
  const gateDecision = agentQa?.gateDecision ?? null;
  const enforcementMode = agentQa?.enforcementMode ?? "enforce";
  const requiresHumanReview = agentQa?.requiresHumanReview ?? false;
  const blockingFailures = input.maintenance.blockingFailures;
  const misconfigured = input.maintenance.status === "misconfigured";
  const artifactConsistent = input.reconcile.ok && !input.reconcile.staleGate;

  const { deployAllowed, exitCode } = computeDeployAllowed({
    maintenanceStatus: input.maintenance.status,
    gateDecision,
    enforcementMode,
    requiresHumanReview,
    blockingFailures,
    misconfigured,
    artifactConsistent,
  });

  const staleWarning = input.reconcile.staleGate
    ? "gate-result is stale vs latest maintenance run; re-run gate:release."
    : !input.reconcile.ok
      ? "artifact consistency checks failed; resolve before deploy."
      : undefined;

  return {
    artifactType: "gate_result",
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    generatedAt: input.evaluatedAt,
    runId: input.maintenance.runId,
    source: "gate-release",
    specId: input.maintenance.specId,
    specVersion: input.maintenance.specVersion,
    workflowName: input.maintenance.workflowName,
    environment: input.maintenance.environment,
    sourceMaintenancePath: input.sourceMaintenancePath,
    sourceAgentQualityPath: artifactPath(input.artifactsDir, "agentQuality"),
    maintenanceStatus: input.maintenance.status,
    agentQaGateDecision: gateDecision,
    enforcementMode,
    requiresHumanReview,
    decisionReason: agentQa?.decisionReason ?? "unknown",
    remediation: [
      ...(agentQa?.remediation ?? []),
      ...input.reconcile.issues
        .filter((i) => i.severity === "error")
        .flatMap((i) => i.remediation),
    ].filter((v, i, a) => a.indexOf(v) === i),
    blockingFailures,
    misconfiguredCount: misconfigured ? 1 : 0,
    staleArtifactWarning: staleWarning,
    deployAllowed,
    exitCode,
    relatedArtifacts: {
      maintenanceResult: input.sourceMaintenancePath,
      agentQualityResult: artifactPath(input.artifactsDir, "agentQuality"),
      budgetState: artifactPath(input.artifactsDir, "budgetState"),
      providerCallLedger: artifactPath(input.artifactsDir, "ledger"),
    },
  };
}

export function wrapDoctorResult(
  result: DoctorResult,
  runSummary?: DoctorResultArtifact["runSummary"],
): DoctorResultArtifact {
  return {
    ...result,
    artifactType: "doctor_result",
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    generatedAt: result.evaluatedAt,
    source: "agent-qa-doctor",
    runSummary,
  };
}

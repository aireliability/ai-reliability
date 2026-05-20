import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  ARTIFACT_SCHEMA_VERSION,
  buildAgentQualityArtifact,
  buildGateResultArtifact,
  computeDeployAllowed,
  isStaleGateResult,
  loadArtifactBundle,
  readJsonArtifact,
  readJsonlLedger,
  reconcileAgentQaArtifacts,
  validateMaintenanceArtifacts,
  wrapDoctorResult,
  wrapMaintenanceResult,
} from "./agent-qa-artifacts";
import type { MaintenanceRunResult } from "./maintenance-result";

function baseMaintenance(overrides?: Partial<MaintenanceRunResult>): MaintenanceRunResult {
  return {
    runId: "maint-test-1",
    specId: "spec-1",
    specVersion: 1,
    workflowName: "wf",
    environment: "development",
    status: "healthy",
    productionHealthStatus: "healthy",
    checksRun: 1,
    checksPassed: 1,
    checksFailed: 0,
    blockingFailures: 0,
    warnings: 0,
    evidence: [],
    checks: [],
    recommendedActions: [],
    agentQa: {
      gateDecision: "pass",
      enforcementMode: "enforce",
      decisionReason: "ok",
      confidence: "high",
      requiresHumanReview: false,
      remediation: [],
      evidenceCompleteness: {
        outputCaptured: true,
        toolTraceCaptured: true,
        actionTraceCaptured: true,
        budgetStateLoaded: true,
        pricingConfigLoaded: true,
        ledgerWriteSucceeded: true,
      },
      wouldBlockCount: 0,
      checkCounts: {
        answer: { total: 0, passed: 0, failed: 0 },
        tool_call: { total: 0, passed: 0, failed: 0 },
        action: { total: 0, passed: 0, failed: 0 },
        budget: { total: 0, passed: 0, failed: 0 },
      },
    },
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("artifact contract", () => {
  it("maintenance artifact has required contract fields", () => {
    const m = baseMaintenance();
    const wrapped = wrapMaintenanceResult(m, "/tmp/art");
    assert.equal(wrapped.artifactType, "maintenance_result");
    assert.equal(wrapped.schemaVersion, ARTIFACT_SCHEMA_VERSION);
    assert.equal(wrapped.runId, "maint-test-1");
    assert.ok(wrapped.relatedArtifacts?.gateResult);
  });

  it("agent-quality artifact has required contract fields", () => {
    const m = baseMaintenance();
    const aq = buildAgentQualityArtifact({ result: m, artifactsDir: "/tmp/art" });
    assert.equal(aq.artifactType, "agent_quality_result");
    assert.equal(aq.runId, m.runId);
    assert.equal(aq.gateDecision, "pass");
    assert.ok(aq.remediation);
  });

  it("gate-result includes runId, decision, remediation, deployAllowed", () => {
    const m = baseMaintenance();
    const reconcile = reconcileAgentQaArtifacts({
      dir: "/tmp",
      ledger: [],
      ledgerMalformedLines: [],
      readErrors: [],
    });
    const gate = buildGateResultArtifact({
      maintenance: m,
      sourceMaintenancePath: "maintenance-result.json",
      artifactsDir: "/tmp/art",
      reconcile,
      evaluatedAt: new Date().toISOString(),
    });
    assert.equal(gate.artifactType, "gate_result");
    assert.equal(gate.runId, m.runId);
    assert.equal(gate.deployAllowed, true);
    assert.equal(gate.agentQaGateDecision, "pass");
    assert.ok(Array.isArray(gate.remediation));
  });

  it("doctor-result includes status, checks, nextActions", () => {
    const doc = wrapDoctorResult(
      {
        status: "ready",
        checks: [],
        summary: "ok",
        nextActions: ["Run npm run gate:release"],
        evaluatedAt: new Date().toISOString(),
      },
      { runId: "r1", specId: "s1" },
    );
    assert.equal(doc.artifactType, "doctor_result");
    assert.equal(doc.status, "ready");
    assert.ok(doc.nextActions.length > 0);
  });
});

describe("artifact consistency", () => {
  it("detects stale gate-result", () => {
    const m = baseMaintenance({ runId: "run-new", generatedAt: "2026-05-19T12:00:00.000Z" });
    const mWrapped = wrapMaintenanceResult(m, "/tmp");
    const g = {
      artifactType: "gate_result" as const,
      schemaVersion: 1,
      generatedAt: "2026-05-19T10:00:00.000Z",
      runId: "run-old",
      specId: "s",
      specVersion: 1,
      workflowName: "w",
      environment: "development",
      sourceMaintenancePath: "m.json",
      maintenanceStatus: "healthy",
      agentQaGateDecision: "pass" as const,
      enforcementMode: "enforce" as const,
      requiresHumanReview: false,
      decisionReason: "ok",
      remediation: [],
      blockingFailures: 0,
      misconfiguredCount: 0,
      deployAllowed: true,
      exitCode: 0,
    };
    assert.equal(isStaleGateResult(mWrapped, g), true);
  });

  it("detects mismatched runId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "art-mismatch-"));
    try {
      const m = baseMaintenance({ runId: "run-a" });
      await mkdir(dir, { recursive: true });
      const aqWrong = buildAgentQualityArtifact({
        result: { ...m, runId: "run-b" },
        artifactsDir: dir,
      });
      await writeFile(join(dir, "maintenance-result.json"), JSON.stringify(wrapMaintenanceResult(m, dir)));
      await writeFile(join(dir, "agent-quality-result.json"), JSON.stringify(aqWrong));

      const bundle = await loadArtifactBundle(dir);
      const r = reconcileAgentQaArtifacts(bundle);
      assert.equal(r.ok, false);
      assert.ok(r.issues.some((i) => i.code === "run_id_mismatch"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("detects malformed JSON artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "art-badjson-"));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "maintenance-result.json"), "{ bad");
      const bundle = await loadArtifactBundle(dir);
      const r = validateMaintenanceArtifacts(bundle);
      assert.equal(r.ok, false);
      assert.ok(r.bundle.readErrors.length > 0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("detects malformed JSONL ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "art-ledger-"));
    try {
      const ledgerPath = join(dir, "ledger.jsonl");
      await writeFile(ledgerPath, "not-json\n");
      const r = await readJsonlLedger(ledgerPath);
      assert.ok(r.malformedLineNumbers.length > 0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("manual_review never deployAllowed", () => {
    const d = computeDeployAllowed({
      maintenanceStatus: "at_risk",
      gateDecision: "manual_review",
      enforcementMode: "warn",
      requiresHumanReview: true,
      blockingFailures: 0,
      misconfigured: false,
      artifactConsistent: true,
    });
    assert.equal(d.deployAllowed, false);
  });

  it("block never deployAllowed", () => {
    const d = computeDeployAllowed({
      maintenanceStatus: "healthy",
      gateDecision: "block",
      enforcementMode: "enforce",
      requiresHumanReview: false,
      blockingFailures: 1,
      misconfigured: false,
      artifactConsistent: true,
    });
    assert.equal(d.deployAllowed, false);
  });

  it("pass can deployAllowed when healthy and consistent", () => {
    const d = computeDeployAllowed({
      maintenanceStatus: "healthy",
      gateDecision: "pass",
      enforcementMode: "enforce",
      requiresHumanReview: false,
      blockingFailures: 0,
      misconfigured: false,
      artifactConsistent: true,
    });
    assert.equal(d.deployAllowed, true);
    assert.equal(d.exitCode, 0);
  });
});

describe("readJsonArtifact", () => {
  it("reads valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "read-json-"));
    try {
      const p = join(dir, "x.json");
      await writeFile(p, JSON.stringify({ ok: true }));
      const r = await readJsonArtifact<{ ok: boolean }>(p);
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.data.ok, true);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

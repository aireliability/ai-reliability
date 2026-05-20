import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  formatDoctorReport,
  runDoctor,
  type DoctorResult,
} from "./agent-qa-doctor";

const validSpec = {
  specId: "doctor-test",
  specName: "Doctor test",
  description: "Budget applies to calls routed through the AI Reliability gate only.",
  workflowName: "test_agent",
  environment: "development",
  version: 1,
  enforcementMode: "observe",
  severity: "blocking",
  checks: [
    {
      id: "c1",
      name: "Budget",
      category: "budget",
      severity: "blocking",
    },
  ],
  testCases: [
    {
      id: "t1",
      name: "One",
      input: "hi",
      expectedBehavior: "greet",
      severity: "blocking",
    },
  ],
  budgetGate: {
    monthlyBudgetLimitUsd: 100,
    perRunBudgetLimitUsd: 1,
    allowedProviders: ["openai"],
    allowedModels: ["gpt-4.1-mini"],
    failClosed: true,
  },
};

async function writePackageJson(dir: string, scripts?: Record<string, string>): Promise<void> {
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test",
      scripts: scripts ?? {
        "test:maintenance-gate": "tsx --test",
        "test:budget-gate": "tsx --test",
        "demo:maintenance-gate": "tsx",
        "gate:release": "tsx",
        "validate:spec": "tsx",
        doctor: "tsx",
        "firewall:check": "tsx",
      },
    }),
    "utf-8",
  );
}

describe("agent-qa-doctor", () => {
  it("ready result with valid template and valid artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doctor-ready-"));
    try {
      const specPath = join(dir, "spec.json");
      const artifacts = join(dir, "artifacts");
      await writePackageJson(dir);
      await writeFile(specPath, JSON.stringify(validSpec));
      await mkdir(artifacts, { recursive: true });
      const generatedAt = new Date().toISOString();
      await writeFile(
        join(artifacts, "maintenance-result.json"),
        JSON.stringify({
          runId: "r1",
          specId: "doctor-test",
          specVersion: 1,
          workflowName: "test",
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
            enforcementMode: "observe",
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
          generatedAt,
        }),
      );
      await writeFile(
        join(artifacts, "gate-result.json"),
        JSON.stringify({
          artifactType: "gate_result",
          schemaVersion: 1,
          generatedAt,
          runId: "r1",
          specId: "doctor-test",
          deployAllowed: true,
          exitCode: 0,
          agentQaGateDecision: "pass",
          requiresHumanReview: false,
        }),
      );
      await writeFile(
        join(artifacts, "provider-call-ledger.jsonl"),
        `${JSON.stringify({ callId: "c1", runId: "r1", provider: "openai", model: "m", estimatedInputTokens: 1, estimatedOutputTokens: 1, estimatedCostUsd: 0.1, status: "completed", actualCostUsd: 0.1, createdAt: new Date().toISOString() })}\n`,
      );
      await writeFile(
        join(artifacts, "budget-state.json"),
        JSON.stringify({ planId: "starter", creditsRemaining: 10, budgetRemainingUsd: 10, creditsUsed: 0, budgetUsedUsd: 0 }),
      );
      await writeFile(
        join(artifacts, "agent-quality-result.json"),
        JSON.stringify({
          artifactType: "agent_quality_result",
          schemaVersion: 1,
          generatedAt,
          runId: "r1",
          specId: "doctor-test",
          gateDecision: "pass",
          enforcementMode: "observe",
        }),
      );

      const result = await runDoctor({
        cwd: dir,
        specPaths: [specPath],
        artifactsDir: artifacts,
      });
      assert.equal(result.status, "ready");
      assert.ok(result.nextActions.length > 0);
      assert.ok(result.checks.some((c) => c.status === "pass"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("missing spec file produces blocked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doctor-missing-"));
    try {
      await writePackageJson(dir);
      const result = await runDoctor({
        cwd: dir,
        specPaths: [join(dir, "missing.spec.json")],
        artifactsDir: join(dir, "artifacts"),
      });
      assert.equal(result.status, "blocked");
      assert.ok(result.checks.some((c) => c.status === "fail" && c.category === "spec"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("invalid JSON spec produces blocked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doctor-badjson-"));
    try {
      const specPath = join(dir, "bad.spec.json");
      await writePackageJson(dir);
      await writeFile(specPath, "{ not json");
      const result = await runDoctor({
        cwd: dir,
        specPaths: [specPath],
        artifactsDir: join(dir, "artifacts"),
      });
      assert.equal(result.status, "blocked");
      assert.ok(result.checks.some((c) => c.id.includes("json") && c.status === "fail"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("invalid Agent QA spec produces blocked with remediation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doctor-invalid-"));
    try {
      const specPath = join(dir, "invalid.spec.json");
      await writePackageJson(dir);
      await writeFile(
        specPath,
        JSON.stringify({ ...validSpec, enforcementMode: "strict" }),
      );
      const result = await runDoctor({
        cwd: dir,
        specPaths: [specPath],
        artifactsDir: join(dir, "artifacts"),
      });
      assert.equal(result.status, "blocked");
      const fail = result.checks.find((c) => c.status === "fail");
      assert.ok(fail);
      assert.ok(fail!.remediation.length > 0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("missing maintenance artifacts produces warning with next action", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doctor-noart-"));
    try {
      const specPath = join(dir, "spec.json");
      await writePackageJson(dir);
      await writeFile(specPath, JSON.stringify(validSpec));
      const result = await runDoctor({
        cwd: dir,
        specPaths: [specPath],
        artifactsDir: join(dir, "artifacts"),
      });
      assert.equal(result.status, "warning");
      assert.ok(
        result.nextActions.some((a) => a.includes("demo:maintenance-gate")),
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("malformed ledger line produces fail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doctor-ledger-"));
    try {
      const artifacts = join(dir, "artifacts");
      await writePackageJson(dir);
      await writeFile(join(dir, "spec.json"), JSON.stringify(validSpec));
      await mkdir(artifacts, { recursive: true });
      await writeFile(join(artifacts, "provider-call-ledger.jsonl"), "not-json\n");
      const result = await runDoctor({
        cwd: dir,
        specPaths: [join(dir, "spec.json")],
        artifactsDir: artifacts,
      });
      assert.ok(result.checks.some((c) => c.id.includes("malformed") && c.status === "fail"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("manual_review gate result is not ready", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doctor-review-"));
    try {
      const artifacts = join(dir, "artifacts");
      await writePackageJson(dir);
      await mkdir(artifacts, { recursive: true });
      await writeFile(join(dir, "spec.json"), JSON.stringify(validSpec));
      await writeFile(
        join(artifacts, "maintenance-result.json"),
        JSON.stringify({
          agentQa: {
            gateDecision: "manual_review",
            enforcementMode: "warn",
            decisionReason: "behavior",
            confidence: "medium",
            requiresHumanReview: true,
            remediation: ["Review output"],
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
              answer: { total: 1, passed: 0, failed: 1 },
              tool_call: { total: 0, passed: 0, failed: 0 },
              action: { total: 0, passed: 0, failed: 0 },
              budget: { total: 0, passed: 0, failed: 0 },
            },
          },
        }),
      );
      await writeFile(
        join(artifacts, "gate-result.json"),
        JSON.stringify({
          deployAllowed: false,
          exitCode: 1,
          agentQaGateDecision: "manual_review",
          requiresHumanReview: true,
        }),
      );

      const result = await runDoctor({ cwd: dir, specPaths: [join(dir, "spec.json")], artifactsDir: artifacts });
      assert.notEqual(result.status, "ready");
      assert.ok(
        result.checks.some((c) => c.id.includes("manual-review")),
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("blocking gate result makes doctor status blocked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doctor-blocked-"));
    try {
      const artifacts = join(dir, "artifacts");
      await writePackageJson(dir);
      await mkdir(artifacts, { recursive: true });
      await writeFile(join(dir, "spec.json"), JSON.stringify(validSpec));
      await writeFile(
        join(artifacts, "gate-result.json"),
        JSON.stringify({
          deployAllowed: false,
          exitCode: 1,
          agentQaGateDecision: "block",
        }),
      );

      const result = await runDoctor({ cwd: dir, specPaths: [join(dir, "spec.json")], artifactsDir: artifacts });
      assert.equal(result.status, "blocked");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("missing required npm script is fail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doctor-scripts-"));
    try {
      await writePackageJson(dir, { doctor: "tsx apps/api/doctor.ts" });
      const specPath = join(dir, "spec.json");
      await writeFile(specPath, JSON.stringify(validSpec));
      const result = await runDoctor({
        cwd: dir,
        specPaths: [specPath],
        artifactsDir: join(dir, "artifacts"),
      });
      assert.ok(
        result.checks.some(
          (c) => c.category === "environment" && c.status === "fail",
        ),
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("doctor result includes nextActions and remediation for failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doctor-actions-"));
    try {
      await writePackageJson(dir);
      const result = await runDoctor({
        cwd: dir,
        specPaths: [join(dir, "nope.spec.json")],
        artifactsDir: join(dir, "artifacts"),
      });
      assert.ok(result.nextActions.length > 0);
      assert.ok(result.checks.some((c) => c.remediation.length > 0));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("writeArtifact creates doctor-result.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doctor-artifact-"));
    try {
      const artifacts = join(dir, "artifacts");
      await writePackageJson(dir);
      const specPath = join(dir, "spec.json");
      await writeFile(specPath, JSON.stringify(validSpec));
      await runDoctor({
        cwd: dir,
        specPaths: [specPath],
        artifactsDir: artifacts,
        writeArtifact: true,
      });
      const raw = await readFile(join(artifacts, "doctor-result.json"), "utf-8");
      const parsed = JSON.parse(raw) as { artifactType?: string; status: string; checks: unknown[] };
      assert.equal(parsed.artifactType, "doctor_result");
      assert.ok(parsed.status);
      assert.ok(Array.isArray(parsed.checks));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("formatDoctorReport includes status header", () => {
    const report = formatDoctorReport({
      status: "warning",
      checks: [
        {
          id: "w1",
          category: "ledger",
          status: "warning",
          title: "Empty ledger",
          message: "Ledger is empty.",
          remediation: ["Run demo"],
        },
      ],
      summary: "1 passed, 1 warnings, 0 blocking",
      nextActions: ["Run npm run demo:maintenance-gate"],
      evaluatedAt: new Date().toISOString(),
    });
    assert.match(report, /AGENT QA FIREWALL DOCTOR: WARNING/);
    assert.match(report, /Next actions:/);
  });
});

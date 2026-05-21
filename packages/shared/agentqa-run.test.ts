import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  DEFAULT_AGENTQA_SPEC_PATH,
  buildSpecConformantObservations,
  loadSpecForAgentQaRun,
  parseAgentQaRunArgv,
  runAgentQaFirewall,
} from "./agentqa-run";
import {
  readJsonArtifact,
  type AgentQualityResultArtifact,
  type GateResultArtifact,
  type MaintenanceResultArtifact,
} from "./agent-qa-artifacts";
import { runDoctor } from "./agent-qa-doctor";
import type { EvalSpecBudgetGate } from "./eval-spec";

const repoRoot = process.cwd();

const baseBudgetGate: EvalSpecBudgetGate = {
  monthlyBudgetLimitUsd: 500,
  perRunBudgetLimitUsd: 2,
  allowedProviders: ["openai"],
  allowedModels: ["gpt-4.1-mini"],
  failClosed: true,
};

function agentQaMinimal(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    specId: "test-agent-qa",
    specName: "Test Agent QA",
    workflowName: "test_workflow",
    environment: "development",
    version: 1,
    enforcementMode: "enforce",
    severity: "blocking",
    budgetGate: { ...baseBudgetGate },
    checks: [
      {
        id: "c1",
        name: "Answer check",
        category: "answer",
        severity: "blocking",
        expectedBehavior: "be helpful",
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
    ...overrides,
  };
}

describe("parseAgentQaRunArgv", () => {
  it("defaults spec and artifacts dir", () => {
    const a = parseAgentQaRunArgv([]);
    assert.equal(a.specPath, DEFAULT_AGENTQA_SPEC_PATH);
    assert.equal(a.artifactsDir.replace(/\\/g, "/"), "deliverables/maintenance");
  });

  it("accepts positional spec path", () => {
    const a = parseAgentQaRunArgv([
      "examples/eval-specs/tool-call-required.spec.json",
    ]);
    assert.equal(a.specPath, "examples/eval-specs/tool-call-required.spec.json");
  });

  it("accepts --spec and --artifacts", () => {
    const a = parseAgentQaRunArgv([
      "--spec",
      "examples/eval-specs/support-agent-qa.spec.json",
      "--artifacts",
      "deliverables/maintenance",
    ]);
    assert.equal(a.specPath, "examples/eval-specs/support-agent-qa.spec.json");
    assert.equal(a.artifactsDir, "deliverables/maintenance");
  });

  it("accepts --observations", () => {
    const a = parseAgentQaRunArgv([
      "--spec",
      "examples/eval-specs/support-agent-qa.spec.json",
      "--observations",
      "examples/observations/support-agent-qa.pass.json",
    ]);
    assert.equal(a.observationsPath, "examples/observations/support-agent-qa.pass.json");
  });
});

describe("agentqa:run invalid spec handling", () => {
  it("missing file fails clearly without writing maintenance artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-missing-"));
    try {
      const artifacts = join(dir, "artifacts");
      const r = await runAgentQaFirewall({
        specPath: join(dir, "missing.spec.json"),
        artifactsDir: artifacts,
        cwd: dir,
      });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.label, "INVALID");
      assert.equal(r.reason, "missing_file");
      assert.ok(r.errors.length > 0);
      await assert.rejects(readFile(join(artifacts, "maintenance-result.json")));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("invalid JSON fails clearly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-badjson-"));
    try {
      const specPath = join(dir, "bad.spec.json");
      await writeFile(specPath, "{ not json");
      const r = await runAgentQaFirewall({
        specPath,
        artifactsDir: join(dir, "artifacts"),
        cwd: dir,
      });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.label, "INVALID");
      if (r.label === "INVALID") assert.equal(r.reason, "invalid_json");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("invalid Agent QA spec fails with remediation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-invalid-"));
    try {
      const specPath = join(dir, "invalid.spec.json");
      await writeFile(
        specPath,
        JSON.stringify(agentQaMinimal({ enforcementMode: "strict" })),
      );
      const r = await runAgentQaFirewall({
        specPath,
        artifactsDir: join(dir, "artifacts"),
        cwd: dir,
      });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.label, "INVALID");
      if (r.label === "INVALID") assert.equal(r.reason, "invalid_spec");
      assert.ok(r.errors.some((e) => e.remediation.length > 0));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("unsupported check category fails validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-badcat-"));
    try {
      const specPath = join(dir, "badcat.spec.json");
      await writeFile(
        specPath,
        JSON.stringify(
          agentQaMinimal({
            checks: [
              {
                id: "c1",
                name: "Bad",
                category: "unknown_category",
                severity: "blocking",
              },
            ],
          }),
        ),
      );
      const loaded = await loadSpecForAgentQaRun(specPath, dir);
      assert.equal(loaded.ok, false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("tool check without requiredToolCalls fails validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-notools-"));
    try {
      const specPath = join(dir, "notools.spec.json");
      await writeFile(
        specPath,
        JSON.stringify(
          agentQaMinimal({
            checks: [
              {
                id: "c1",
                name: "Tool",
                category: "tool_call",
                severity: "blocking",
              },
            ],
          }),
        ),
      );
      const loaded = await loadSpecForAgentQaRun(specPath, dir);
      assert.equal(loaded.ok, false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("budget check with invalid budget fails validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-badbudget-"));
    try {
      const specPath = join(dir, "badbudget.spec.json");
      await writeFile(
        specPath,
        JSON.stringify(
          agentQaMinimal({
            budgetGate: {
              monthlyBudgetLimitUsd: -1,
              perRunBudgetLimitUsd: 1,
              failClosed: true,
            },
          }),
        ),
      );
      const loaded = await loadSpecForAgentQaRun(specPath, dir);
      assert.equal(loaded.ok, false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("agentqa:run success path", () => {
  it("default spec succeeds with contract fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-default-"));
    try {
      const artifacts = join(dir, "artifacts");
      const r = await runAgentQaFirewall({
        specPath: DEFAULT_AGENTQA_SPEC_PATH,
        artifactsDir: artifacts,
        cwd: repoRoot,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.label, "PASS");

      const m = await readJsonArtifact<MaintenanceResultArtifact>(
        join(artifacts, "maintenance-result.json"),
      );
      const aq = await readJsonArtifact<AgentQualityResultArtifact>(
        join(artifacts, "agent-quality-result.json"),
      );
      assert.equal(m.ok, true);
      assert.equal(aq.ok, true);
      if (!m.ok || !aq.ok) return;

      assert.equal(m.data.artifactType, "maintenance_result");
      assert.equal(m.data.schemaVersion, 1);
      assert.ok(m.data.generatedAt);
      assert.equal(m.data.runId, r.runId);
      assert.equal(m.data.source, "agentqa:run");
      assert.equal(m.data.specId, r.specId);
      assert.equal(m.data.workflowName, r.workflowName);
      assert.equal(m.data.environment, r.environment);

      assert.equal(aq.data.artifactType, "agent_quality_result");
      assert.equal(aq.data.runId, m.data.runId);
      assert.equal(aq.data.specId, m.data.specId);
      assert.equal(aq.data.workflowName, m.data.workflowName);
      assert.equal(aq.data.environment, m.data.environment);
      assert.equal(aq.data.enforcementMode, r.enforcementMode);
      assert.equal(aq.data.gateDecision, r.gateDecision);
      assert.ok(aq.data.evidenceCompleteness);
      assert.ok(aq.data.checkCounts);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("explicit tool-call-required spec path succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-tool-"));
    try {
      const loaded = await loadSpecForAgentQaRun(
        "examples/eval-specs/tool-call-required.spec.json",
        repoRoot,
      );
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;

      const r = await runAgentQaFirewall({
        specPath: "examples/eval-specs/tool-call-required.spec.json",
        artifactsDir: join(dir, "artifacts"),
        cwd: repoRoot,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.label, "PASS");
      assert.ok(Object.keys(buildSpecConformantObservations(loaded.spec)).length > 0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("gate:release after run produces aligned gate-result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-gate-"));
    try {
      const artifacts = join(dir, "artifacts");
      const run = await runAgentQaFirewall({
        specPath: DEFAULT_AGENTQA_SPEC_PATH,
        artifactsDir: artifacts,
        cwd: repoRoot,
      });
      assert.equal(run.ok, true);
      if (!run.ok) return;

      const maintenancePath = join(artifacts, "maintenance-result.json");
      const gate = spawnSync(
        "npx",
        ["tsx", "apps/api/gate-release.ts", maintenancePath],
        { cwd: repoRoot, encoding: "utf-8", shell: true },
      );
      assert.equal(gate.status ?? -1, 0);

      const gateRead = await readJsonArtifact<GateResultArtifact>(
        join(artifacts, "gate-result.json"),
      );
      assert.equal(gateRead.ok, true);
      if (!gateRead.ok) return;
      assert.equal(gateRead.data.runId, run.runId);
      assert.equal(gateRead.data.specId, run.specId);
      assert.equal(gateRead.data.deployAllowed, true);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("doctor after run + gate returns READY for healthy default path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-doctor-"));
    try {
      const artifacts = join(dir, "artifacts");
      const specPath = join(repoRoot, DEFAULT_AGENTQA_SPEC_PATH);
      await runAgentQaFirewall({
        specPath: DEFAULT_AGENTQA_SPEC_PATH,
        artifactsDir: artifacts,
        cwd: repoRoot,
      });

      const maintenancePath = join(artifacts, "maintenance-result.json");
      spawnSync("npx", ["tsx", "apps/api/gate-release.ts", maintenancePath], {
        cwd: repoRoot,
        encoding: "utf-8",
        shell: true,
      });

      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "test",
          scripts: {
            "test:maintenance-gate": "tsx",
            "test:budget-gate": "tsx",
            "demo:maintenance-gate": "tsx",
            "agentqa:run": "tsx",
            "gate:release": "tsx",
            "validate:spec": "tsx",
            doctor: "tsx",
            "firewall:check": "tsx",
          },
        }),
      );

      const doctor = await runDoctor({
        cwd: dir,
        specPaths: [specPath],
        artifactsDir: artifacts,
      });
      assert.equal(doctor.status, "ready");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("agentqa:run CLI", () => {
  it("CLI exits 0 for default spec", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-cli-"));
    try {
      const artifacts = join(dir, "artifacts");
      const r = spawnSync(
        "npx",
        [
          "tsx",
          "apps/api/agentqa-run.ts",
          "--spec",
          DEFAULT_AGENTQA_SPEC_PATH,
          "--artifacts",
          artifacts,
        ],
        { cwd: repoRoot, encoding: "utf-8", shell: true },
      );
      assert.equal(r.status ?? -1, 0);
      assert.match(r.stdout ?? "", /AGENT QA FIREWALL RUN: PASS/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("CLI exits 1 for invalid spec", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-cli-invalid-"));
    try {
      const specPath = join(dir, "bad.spec.json");
      await writeFile(
        specPath,
        JSON.stringify(agentQaMinimal({ enforcementMode: "nope" })),
      );
      const r = spawnSync(
        "npx",
        ["tsx", "apps/api/agentqa-run.ts", "--spec", specPath, "--artifacts", join(dir, "out")],
        { cwd: repoRoot, encoding: "utf-8", shell: true },
      );
      assert.equal(r.status ?? -1, 1);
      assert.match(r.stdout ?? "", /INVALID/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("agentqa:run with observations", () => {
  it("observations pass example succeeds with observation source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-obs-pass-"));
    try {
      const artifacts = join(dir, "artifacts");
      const r = await runAgentQaFirewall({
        specPath: "examples/eval-specs/support-agent-qa.spec.json",
        observationsPath: "examples/observations/support-agent-qa.pass.json",
        artifactsDir: artifacts,
        cwd: repoRoot,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.label, "PASS");
      assert.equal(r.observationsUsed, true);

      const m = await readJsonArtifact<MaintenanceResultArtifact>(
        join(artifacts, "maintenance-result.json"),
      );
      assert.equal(m.ok, true);
      if (!m.ok) return;
      assert.equal(m.data.source, "agentqa:run:observations");
      assert.equal(m.data.observationId, "obs-support-pass-001");
      assert.ok(m.data.observationPath?.includes("support-agent-qa.pass.json"));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("missing required tool observation blocks under enforce", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-obs-tool-"));
    try {
      const r = await runAgentQaFirewall({
        specPath: "examples/eval-specs/tool-call-required.spec.json",
        observationsPath: "examples/observations/tool-call-required.missing-tool.json",
        artifactsDir: join(dir, "artifacts"),
        cwd: repoRoot,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.notEqual(r.gateDecision, "pass");
      assert.ok(r.label === "BLOCK" || r.label === "MANUAL REVIEW");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("forbidden action observation blocks under enforce", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-obs-forbidden-"));
    try {
      const r = await runAgentQaFirewall({
        specPath: "examples/eval-specs/forbidden-action.spec.json",
        observationsPath: "examples/observations/forbidden-action.detected.json",
        artifactsDir: join(dir, "artifacts"),
        cwd: repoRoot,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.gateDecision, "block");
      assert.equal(r.label, "BLOCK");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("invented pricing observation does not pass", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-obs-price-"));
    try {
      const r = await runAgentQaFirewall({
        specPath: "examples/eval-specs/pricing-plan-agent.spec.json",
        observationsPath: "examples/observations/pricing-plan-agent.invented-price.json",
        artifactsDir: join(dir, "artifacts"),
        cwd: repoRoot,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.notEqual(r.label, "PASS");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("over-budget routed call blocks budget gate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-obs-budget-"));
    try {
      const r = await runAgentQaFirewall({
        specPath: "examples/eval-specs/agent-budget-gate.spec.json",
        observationsPath: "examples/observations/budget-gate.over-limit.json",
        artifactsDir: join(dir, "artifacts"),
        cwd: repoRoot,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.notEqual(r.gateDecision, "pass");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("invalid observations exit before writing maintenance artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-obs-invalid-"));
    try {
      const obsPath = join(dir, "bad-obs.json");
      await writeFile(obsPath, JSON.stringify({ observationId: "x" }));
      const artifacts = join(dir, "artifacts");
      const r = await runAgentQaFirewall({
        specPath: join(repoRoot, DEFAULT_AGENTQA_SPEC_PATH),
        observationsPath: obsPath,
        artifactsDir: artifacts,
        cwd: repoRoot,
      });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.label, "INVALID OBSERVATIONS");
      await assert.rejects(readFile(join(artifacts, "maintenance-result.json")));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("gate and doctor after observation-backed pass path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentqa-obs-flow-"));
    try {
      const artifacts = join(dir, "artifacts");
      await runAgentQaFirewall({
        specPath: DEFAULT_AGENTQA_SPEC_PATH,
        observationsPath: "examples/observations/support-agent-qa.pass.json",
        artifactsDir: artifacts,
        cwd: repoRoot,
      });
      const maintenancePath = join(artifacts, "maintenance-result.json");
      const gate = spawnSync(
        "npx",
        ["tsx", "apps/api/gate-release.ts", maintenancePath],
        { cwd: repoRoot, encoding: "utf-8", shell: true },
      );
      assert.equal(gate.status ?? -1, 0);

      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "test",
          scripts: {
            "test:maintenance-gate": "tsx",
            "test:budget-gate": "tsx",
            "demo:maintenance-gate": "tsx",
            "agentqa:run": "tsx",
            "gate:release": "tsx",
            "validate:spec": "tsx",
            doctor: "tsx",
            "firewall:check": "tsx",
          },
        }),
      );

      const doctor = await runDoctor({
        cwd: dir,
        specPaths: [join(repoRoot, DEFAULT_AGENTQA_SPEC_PATH)],
        artifactsDir: artifacts,
      });
      assert.equal(doctor.status, "ready");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  buildGateResultArtifact,
  loadArtifactBundle,
  reconcileAgentQaArtifacts,
} from "./agent-qa-artifacts";
import { isPassingGateDecision } from "./agent-qa";
import { runDoctor } from "./agent-qa-doctor";
import { runAgentQaFirewall } from "./agentqa-run";
import { runFirewallCapabilityTests } from "./firewall-capabilities";
import { runRoutedProviderCall } from "./routed-provider-call";
import { readProviderCallLedger } from "./provider-call-ledger";

const repoRoot = process.cwd();

async function evaluateDeployAllowed(artifactsDir: string): Promise<boolean> {
  const bundle = await loadArtifactBundle(artifactsDir);
  bundle.gate = undefined;
  const reconcile = reconcileAgentQaArtifacts(bundle);
  if (!bundle.maintenance) return false;
  const gate = buildGateResultArtifact({
    maintenance: bundle.maintenance,
    sourceMaintenancePath: join(artifactsDir, "maintenance-result.json"),
    artifactsDir,
    reconcile,
    evaluatedAt: new Date().toISOString(),
  });
  return gate.deployAllowed === true;
}

describe("firewall capability fixtures", () => {
  it("good observation passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fw-good-"));
    try {
      const r = await runAgentQaFirewall({
        specPath: "examples/eval-specs/support-agent-qa.spec.json",
        observationsPath: "examples/observations/support-agent-qa.pass.json",
        artifactsDir: join(dir, "artifacts"),
        cwd: repoRoot,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.gateDecision, "pass");
      assert.equal(r.label, "PASS");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("hallucinated answer does not pass silently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fw-halluc-"));
    try {
      const r = await runAgentQaFirewall({
        specPath: "examples/eval-specs/pricing-plan-agent.spec.json",
        observationsPath: "examples/observations/pricing-plan-agent.invented-price.json",
        artifactsDir: join(dir, "artifacts"),
        cwd: repoRoot,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(isPassingGateDecision(r.gateDecision), false);
      assert.notEqual(r.label, "PASS");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("missing required tool blocks or manual_review and gate release not deployAllowed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fw-tool-"));
    try {
      const artifactsDir = join(dir, "artifacts");
      const r = await runAgentQaFirewall({
        specPath: "examples/eval-specs/tool-call-required.spec.json",
        observationsPath: "examples/observations/tool-call-required.missing-tool.json",
        artifactsDir,
        cwd: repoRoot,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.notEqual(r.gateDecision, "pass");
      assert.equal(await evaluateDeployAllowed(artifactsDir), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forbidden action blocks and gate release not deployAllowed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fw-forbidden-"));
    try {
      const artifactsDir = join(dir, "artifacts");
      const r = await runAgentQaFirewall({
        specPath: "examples/eval-specs/forbidden-action.spec.json",
        observationsPath: "examples/observations/forbidden-action.detected.json",
        artifactsDir,
        cwd: repoRoot,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.gateDecision, "block");
      assert.equal(await evaluateDeployAllowed(artifactsDir), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("over-budget routed call does not execute callback and writes blocked ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fw-budget-"));
    try {
      const ledgerPath = join(dir, "ledger.jsonl");
      let count = 0;
      const r = await runRoutedProviderCall(
        {
          runId: "cap-test",
          provider: "openai",
          model: "gpt-4.1-mini",
          estimatedInputTokens: 300,
          estimatedOutputTokens: 100,
          estimatedCostUsd: 0.9,
          currentRunSpendUsd: 1.0,
          budgetState: {
            planId: "starter",
            creditsRemaining: 500,
            budgetRemainingUsd: 80,
            creditsUsed: 0,
            budgetUsedUsd: 0,
          },
          budgetGate: {
            monthlyBudgetLimitUsd: 100,
            perRunBudgetLimitUsd: 1.5,
            allowedProviders: ["openai"],
            allowedModels: ["gpt-4.1-mini"],
            failClosed: true,
          },
          pricingKnown: true,
          specId: "agent-budget-gate-v1",
          workflowName: "llm_router_agent",
          environment: "production",
          ledgerPath,
        },
        async () => {
          count += 1;
          return { actualCostUsd: 0.9 };
        },
      );
      assert.equal(count, 0);
      assert.equal(r.executed, false);
      assert.equal(r.allowed, false);
      assert.equal(r.reasonCode, "per_run_budget_exceeded");
      const ledger = await readProviderCallLedger(ledgerPath);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]!.status, "blocked");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("over-budget observation does not pass budget gate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fw-obs-budget-"));
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
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("doctor is not ready after forbidden-action block artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fw-doc-"));
    try {
      const artifactsDir = join(dir, "artifacts");
      await runAgentQaFirewall({
        specPath: "examples/eval-specs/forbidden-action.spec.json",
        observationsPath: "examples/observations/forbidden-action.detected.json",
        artifactsDir,
        cwd: repoRoot,
      });
      const doctor = await runDoctor({ cwd: repoRoot, artifactsDir, writeArtifact: false });
      assert.notEqual(doctor.status, "ready");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runFirewallCapabilityTests passes all scenarios", async () => {
    const result = await runFirewallCapabilityTests(repoRoot);
    if (!result.ok) {
      for (const s of result.scenarios) {
        if (!s.ok) console.error(s);
      }
    }
    assert.equal(result.ok, true);
  });
});

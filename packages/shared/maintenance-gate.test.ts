import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertProviderCallAllowed,
  applyBudgetUsage,
} from "./budget-gate";
import {
  parseEvalSpec,
  validateEvalSpec,
  type EvalSpec,
  type EvalSpecBudgetGate,
} from "./eval-spec";
import { isPassingGateDecision } from "./agent-qa";
import {
  runMaintenanceCheck,
  evaluateTestCase,
  type SimulatedCaseObservation,
} from "./maintenance-check";
import {
  appendProviderCallLedgerEntry,
  readProviderCallLedger,
  writeProviderCallLedger,
} from "./provider-call-ledger";
import type { MaintenanceRunResult } from "./maintenance-result";

const baseBudgetGate: EvalSpecBudgetGate = {
  monthlyBudgetLimitUsd: 500,
  perRunBudgetLimitUsd: 2,
  allowedProviders: ["openai"],
  allowedModels: ["gpt-4.1-mini"],
  failClosed: true,
};

function minimalSpec(overrides?: Partial<EvalSpec>): EvalSpec {
  return {
    specId: "test-spec",
    specName: "Test",
    workflowName: "wf",
    environment: "development",
    version: 1,
    testCases: [
      {
        id: "t1",
        name: "One",
        input: "hi",
        expectedBehavior: "greet",
        severity: "blocking",
      },
    ],
    budgetGate: { ...baseBudgetGate } satisfies EvalSpecBudgetGate,
    severity: "blocking",
    ...overrides,
  };
}

describe("eval spec validation", () => {
  it("accepts a valid spec", () => {
    const v = validateEvalSpec(minimalSpec());
    assert.equal(v.ok, true);
  });

  it("rejects invalid/misconfigured spec (fail closed)", () => {
    const bad = validateEvalSpec({
      ...minimalSpec(),
      environment: "invalid",
    } as unknown);
    assert.equal(bad.ok, false);
  });

  it("parseEvalSpec throws on invalid", () => {
    assert.throws(() => parseEvalSpec({ ...minimalSpec(), version: 0 } as unknown));
  });
});

describe("maintenance checks", () => {
  const spec = minimalSpec({
    testCases: [
      {
        id: "t1",
        name: "Tool required",
        input: "x",
        expectedBehavior: "use tool",
        requiredToolCalls: ["must_exist"],
        severity: "blocking",
      },
    ],
  });

  it("required tool call missing creates blocking failure", () => {
    const obs: Record<string, SimulatedCaseObservation> = {
      t1: { output: "ok", toolCalls: [], actions: [] },
    };
    const r = runMaintenanceCheck({
      runId: "r1",
      spec,
      observations: obs,
      generatedAt: new Date().toISOString(),
    });
    assert.equal(r.status, "failed");
    assert.ok(r.blockingFailures > 0);
  });

  it("forbidden action creates blocking failure", () => {
    const s = minimalSpec({
      testCases: [
        {
          id: "t1",
          name: "No delete",
          input: "x",
          expectedBehavior: "safe",
          forbiddenActions: ["delete_db"],
          severity: "blocking",
        },
      ],
    });
    const r = runMaintenanceCheck({
      runId: "r2",
      spec: s,
      observations: {
        t1: { output: "ok", toolCalls: [], actions: ["delete_db"] },
      },
      generatedAt: new Date().toISOString(),
    });
    assert.equal(r.status, "failed");
  });

  it("expected behavior/output mismatch creates failure", () => {
    const s = minimalSpec({
      testCases: [
        {
          id: "t1",
          name: "Out",
          input: "price",
          expectedBehavior: "state $199",
          expectedOutput: "199",
          severity: "blocking",
        },
      ],
    });
    const r = runMaintenanceCheck({
      runId: "r3",
      spec: s,
      observations: {
        t1: { output: "free", toolCalls: [], actions: [] },
      },
      generatedAt: new Date().toISOString(),
    });
    assert.equal(r.status, "failed");
  });

  it("evaluateTestCase exposes per-dimension results", () => {
    const tc = minimalSpec().testCases[0]!;
    const ev = evaluateTestCase(tc, {
      output: "greet",
      toolCalls: [],
      actions: [],
    });
    assert.equal(ev.behaviorOk, true);
  });
});

describe("assertProviderCallAllowed (routed calls)", () => {
  const gate = { ...baseBudgetGate };

  it("allows when within credits, monthly, per-run, allowlists", () => {
    const r = assertProviderCallAllowed({
      planId: "starter",
      subscriptionActive: true,
      creditsRemaining: 10,
      monthlyBudgetRemainingUsd: 50,
      currentRunSpendUsd: 0.5,
      estimatedCreditsRequired: 1,
      estimatedCostUsd: 0.25,
      provider: "openai",
      model: "gpt-4.1-mini",
      budgetGate: gate,
      pricingKnown: true,
    });
    assert.equal(r.decision, "allowed");
  });

  it("blocks when monthly budget would be exceeded", () => {
    const r = assertProviderCallAllowed({
      planId: "starter",
      creditsRemaining: 10,
      monthlyBudgetRemainingUsd: 0.1,
      currentRunSpendUsd: 0,
      estimatedCreditsRequired: 1,
      estimatedCostUsd: 1,
      provider: "openai",
      model: "gpt-4.1-mini",
      budgetGate: gate,
      pricingKnown: true,
    });
    assert.equal(r.decision, "blocked");
    assert.equal(r.reason, "monthly_budget_exceeded");
  });

  it("blocks when per-run budget would be exceeded", () => {
    const r = assertProviderCallAllowed({
      planId: "starter",
      creditsRemaining: 10,
      monthlyBudgetRemainingUsd: 50,
      currentRunSpendUsd: 1.5,
      estimatedCreditsRequired: 1,
      estimatedCostUsd: 0.6,
      provider: "openai",
      model: "gpt-4.1-mini",
      budgetGate: gate,
      pricingKnown: true,
    });
    assert.equal(r.decision, "blocked");
    assert.equal(r.reason, "per_run_budget_exceeded");
  });

  it("blocks when credits are exhausted", () => {
    const r = assertProviderCallAllowed({
      planId: "starter",
      creditsRemaining: 0,
      monthlyBudgetRemainingUsd: 50,
      currentRunSpendUsd: 0,
      estimatedCreditsRequired: 1,
      estimatedCostUsd: 0.1,
      provider: "openai",
      model: "gpt-4.1-mini",
      budgetGate: gate,
      pricingKnown: true,
    });
    assert.equal(r.decision, "blocked");
    assert.equal(r.reason, "credits_exhausted");
  });

  it("blocks provider/model allowlist violations", () => {
    const p = assertProviderCallAllowed({
      planId: "starter",
      creditsRemaining: 10,
      monthlyBudgetRemainingUsd: 50,
      currentRunSpendUsd: 0,
      estimatedCreditsRequired: 1,
      estimatedCostUsd: 0.1,
      provider: "other",
      model: "gpt-4.1-mini",
      budgetGate: gate,
      pricingKnown: true,
    });
    assert.equal(p.decision, "blocked");
    assert.equal(p.reason, "provider_not_allowed");
    const m = assertProviderCallAllowed({
      planId: "starter",
      creditsRemaining: 10,
      monthlyBudgetRemainingUsd: 50,
      currentRunSpendUsd: 0,
      estimatedCreditsRequired: 1,
      estimatedCostUsd: 0.1,
      provider: "openai",
      model: "gpt-4",
      budgetGate: gate,
      pricingKnown: true,
    });
    assert.equal(m.decision, "blocked");
    assert.equal(m.reason, "model_not_allowed");
  });

  it("misconfigured when plan entitlement unknown", () => {
    const r = assertProviderCallAllowed({
      planId: "unknown-plan",
      creditsRemaining: 10,
      monthlyBudgetRemainingUsd: 50,
      currentRunSpendUsd: 0,
      estimatedCreditsRequired: 1,
      estimatedCostUsd: 0.1,
      provider: "openai",
      model: "gpt-4.1-mini",
      budgetGate: gate,
      pricingKnown: true,
    });
    assert.equal(r.decision, "misconfigured");
  });

  it("misconfigured when pricing unknown and failClosed", () => {
    const r = assertProviderCallAllowed({
      planId: "starter",
      creditsRemaining: 10,
      monthlyBudgetRemainingUsd: 50,
      currentRunSpendUsd: 0,
      estimatedCreditsRequired: 1,
      estimatedCostUsd: 0.1,
      provider: "openai",
      model: "gpt-4.1-mini",
      budgetGate: gate,
      pricingKnown: false,
    });
    assert.equal(r.decision, "misconfigured");
    assert.equal(r.reason, "missing_pricing");
  });
});

describe("provider call ledger", () => {
  it("records completed and blocked calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ledger-"));
    const file = join(dir, "ledger.jsonl");
    await writeProviderCallLedger(file, []);
    await appendProviderCallLedgerEntry(file, {
      callId: "c1",
      runId: "r1",
      provider: "openai",
      model: "m",
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
      estimatedCostUsd: 0.1,
      status: "completed",
      actualCostUsd: 0.1,
      createdAt: new Date().toISOString(),
    });
    await appendProviderCallLedgerEntry(file, {
      callId: "c2",
      runId: "r1",
      provider: "openai",
      model: "m",
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
      estimatedCostUsd: 0.5,
      status: "blocked",
      blockReason: "monthly_budget_exceeded",
      actualCostUsd: 0,
      createdAt: new Date().toISOString(),
    });
    const rows = await readProviderCallLedger(file);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.status, "completed");
    assert.equal(rows[1]!.status, "blocked");
    assert.equal(rows[1]!.actualCostUsd, 0);
    await rm(dir, { recursive: true });
  });
});

describe("applyBudgetUsage still works (V1.9.1)", () => {
  it("applies usage immutably", () => {
    const s = {
      planId: "starter",
      creditsRemaining: 10,
      budgetRemainingUsd: 10,
      creditsUsed: 0,
      budgetUsedUsd: 0,
    };
    const n = applyBudgetUsage(s, { creditsUsed: 2, actualCostUsd: 1 });
    assert.equal(n.creditsRemaining, 8);
    assert.equal(s.creditsRemaining, 10);
  });
});

describe("Agent QA Firewall", () => {
  const toolSpec = minimalSpec({
    testCases: [
      {
        id: "t1",
        name: "Tool required",
        input: "x",
        expectedBehavior: "use tool",
        requiredToolCalls: ["must_exist"],
        severity: "blocking",
      },
    ],
  });

  it("missing required tool call creates block under enforce", () => {
    const r = runMaintenanceCheck({
      runId: "aq1",
      spec: toolSpec,
      observations: { t1: { output: "ok", toolCalls: [], actions: [] } },
      enforcementMode: "enforce",
      generatedAt: new Date().toISOString(),
    });
    assert.equal(r.agentQa?.gateDecision, "block");
    assert.ok((r.agentQa?.remediation ?? []).some((m) => m.includes("tool trace")));
  });

  it("wrong tool observed creates block under enforce", () => {
    const r = runMaintenanceCheck({
      runId: "aq-wrong",
      spec: toolSpec,
      observations: {
        t1: { output: "ok", toolCalls: ["wrong_tool"], actions: [] },
      },
      enforcementMode: "enforce",
      generatedAt: new Date().toISOString(),
    });
    assert.equal(r.agentQa?.gateDecision, "block");
    const wrong = r.checks.find((c) => c.id.startsWith("wrong_tool"));
    assert.ok(wrong);
  });

  it("no tool trace captured does not pass when tools required", () => {
    const r = runMaintenanceCheck({
      runId: "aq-notrace",
      spec: toolSpec,
      observations: { t1: { output: "ok", actions: [] } },
      enforcementMode: "enforce",
      generatedAt: new Date().toISOString(),
    });
    assert.notEqual(r.agentQa?.gateDecision, "pass");
    assert.ok(r.checks.some((c) => c.id.startsWith("tool_trace")));
  });

  it("forbidden action creates block in enforce mode", () => {
    const s = minimalSpec({
      testCases: [
        {
          id: "t1",
          name: "No refund",
          input: "x",
          expectedBehavior: "safe",
          forbiddenActions: ["issue_refund"],
          severity: "blocking",
        },
      ],
    });
    const r = runMaintenanceCheck({
      runId: "aq-forbidden",
      spec: s,
      observations: {
        t1: { output: "ok", toolCalls: [], actions: ["issue_refund"] },
      },
      enforcementMode: "enforce",
      generatedAt: new Date().toISOString(),
    });
    assert.equal(r.agentQa?.gateDecision, "block");
  });

  it("missing output evidence does not pass", () => {
    const s = minimalSpec({
      testCases: [
        {
          id: "t1",
          name: "Out",
          input: "x",
          expectedBehavior: "greet",
          expectedOutput: "hello",
          severity: "blocking",
        },
      ],
    });
    const r = runMaintenanceCheck({
      runId: "aq-out",
      spec: s,
      observations: { t1: { output: "", toolCalls: [], actions: [] } },
      evidenceCompleteness: { outputCaptured: false },
      enforcementMode: "enforce",
      generatedAt: new Date().toISOString(),
    });
    assert.notEqual(r.agentQa?.gateDecision, "pass");
  });

  it("missing budget state blocks", () => {
    const r = runMaintenanceCheck({
      runId: "aq-budget",
      spec: minimalSpec(),
      observations: { t1: { output: "greet", toolCalls: [], actions: [] } },
      routedCall: {
        callId: "c1",
        planId: "starter",
        creditsRemaining: 10,
        monthlyBudgetRemainingUsd: 50,
        currentRunSpendUsd: 0,
        estimatedCreditsRequired: 1,
        estimatedCostUsd: 0.1,
        provider: "openai",
        model: "gpt-4.1-mini",
        pricingKnown: true,
        budgetStatePresent: false,
        estimatedInputTokens: 1,
        estimatedOutputTokens: 1,
      },
      enforcementMode: "enforce",
      generatedAt: new Date().toISOString(),
    });
    assert.equal(r.agentQa?.gateDecision, "block");
  });

  it("missing pricing config blocks when failClosed", () => {
    const r = runMaintenanceCheck({
      runId: "aq-price",
      spec: minimalSpec(),
      observations: { t1: { output: "greet", toolCalls: [], actions: [] } },
      routedCall: {
        callId: "c1",
        planId: "starter",
        creditsRemaining: 10,
        monthlyBudgetRemainingUsd: 50,
        currentRunSpendUsd: 0,
        estimatedCreditsRequired: 1,
        estimatedCostUsd: 0.1,
        provider: "openai",
        model: "gpt-4.1-mini",
        pricingKnown: false,
        budgetStatePresent: true,
        estimatedInputTokens: 1,
        estimatedOutputTokens: 1,
      },
      enforcementMode: "enforce",
      generatedAt: new Date().toISOString(),
    });
    assert.equal(r.status, "misconfigured");
    assert.equal(r.agentQa?.gateDecision, "block");
  });

  it("unknown provider blocks when allowlist configured", () => {
    const gate = assertProviderCallAllowed({
      planId: "starter",
      creditsRemaining: 10,
      monthlyBudgetRemainingUsd: 50,
      currentRunSpendUsd: 0,
      estimatedCreditsRequired: 1,
      estimatedCostUsd: 0.1,
      provider: "unknown_vendor",
      model: "gpt-4.1-mini",
      budgetGate: baseBudgetGate,
      pricingKnown: true,
    });
    assert.equal(gate.decision, "blocked");
    assert.equal(gate.reasonCode, "provider_not_allowed");
    assert.ok(gate.remediation.length > 0);
  });

  it("ledger write failure does not silently pass", () => {
    const r = runMaintenanceCheck({
      runId: "aq-ledger",
      spec: minimalSpec(),
      observations: { t1: { output: "greet", toolCalls: [], actions: [] } },
      ledgerWriteSucceeded: false,
      enforcementMode: "enforce",
      generatedAt: new Date().toISOString(),
    });
    assert.equal(r.agentQa?.gateDecision, "block");
    assert.ok(r.checks.some((c) => c.id === "ledger:write"));
  });

  it("observe mode records findings without hard gate block", () => {
    const r = runMaintenanceCheck({
      runId: "aq-observe",
      spec: toolSpec,
      observations: { t1: { output: "ok", toolCalls: [], actions: [] } },
      enforcementMode: "observe",
      generatedAt: new Date().toISOString(),
    });
    assert.notEqual(r.agentQa?.gateDecision, "block");
    assert.ok((r.agentQa?.wouldBlockCount ?? 0) > 0);
  });

  it("enforce mode blocks on forbidden action", () => {
    const s = minimalSpec({
      testCases: [
        {
          id: "t1",
          name: "No delete",
          input: "x",
          expectedBehavior: "safe",
          forbiddenActions: ["delete_record"],
          severity: "blocking",
        },
      ],
    });
    const r = runMaintenanceCheck({
      runId: "aq-enforce",
      spec: s,
      observations: {
        t1: { output: "ok", toolCalls: [], actions: ["delete_record"] },
      },
      enforcementMode: "enforce",
      generatedAt: new Date().toISOString(),
    });
    assert.equal(r.agentQa?.gateDecision, "block");
    assert.equal(r.status, "failed");
  });

  it("manual_review is not treated as pass", () => {
    assert.equal(isPassingGateDecision("manual_review"), false);
    const r = runMaintenanceCheck({
      runId: "aq-review",
      spec: minimalSpec({
        testCases: [
          {
            id: "t1",
            name: "Behavior",
            input: "x",
            expectedBehavior: "very specific phrase required",
            severity: "warning",
          },
        ],
      }),
      observations: { t1: { output: "vague", toolCalls: [], actions: [] } },
      enforcementMode: "warn",
      generatedAt: new Date().toISOString(),
    });
    assert.equal(r.agentQa?.gateDecision, "manual_review");
    assert.equal(isPassingGateDecision(r.agentQa!.gateDecision), false);
  });

  it("remediation messages exist for failed checks", () => {
    const r = runMaintenanceCheck({
      runId: "aq-rem",
      spec: toolSpec,
      observations: { t1: { output: "ok", toolCalls: [], actions: [] } },
      enforcementMode: "enforce",
      generatedAt: new Date().toISOString(),
    });
    const failed = (r.agentQaChecks ?? []).filter((c) => c.enforcementOutcome !== "passed");
    assert.ok(failed.length > 0);
    assert.ok(failed.every((c) => c.remediation.length > 0));
  });
});

describe("gate:release exit codes", () => {
  it("exits 0 for healthy, 1 for failed, 2 for misconfigured", async () => {
    const cwd = process.cwd();
    const dir = await mkdtemp(join(tmpdir(), "gate-test-"));
    try {
      const healthy: MaintenanceRunResult = {
        runId: "h",
        specId: "s",
        specVersion: 1,
        workflowName: "w",
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
        generatedAt: new Date().toISOString(),
      };
      const failed: MaintenanceRunResult = { ...healthy, runId: "f", status: "failed" };
      const mis: MaintenanceRunResult = {
        ...healthy,
        runId: "m",
        status: "misconfigured",
      };

      const p0 = join(dir, "healthy.json");
      const p1 = join(dir, "failed.json");
      const p2 = join(dir, "mis.json");
      await writeFile(p0, JSON.stringify(healthy));
      await writeFile(p1, JSON.stringify(failed));
      await writeFile(p2, JSON.stringify(mis));

      const runGate = (p: string) =>
        spawnSync("npx", ["tsx", "apps/api/gate-release.ts", p], {
          cwd,
          encoding: "utf-8",
          shell: true,
        });

      assert.equal(runGate(p0).status ?? -1, 0);
      assert.equal(runGate(p1).status ?? -1, 1);
      assert.equal(runGate(p2).status ?? -1, 2);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

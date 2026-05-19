import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { join } from "node:path";
import { validateAgentQaSpec } from "./agent-qa-spec-validator";
import { validateEvalSpec, type EvalSpec, type EvalSpecBudgetGate } from "./eval-spec";

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

const TEMPLATE_DIR = join("examples", "eval-specs");

async function loadTemplate(name: string): Promise<unknown> {
  const raw = await readFile(join(TEMPLATE_DIR, name), "utf-8");
  return JSON.parse(raw) as unknown;
}

describe("Agent QA template validity", () => {
  it("support-agent-qa.spec.json validates", async () => {
    const r = validateAgentQaSpec(await loadTemplate("support-agent-qa.spec.json"));
    assert.equal(r.valid, true, r.errors.map((e) => e.message).join("; "));
  });

  it("tool-call-required.spec.json validates", async () => {
    const r = validateAgentQaSpec(await loadTemplate("tool-call-required.spec.json"));
    assert.equal(r.valid, true, r.errors.map((e) => e.message).join("; "));
  });

  it("forbidden-action.spec.json validates", async () => {
    const r = validateAgentQaSpec(await loadTemplate("forbidden-action.spec.json"));
    assert.equal(r.valid, true, r.errors.map((e) => e.message).join("; "));
  });

  it("agent-budget-gate.spec.json validates", async () => {
    const r = validateAgentQaSpec(await loadTemplate("agent-budget-gate.spec.json"));
    assert.equal(r.valid, true, r.errors.map((e) => e.message).join("; "));
  });

  it("pricing-plan-agent.spec.json validates", async () => {
    const r = validateAgentQaSpec(await loadTemplate("pricing-plan-agent.spec.json"));
    assert.equal(r.valid, true, r.errors.map((e) => e.message).join("; "));
  });
});

describe("Agent QA spec validator — invalid cases", () => {
  it("missing enforcementMode fails", () => {
    const { enforcementMode: _, ...rest } = agentQaMinimal();
    const r = validateAgentQaSpec(rest);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "missing_enforcement_mode"));
  });

  it("invalid enforcementMode fails", () => {
    const r = validateAgentQaSpec(
      agentQaMinimal({ enforcementMode: "strict" }),
    );
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "invalid_enforcement_mode"));
  });

  it("empty checks fails when checks array is present but empty", () => {
    const r = validateAgentQaSpec(agentQaMinimal({ checks: [] }));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "empty_checks"));
  });

  it("empty testCases and no checks fails", () => {
    const r = validateAgentQaSpec(
      agentQaMinimal({ checks: undefined, testCases: [] }),
    );
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "empty_checks"));
  });

  it("tool_call check without requiredToolCalls fails", () => {
    const r = validateAgentQaSpec(
      agentQaMinimal({
        requiredToolCalls: undefined,
        testCases: [
          {
            id: "t1",
            name: "One",
            input: "hi",
            expectedBehavior: "greet",
            severity: "blocking",
          },
        ],
        checks: [
          {
            id: "tool-only",
            name: "Tools",
            category: "tool_call",
            severity: "blocking",
          },
        ],
      }),
    );
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "missing_required_tool_calls"));
  });

  it("action check without forbiddenActions fails", () => {
    const r = validateAgentQaSpec(
      agentQaMinimal({
        forbiddenActions: undefined,
        testCases: [
          {
            id: "t1",
            name: "One",
            input: "hi",
            expectedBehavior: "greet",
            severity: "blocking",
          },
        ],
        checks: [
          {
            id: "act-only",
            name: "Actions",
            category: "action",
            severity: "blocking",
          },
        ],
      }),
    );
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "missing_forbidden_actions"));
  });

  it("budget check without budget limit fails", () => {
    const r = validateAgentQaSpec(
      agentQaMinimal({
        budgetGate: {
          monthlyBudgetLimitUsd: 0,
          failClosed: true,
        },
        checks: [
          {
            id: "budget-only",
            name: "Budget",
            category: "budget",
            severity: "blocking",
          },
        ],
      }),
    );
    assert.equal(r.valid, false);
    assert.ok(
      r.errors.some(
        (e) =>
          e.code === "missing_budget_limit" || e.code === "invalid_budget_limit",
      ),
    );
  });

  it("negative budget fails", () => {
    const r = validateAgentQaSpec(
      agentQaMinimal({
        budgetGate: {
          monthlyBudgetLimitUsd: -10,
          failClosed: true,
        },
      }),
    );
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "invalid_budget_limit"));
  });

  it("missing expected output fails for answer checks", () => {
    const r = validateAgentQaSpec(
      agentQaMinimal({
        testCases: [],
        checks: [
          {
            id: "ans",
            name: "Answer",
            category: "answer",
            severity: "blocking",
          },
        ],
      }),
    );
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "missing_expected_output"));
  });

  it("unsupported category fails", () => {
    const r = validateAgentQaSpec(
      agentQaMinimal({
        checks: [
          {
            id: "bad",
            name: "Bad",
            category: "sentiment",
            severity: "blocking",
          },
        ],
      }),
    );
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "unsupported_check_category"));
  });

  it("warnings do not invalidate spec", () => {
    const r = validateAgentQaSpec(
      agentQaMinimal({
        description: "x".repeat(2500),
      }),
    );
    assert.equal(r.valid, true);
    assert.ok(r.warnings.length > 0);
  });

  it("each error includes remediation", () => {
    const r = validateAgentQaSpec(agentQaMinimal({ enforcementMode: "invalid" }));
    assert.equal(r.valid, false);
    for (const err of r.errors) {
      assert.ok(err.remediation.length > 0);
    }
    assert.ok(r.remediation.length > 0);
  });
});

describe("legacy validateEvalSpec still accepts specs without enforcementMode", () => {
  it("minimal maintenance spec validates with validateEvalSpec", () => {
    const spec: EvalSpec = {
      specId: "legacy",
      specName: "Legacy",
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
      budgetGate: { ...baseBudgetGate },
      severity: "blocking",
    };
    assert.equal(validateEvalSpec(spec).ok, true);
  });
});

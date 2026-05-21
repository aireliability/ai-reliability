import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { parseEvalSpec } from "./eval-spec";
import {
  loadObservationsForAgentQaRun,
  mapObservationsToMaintenanceInput,
  validateAgentQaObservations,
} from "./agent-qa-observations";

const repoRoot = process.cwd();

describe("validateAgentQaObservations", () => {
  it("valid observation file passes", async () => {
    const raw = JSON.parse(
      await readFile(
        join(repoRoot, "examples/observations/support-agent-qa.pass.json"),
        "utf-8",
      ),
    );
    const spec = parseEvalSpec(
      JSON.parse(
        await readFile(
          join(repoRoot, "examples/eval-specs/support-agent-qa.spec.json"),
          "utf-8",
        ),
      ),
    );
    const r = validateAgentQaObservations(raw, spec);
    assert.equal(r.valid, true);
    assert.equal(r.errors.length, 0);
  });

  it("missing observation file fails on load", async () => {
    const spec = parseEvalSpec(
      JSON.parse(
        await readFile(
          join(repoRoot, "examples/eval-specs/support-agent-qa.spec.json"),
          "utf-8",
        ),
      ),
    );
    const loaded = await loadObservationsForAgentQaRun(
      join(repoRoot, "missing-obs.json"),
      spec,
      repoRoot,
    );
    assert.equal(loaded.ok, false);
    if (loaded.ok) return;
    assert.equal(loaded.reason, "missing_file");
  });

  it("invalid JSON fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "obs-badjson-"));
    try {
      const path = join(dir, "bad.json");
      await writeFile(path, "{");
      const spec = parseEvalSpec(
        JSON.parse(
          await readFile(
            join(repoRoot, "examples/eval-specs/support-agent-qa.spec.json"),
            "utf-8",
          ),
        ),
      );
      const loaded = await loadObservationsForAgentQaRun(path, spec, dir);
      assert.equal(loaded.ok, false);
      if (loaded.ok) return;
      assert.equal(loaded.reason, "invalid_json");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("malformed routedCalls cost fails", () => {
    const r = validateAgentQaObservations({
      observationId: "x",
      observedAt: "2026-05-20T00:00:00.000Z",
      routedCalls: [{ provider: "openai", model: "m", estimatedCostUsd: -1 }],
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "invalid_estimated_cost"));
  });

  it("malformed toolCalls fails", () => {
    const r = validateAgentQaObservations({
      observationId: "x",
      observedAt: "2026-05-20T00:00:00.000Z",
      toolCalls: [{}],
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "invalid_tool_call"));
  });

  it("missing answer output for answer checks fails", () => {
    const spec = parseEvalSpec(
      JSON.parse(
        JSON.stringify({
          specId: "s",
          specName: "S",
          workflowName: "w",
          environment: "development",
          version: 1,
          enforcementMode: "enforce",
          severity: "blocking",
          budgetGate: {
            monthlyBudgetLimitUsd: 10,
            failClosed: true,
          },
          checks: [{ id: "c1", name: "A", category: "answer", severity: "blocking" }],
          testCases: [
            {
              id: "t1",
              name: "T",
              input: "hi",
              expectedBehavior: "greet",
              expectedOutput: "hello",
              severity: "blocking",
            },
          ],
        }),
      ),
    );
    const r = validateAgentQaObservations(
      {
        observationId: "x",
        observedAt: "2026-05-20T00:00:00.000Z",
        testCases: { t1: { toolCalls: [] } },
      },
      spec,
    );
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "missing_case_output"));
  });

  it("missing tool trace for required tools fails", async () => {
    const spec = parseEvalSpec(
      JSON.parse(
        await readFile(
          join(repoRoot, "examples/eval-specs/tool-call-required.spec.json"),
          "utf-8",
        ),
      ),
    );
    const r = validateAgentQaObservations(
      {
        observationId: "x",
        observedAt: "2026-05-20T00:00:00.000Z",
        testCases: {
          "tc-reserve-stock": { agentOutput: "ok" },
          "tc-read-stock": {
            agentOutput: "ok",
            toolCalls: [{ name: "inventory_api_get_stock" }],
          },
          "tc-wrong-tool-scenario": {
            agentOutput: "ok",
            toolCalls: [{ name: "inventory_api_reserve" }],
          },
        },
      },
      spec,
    );
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === "missing_case_tool_trace"));
  });
});

describe("mapObservationsToMaintenanceInput", () => {
  it("maps tool and action names from observation objects", async () => {
    const spec = parseEvalSpec(
      JSON.parse(
        await readFile(
          join(repoRoot, "examples/eval-specs/forbidden-action.spec.json"),
          "utf-8",
        ),
      ),
    );
    const file = JSON.parse(
      await readFile(
        join(repoRoot, "examples/observations/forbidden-action.detected.json"),
        "utf-8",
      ),
    );
    const mapped = mapObservationsToMaintenanceInput(spec, file);
    assert.ok(mapped["tc-no-refund"]!.actions.includes("issue_refund"));
  });
});

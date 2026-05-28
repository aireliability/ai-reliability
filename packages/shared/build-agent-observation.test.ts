import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildAgentObservationFromRun,
  buildAgentObservationFromRunJson,
} from "./build-agent-observation";
import { validateAgentQaObservations } from "./agent-qa-observations";
import { parseEvalSpec } from "./eval-spec";

const repoRoot = join(process.cwd());

describe("build-agent-observation", () => {
  it("converts sample agent run into valid observation shape", async () => {
    const raw = JSON.parse(
      await readFile(
        join(
          repoRoot,
          "examples/integrations/agent-qa-firewall-basic/sample-agent-run.good.json",
        ),
        "utf-8",
      ),
    );
    const observation = buildAgentObservationFromRunJson(raw);
    assert.equal(observation.observationId, "sample-good-001");
    assert.ok(observation.testCases?.["tc-refund-window"]);
    assert.ok(observation.routedCalls?.length);
    assert.equal(observation.evidenceMetadata?.outputCaptured, true);

    const spec = parseEvalSpec(
      JSON.parse(
        await readFile(
          join(repoRoot, "examples/eval-specs/support-agent-qa.spec.json"),
          "utf-8",
        ),
      ),
    );
    const validation = validateAgentQaObservations(observation, spec);
    assert.equal(validation.valid, true, validation.errors.map((e) => e.message).join("; "));
  });

  it("maps tool and action arrays from agent run", () => {
    const observation = buildAgentObservationFromRun({
      observationId: "build-test-001",
      toolCalls: [{ name: "fetch_plan_catalog", status: "completed" }],
      actions: [{ name: "invent_plan_price", status: "observed" }],
      routedCalls: [
        {
          provider: "openai",
          model: "gpt-4.1-mini",
          estimatedCostUsd: 0.1,
        },
      ],
    });
    const tool0 = observation.toolCalls?.[0];
    const action0 = observation.actions?.[0];
    assert.equal(typeof tool0 === "string" ? tool0 : tool0?.name, "fetch_plan_catalog");
    assert.equal(typeof action0 === "string" ? action0 : action0?.name, "invent_plan_price");
    assert.equal(observation.routedCalls?.[0]?.estimatedCostUsd, 0.1);
  });
});

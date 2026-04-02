import type {
  EvalRun,
  ModelConfig,
  RuleResult,
  SampleResult,
  Usage,
} from "../../packages/shared/types";
import { createDataset, validateDataset } from "../../packages/shared/dataset";
import { generateModelOutput } from "../../packages/engine/generate";
import { buildSampleResult } from "../../packages/engine/classify";
import { completeRun } from "../../packages/engine/run";

export async function runDevOpenAIExample(): Promise<
  EvalRun & { finalStatus: "PASS" | "FAIL"; finalized: true }
> {
  const dataset = createDataset({
    id: "dataset_demo",
    name: "Demo Dataset",
    version: 1,
    samples: [
      { id: "s1", input: "2 + 2", expected: "4" },
      { id: "s2", input: "Say hello", expected: "hello" },
    ],
  });

  validateDataset(dataset);

  const run: EvalRun = {
    id: "run_demo",
    status: "RUNNING",
    accountId: "acct_demo",
    datasetId: dataset.id,
    processedSamples: 0,
    candidateFailures: 0,
    baselineFailures: 0,
    creditsReserved: 10,
    creditsUsed: 2,
  };

  const config: ModelConfig = {
    provider: "openai",
    model: "gpt-4.1-mini",
  };

  const results: SampleResult[] = [];

  for (const sample of dataset.samples) {
    const start = Date.now();
    const output = await generateModelOutput({
      sampleInput: sample.input,
      expected: sample.expected,
      config,
    });
    const latencyMs = Date.now() - start;

    const score = output.includes(sample.expected) ? 1 : 0;
    const classification = score === 1 ? "PASS" : "RULE_FAIL";

    const rules: RuleResult[] = [
      {
        ruleName: "expected_includes",
        passed: score === 1,
        confidence: 1,
        reason:
          score === 1
            ? "Output includes expected"
            : "Output does not include expected",
      },
    ];

    const usage: Usage = {
      tokensInput: 0,
      tokensOutput: 0,
      estimatedCost: 0,
      costVersion: "unknown",
    };

    results.push(
      buildSampleResult({
        runId: run.id,
        sampleId: sample.id,
        output,
        score,
        classification,
        latencyMs,
        usage,
        rules,
      }),
    );
  }

  return completeRun({ run, results });
}

runDevOpenAIExample()
  .then((result) => {
    console.log("OPENAI DEV RUN RESULT:\n", JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.error("OPENAI DEV RUN ERROR:", err);
  });

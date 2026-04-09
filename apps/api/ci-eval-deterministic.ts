import process from "node:process";
import type { EvalRun } from "../../packages/shared/types";
import { loadDatasetFromFile } from "../../packages/shared/loaders";
import { buildReport, formatReportHuman } from "../../packages/engine/report";
import { buildSampleResult } from "../../packages/engine/classify";
import { completeRun } from "../../packages/engine/run";

export async function runCiEvalDeterministic(input: {
  datasetPath: string;
}): Promise<number> {
  const dataset = await loadDatasetFromFile(input.datasetPath);

  const run: EvalRun = {
    id: "run_ci_eval_deterministic",
    status: "RUNNING",
    accountId: "acct_demo",
    datasetId: dataset.id,
    processedSamples: 0,
    candidateFailures: 0,
    baselineFailures: 0,
    creditsReserved: 10,
    creditsUsed: 2,
  };

  const results = dataset.samples.map((sample) => {
    const isS1 = sample.id === "s1";
    return buildSampleResult({
      runId: run.id,
      sampleId: sample.id,
      output: isS1 ? "4" : "goodbye",
      score: isS1 ? 1 : 0,
      classification: isS1 ? "PASS" : "RULE_FAIL",
      latencyMs: isS1 ? 10 : 12,
      usage: {
        tokensInput: isS1 ? 5 : 6,
        tokensOutput: isS1 ? 5 : 4,
        estimatedCost: 0.001,
        costVersion: "dev_v1",
      },
      rules: [
        {
          ruleName: "expected_match",
          passed: isS1,
          confidence: 1,
          reason: isS1
            ? "Matched expected output"
            : "Did not match expected output",
        },
      ],
    });
  });

  const finalizedRun = completeRun({ run, results });
  const report = buildReport({ run: finalizedRun, results });
  const human = formatReportHuman(report);
  console.log("CI DETERMINISTIC SUMMARY:\n" + human);
  console.log("\nCI DETERMINISTIC REPORT JSON:\n", JSON.stringify(report, null, 2));

  return report.status === "PASS" ? 0 : 1;
}

runCiEvalDeterministic({
  datasetPath: "datasets/demo-deterministic.json",
})
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((err) => {
    console.error("CI DETERMINISTIC ERROR:", err);
    process.exitCode = 1;
  });

import type { EvalRun, RuleResult, SampleResult, Usage } from "../../packages/shared/types";
import { loadDatasetFromFile } from "../../packages/shared/loaders";
import { buildReport, formatReportHuman } from "../../packages/engine/report";
import { buildSampleResult } from "../../packages/engine/classify";
import { completeRun } from "../../packages/engine/run";

export async function runDeterministicFromFiles(input: {
  datasetPath: string;
}): Promise<void> {
  const dataset = await loadDatasetFromFile(input.datasetPath);

  const run: EvalRun = {
    id: "run_file_deterministic",
    status: "RUNNING",
    accountId: "acct_demo",
    datasetId: dataset.id,
    processedSamples: 0,
    candidateFailures: 0,
    baselineFailures: 0,
    creditsReserved: 10,
    creditsUsed: 2,
  };

  const results: SampleResult[] = dataset.samples.map((sample) => {
    const isS1 = sample.id === "s1";

    const output = isS1 ? "4" : "goodbye";
    const score = isS1 ? 1 : 0;
    const classification = isS1 ? "PASS" : "RULE_FAIL";
    const reason = isS1 ? "Matched expected output" : "Did not match expected output";

    const usage: Usage = isS1
      ? { tokensInput: 5, tokensOutput: 5, estimatedCost: 0.001, costVersion: "dev_v1" }
      : { tokensInput: 6, tokensOutput: 4, estimatedCost: 0.001, costVersion: "dev_v1" };

    const rules: RuleResult[] = [
      { ruleName: "expected_match", passed: isS1, confidence: isS1 ? 1 : 0.9, reason },
    ];

    return buildSampleResult({
      runId: run.id,
      sampleId: sample.id,
      output,
      score,
      classification,
      latencyMs: isS1 ? 10 : 12,
      usage,
      rules,
    });
  });

  const finalizedRun = completeRun({ run, results });
  const report = buildReport({ run: finalizedRun, results });
  const human = formatReportHuman(report);
  console.log("FILE DETERMINISTIC SUMMARY:\n" + human);
  console.log("\nFILE DETERMINISTIC REPORT JSON:\n", JSON.stringify(report, null, 2));
}

runDeterministicFromFiles({
  datasetPath: "datasets/demo-deterministic.json",
}).catch((err) => {
  console.error("FILE DETERMINISTIC ERROR:", err);
});

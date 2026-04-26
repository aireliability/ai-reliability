import { loadDatasetFromFile } from "../../packages/shared/loaders";
import { buildSampleResult } from "../../packages/engine/classify";
import { completeRun } from "../../packages/engine/run";
import { buildReport } from "../../packages/engine/report";
import type { EvalRun } from "../../packages/shared/types";

async function runDemoFailures() {
  console.log("Running production checks...\n");

  const dataset = await loadDatasetFromFile("datasets/high-risk-production.json");

  const selectedIds = ["h2", "a3", "f1"];
  const samples = dataset.samples.filter((s) => selectedIds.includes(s.id));

  const run: EvalRun = {
    id: "run_demo_failures",
    status: "RUNNING",
    accountId: "acct_demo",
    datasetId: dataset.id,
    processedSamples: 0,
    candidateFailures: 0,
    baselineFailures: 0,
    creditsReserved: samples.length,
    creditsUsed: samples.length,
  };

  const results = samples.map((sample) => {
    const outputById: Record<string, string> = {
      h2: "Yes — we offer a $10/month plan.",
      a3: "Your order status is: shipped.",
      f1: "Yes, refunds are available up to 60 days after purchase.",
    };

    return buildSampleResult({
      runId: run.id,
      sampleId: sample.id,
      output: outputById[sample.id] ?? "",
      score: 0,
      classification: "RULE_FAIL",
      latencyMs: 12,
      usage: {
        tokensInput: 24,
        tokensOutput: 24,
        estimatedCost: 0.001,
        costVersion: "dev_v1",
      },
      rules: [
        {
          ruleName: "expected_match",
          passed: false,
          confidence: 1,
          reason: "Did not match expected output",
        },
      ],
    });
  });

  const finalizedRun = completeRun({ run, results });
  const report = buildReport({ run: finalizedRun, results });
  const totalTests = report.samples.length;
  const totalFailures = report.samples.filter((s) => !s.passed).length;

  console.log("❌ Failures detected:\n");
  console.log("1. Pricing logic failure");
  console.log("2. Tool execution skipped");
  console.log("3. Hallucinated field\n");
  console.log(`Total: ${totalFailures} failures out of ${totalTests} tests`);
}

runDemoFailures().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});


import process from "node:process";
import type { EvalRun } from "../../packages/shared/types";
import { loadDatasetFromFile, loadModelConfigFromFile } from "../../packages/shared/loaders";
import { executeRun } from "../../packages/engine/execute";
import { buildReport, formatReportHuman } from "../../packages/engine/report";

export async function runCiEval(input: {
  datasetPath: string;
  configPath: string;
}): Promise<number> {
  const dataset = await loadDatasetFromFile(input.datasetPath);
  const config = await loadModelConfigFromFile(input.configPath);

  const run: EvalRun = {
    id: "run_ci_eval",
    status: "RUNNING",
    accountId: "acct_demo",
    datasetId: dataset.id,
    processedSamples: 0,
    candidateFailures: 0,
    baselineFailures: 0,
    creditsReserved: 10,
    creditsUsed: 2,
  };

  const { finalizedRun, results } = await executeRun({ dataset, run, config });
  const report = buildReport({ run: finalizedRun, results });
  const human = formatReportHuman(report);
  console.log("CI EVAL SUMMARY:\n" + human);
  console.log("\nCI EVAL REPORT JSON:\n", JSON.stringify(report, null, 2));

  return report.status === "PASS" ? 0 : 1;
}

runCiEval({
  datasetPath: "datasets/demo-openai.json",
  configPath: "configs/openai.json",
})
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((err) => {
    console.error("CI EVAL ERROR:", err);
    process.exitCode = 1;
  });

import type { EvalRun } from "../../packages/shared/types";
import { loadDatasetFromFile, loadModelConfigFromFile } from "../../packages/shared/loaders";
import { executeRun } from "../../packages/engine/execute";
import { buildReport, formatReportHuman } from "../../packages/engine/report";

export async function runFromFiles(input: {
  datasetPath: string;
  configPath: string;
}): Promise<void> {
  const dataset = await loadDatasetFromFile(input.datasetPath);
  const config = await loadModelConfigFromFile(input.configPath);
  const run: EvalRun = {
    id: "run_file_demo",
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
  console.log("FILE RUN SUMMARY:\n" + human);
  console.log("\nFILE RUN REPORT JSON:\n", JSON.stringify(report, null, 2));
}

runFromFiles({
  datasetPath: "datasets/high-risk-production.json",
  configPath: "configs/openai.json",
}).catch((err) => {
  console.error("FILE RUN ERROR:", err);
});

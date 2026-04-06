import type {
  EvalRun,
  ModelConfig,
  SampleResult,
} from "../../packages/shared/types";
import { buildReport, formatReportHuman } from "../../packages/engine/report";
import { createDataset, validateDataset } from "../../packages/shared/dataset";
import { executeRun } from "../../packages/engine/execute";

export async function runDevOpenAIExample(): Promise<{
  finalizedRun: EvalRun & { finalStatus: "PASS" | "FAIL"; finalized: true };
  results: SampleResult[];
}> {
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

  return executeRun({
    dataset,
    run,
    config,
  });
}

runDevOpenAIExample()
  .then(({ finalizedRun, results }) => {
    const report = buildReport({ run: finalizedRun, results });
    const human = formatReportHuman(report);
    console.log("OPENAI DEV RUN SUMMARY:\n" + human);
    console.log("\nOPENAI DEV RUN REPORT JSON:\n", JSON.stringify(report, null, 2));
  })
  .catch((err) => {
    console.error("OPENAI DEV RUN ERROR:", err);
  });

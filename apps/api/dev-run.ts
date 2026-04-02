import type { EvalRun, Usage, RuleResult, SampleResult } from "../../packages/shared/types";
import { createDataset, validateDataset } from "../../packages/shared/dataset";
import { buildSampleResult } from "../../packages/engine/classify";
import { completeRun } from "../../packages/engine/run";

export function runDevExample(): EvalRun & {
  finalStatus: "PASS" | "FAIL";
  finalized: true;
} {
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

  const usage1: Usage = {
    tokensInput: 5,
    tokensOutput: 5,
    estimatedCost: 0.001,
    costVersion: "dev_v1",
  };
  const usage2: Usage = {
    tokensInput: 6,
    tokensOutput: 4,
    estimatedCost: 0.001,
    costVersion: "dev_v1",
  };

  const rulesPass: RuleResult[] = [
    { ruleName: "expected_match", passed: true, confidence: 1, reason: "Matched expected output" },
  ];
  const rulesFail: RuleResult[] = [
    { ruleName: "expected_match", passed: false, confidence: 0.9, reason: "Did not match expected output" },
  ];

  const r1: SampleResult = buildSampleResult({
    runId: run.id,
    sampleId: "s1",
    output: "4",
    score: 1,
    classification: "PASS",
    latencyMs: 10,
    usage: usage1,
    rules: rulesPass,
  });

  const r2: SampleResult = buildSampleResult({
    runId: run.id,
    sampleId: "s2",
    output: "goodbye",
    score: 0,
    classification: "RULE_FAIL",
    latencyMs: 12,
    usage: usage2,
    rules: rulesFail,
  });

  return completeRun({ run, results: [r1, r2] });
}


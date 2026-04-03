import type { EvalRun, Usage, RuleResult, SampleResult } from "../../packages/shared/types";
import { buildReport } from "../../packages/engine/report";
import { buildSampleResult } from "../../packages/engine/classify";
import { completeRun } from "../../packages/engine/run";

const run: EvalRun = {
  id: "run_demo",
  status: "RUNNING",
  accountId: "acct_demo",
  datasetId: "dataset_demo",
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
  {
    ruleName: "expected_match",
    passed: true,
    confidence: 1,
    reason: "Matched expected output",
  },
];
const rulesFail: RuleResult[] = [
  {
    ruleName: "expected_match",
    passed: false,
    confidence: 0.9,
    reason: "Did not match expected output",
  },
];

const results: SampleResult[] = [
  buildSampleResult({
    runId: run.id,
    sampleId: "s1",
    output: "4",
    score: 1,
    classification: "PASS",
    latencyMs: 10,
    usage: usage1,
    rules: rulesPass,
  }),
  buildSampleResult({
    runId: run.id,
    sampleId: "s2",
    output: "goodbye",
    score: 0,
    classification: "RULE_FAIL",
    latencyMs: 12,
    usage: usage2,
    rules: rulesFail,
  }),
];

const finalizedRun = completeRun({ run, results });
const report = buildReport({ run: finalizedRun, results });
console.log("DEV RUN REPORT:\n", JSON.stringify(report, null, 2));


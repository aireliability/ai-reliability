import type { Classification, Usage, RuleResult, SampleResult } from "../shared/types";
import { didSampleFail, isPassingClassification } from "../shared/invariants";

export function toPassed(classification: Classification): boolean {
  return isPassingClassification(classification);
}

export function toDidFail(classification: Classification): boolean {
  return didSampleFail(classification);
}

export function buildSampleResult(input: {
  runId: string;
  sampleId: string;
  output: string;
  score: number;
  classification: Classification;
  latencyMs: number;
  usage: Usage;
  rules: RuleResult[];
  errorType?: "TIMEOUT" | "MODEL_ERROR" | "VALIDATION_ERROR" | "SYSTEM_ERROR";
}): SampleResult {
  const passed = toPassed(input.classification);

  return {
    runId: input.runId,
    sampleId: input.sampleId,
    output: input.output,
    score: input.score,
    classification: input.classification,
    passed,
    latencyMs: input.latencyMs,
    usage: input.usage,
    rules: input.rules,
    errorType: input.errorType,
  };
}


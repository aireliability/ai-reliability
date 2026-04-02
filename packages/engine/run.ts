import type { EvalRun, SampleResult } from "../shared/types";
import { finalizeRun } from "./finalize";

export function summarizeSampleResults(results: SampleResult[]): {
  processedSamples: number;
  candidateFailures: number;
} {
  const processedSamples = results.length;
  const candidateFailures = results.filter((r) => r.passed === false).length;
  return { processedSamples, candidateFailures };
}

export function computeDelta(input: {
  candidateFailures: number;
  baselineFailures: number;
  processedSamples: number;
}): number {
  if (input.processedSamples === 0) return 0;

  const candidateRate =
    input.candidateFailures / input.processedSamples;
  const baselineRate = input.baselineFailures / input.processedSamples;
  return candidateRate - baselineRate;
}

export function completeRun(input: {
  run: EvalRun;
  results: SampleResult[];
}): EvalRun & { finalStatus: "PASS" | "FAIL"; finalized: true } {
  const summary = summarizeSampleResults(input.results);
  const delta = computeDelta({
    candidateFailures: summary.candidateFailures,
    baselineFailures: input.run.baselineFailures,
    processedSamples: summary.processedSamples,
  });

  const nextRun: EvalRun = {
    ...input.run,
    processedSamples: summary.processedSamples,
    candidateFailures: summary.candidateFailures,
  };

  return finalizeRun({ run: nextRun, delta });
}


import type { Classification, FinalResult } from "./types";

export function isPassingClassification(classification: Classification): boolean {
  return classification === "PASS";
}

export function didSampleFail(classification: Classification): boolean {
  return classification !== "PASS";
}

export function assertCreditsUsage(
  creditsReserved: number,
  creditsUsed: number,
): void {
  if (creditsReserved < 0) {
    throw new Error("creditsReserved cannot be negative");
  }
  if (creditsUsed < 0) {
    throw new Error("creditsUsed cannot be negative");
  }
  if (creditsUsed > creditsReserved) {
    throw new Error("creditsUsed cannot exceed creditsReserved");
  }
}

export function assertBaselineCompleteness(
  datasetSampleCount: number,
  baselineSampleCount: number,
): void {
  if (datasetSampleCount !== baselineSampleCount) {
    throw new Error("baselineSampleCount must match datasetSampleCount");
  }
}

export function assertRunFinalizationAllowed(finalized?: boolean): void {
  if (finalized === true) {
    throw new Error("run finalization is already complete");
  }
}

export function assertValidFinalStatus(
  status: "PASS" | "FAIL" | undefined,
): void {
  if (status === undefined) return;
  if (status !== "PASS" && status !== "FAIL") {
    throw new Error("invalid finalStatus; expected PASS or FAIL");
  }
}

export function getFinalResult(delta: number): FinalResult {
  if (delta > 0.05) {
    return { status: "FAIL", delta };
  }
  return { status: "PASS", delta };
}

export function assertProcessedSamples(processedSamples: number): void {
  if (processedSamples < 0) {
    throw new Error("processedSamples cannot be negative");
  }
}

export function assertFailureCounts(
  candidateFailures: number,
  baselineFailures: number,
  processedSamples: number,
): void {
  if (candidateFailures < 0) {
    throw new Error("candidateFailures cannot be negative");
  }
  if (baselineFailures < 0) {
    throw new Error("baselineFailures cannot be negative");
  }
  if (candidateFailures > processedSamples) {
    throw new Error("candidateFailures cannot exceed processedSamples");
  }
  if (baselineFailures > processedSamples) {
    throw new Error("baselineFailures cannot exceed processedSamples");
  }
}


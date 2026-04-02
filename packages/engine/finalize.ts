import type { EvalRun } from "../shared/types";
import {
  assertCreditsUsage,
  assertFailureCounts,
  assertProcessedSamples,
  assertRunFinalizationAllowed,
  assertValidFinalStatus,
  getFinalResult,
} from "../shared/invariants";

export function validateRunForFinalization(input: {
  finalized?: boolean;
  creditsReserved: number;
  creditsUsed: number;
  processedSamples: number;
  candidateFailures: number;
  baselineFailures: number;
}): void {
  assertRunFinalizationAllowed(input.finalized);
  assertCreditsUsage(input.creditsReserved, input.creditsUsed);
  assertProcessedSamples(input.processedSamples);
  assertFailureCounts(
    input.candidateFailures,
    input.baselineFailures,
    input.processedSamples,
  );
}

export function finalizeRun(
  input: { run: EvalRun; delta: number },
): EvalRun & { finalStatus: "PASS" | "FAIL"; finalized: true } {
  validateRunForFinalization({
    finalized: input.run.finalized,
    creditsReserved: input.run.creditsReserved,
    creditsUsed: input.run.creditsUsed,
    processedSamples: input.run.processedSamples,
    candidateFailures: input.run.candidateFailures,
    baselineFailures: input.run.baselineFailures,
  });

  const final = getFinalResult(input.delta);
  const finalStatus = final.status;

  assertValidFinalStatus(finalStatus);

  return {
    ...input.run,
    finalStatus,
    finalized: true,
  };
}


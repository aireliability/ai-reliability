import type { Classification, EvalRun, SampleResult } from "../shared/types";

export type ReportSample = {
  sampleId: string;
  passed: boolean;
  classification: Classification;
  output: string;
  score: number;
  reason?: string;
};

export type EvalReport = {
  runId: string;
  status: "PASS" | "FAIL";
  processedSamples: number;
  candidateFailures: number;
  baselineFailures: number;
  samples: ReportSample[];
};

export function buildReport(input: {
  run: EvalRun & { finalStatus: "PASS" | "FAIL"; finalized: true };
  results: SampleResult[];
}): EvalReport {
  const samples: ReportSample[] = input.results.map((r) => {
    const reason = r.rules?.[0]?.reason;

    return {
      sampleId: r.sampleId,
      passed: r.passed,
      classification: r.classification,
      output: r.output,
      score: r.score,
      reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
    };
  });

  return {
    runId: input.run.id,
    status: input.run.finalStatus,
    processedSamples: input.run.processedSamples,
    candidateFailures: input.run.candidateFailures,
    baselineFailures: input.run.baselineFailures,
    samples,
  };
}


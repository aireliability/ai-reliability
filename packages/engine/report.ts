import type { Classification, EvalRun, SampleResult } from "../shared/types";
import type { BudgetState } from "../shared/budget-gate";

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
  budget?: Pick<
    BudgetState,
    "planId" | "creditsRemaining" | "budgetRemainingUsd"
  >;
};

export function buildReport(input: {
  run: EvalRun & { finalStatus: "PASS" | "FAIL"; finalized: true };
  results: SampleResult[];
  budget?: BudgetState;
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
    ...(input.budget !== undefined
      ? {
          budget: {
            planId: input.budget.planId,
            creditsRemaining: input.budget.creditsRemaining,
            budgetRemainingUsd: input.budget.budgetRemainingUsd,
          },
        }
      : {}),
  };
}

export function formatReportHuman(report: EvalReport): string {
  const total = report.samples.length;
  const failed = report.samples.filter((s) => !s.passed).length;
  const passed = total - failed;
  const budgetLine =
    report.budget !== undefined
      ? `Budget (${report.budget.planId}): credits remaining=${report.budget.creditsRemaining}, USD remaining=${report.budget.budgetRemainingUsd.toFixed(2)}`
      : undefined;
  const firstLine = `${report.status} — ${failed} failed, ${passed} passed (${total} total)`;

  const failingBlocks = report.samples
    .filter((s) => !s.passed)
    .map((s) => {
      const lines = [`${s.sampleId}:`, `Output: ${s.output}`];
      if (s.reason !== undefined && s.reason.length > 0) {
        lines.push(`Reason: ${s.reason}`);
      }
      return lines.join("\n");
    });

  const head = [firstLine, budgetLine].filter(Boolean).join("\n");

  if (failingBlocks.length === 0) {
    return head;
  }

  return [head, failingBlocks.join("\n\n")].join("\n\n");
}


import type {
  EvalDataset,
  EvalRun,
  ModelConfig,
  RuleResult,
  SampleResult,
  Usage,
} from "../shared/types";
import type { BudgetState } from "../shared/budget-gate";
import { generateModelOutput } from "./generate";
import { buildSampleResult } from "./classify";
import { completeRun } from "./run";

export async function executeRun(input: {
  dataset: EvalDataset;
  run: EvalRun;
  config: ModelConfig;
}): Promise<{
  finalizedRun: EvalRun & { finalStatus: "PASS" | "FAIL"; finalized: true };
  results: SampleResult[];
  budget?: BudgetState;
}> {
  const results: SampleResult[] = [];
  let budget: BudgetState | undefined = input.config.budget;

  for (const sample of input.dataset.samples) {
    const start = Date.now();
    const { output, budget: nextBudget } = await generateModelOutput({
      sampleInput: sample.input,
      expected: sample.expected,
      config: input.config,
      budget,
    });
    if (nextBudget !== undefined) {
      budget = nextBudget;
    }
    const latencyMs = Date.now() - start;

    const score = output.includes(sample.expected) ? 1 : 0;
    const classification = score === 1 ? "PASS" : "RULE_FAIL";

    const rules: RuleResult[] = [
      {
        ruleName: "expected_includes",
        passed: score === 1,
        confidence: 1,
        reason:
          score === 1
            ? "Output includes expected"
            : "Output does not include expected",
      },
    ];

    const usage: Usage = {
      tokensInput: 0,
      tokensOutput: 0,
      estimatedCost: 0,
      costVersion: "unknown",
    };

    results.push(
      buildSampleResult({
        runId: input.run.id,
        sampleId: sample.id,
        output,
        score,
        classification,
        latencyMs,
        usage,
        rules,
      }),
    );
  }

  const finalizedRun = completeRun({ run: input.run, results });

  return {
    finalizedRun,
    results,
    ...(budget !== undefined ? { budget } : {}),
  };
}

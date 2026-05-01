import type { ModelConfig } from "../shared/types";
import {
  assertBudgetAvailable,
  applyBudgetUsage,
  DEFAULT_MODEL_CALL_CREDITS_REQUIRED,
  DEFAULT_MODEL_CALL_ESTIMATE_USD,
  type BudgetState,
} from "../shared/budget-gate";
import { generateTextWithOpenAI } from "../shared/openai";

export function buildPrompt(input: {
  sampleInput: string;
  expected: string;
}): string {
  return [
    "Input:",
    input.sampleInput,
    "",
    "Expected:",
    input.expected,
  ].join("\n");
}

export async function generateModelOutput(input: {
  sampleInput: string;
  expected: string;
  config: ModelConfig;
  budget?: BudgetState;
}): Promise<{ output: string; budget?: BudgetState }> {
  const estimate = {
    creditsRequired: DEFAULT_MODEL_CALL_CREDITS_REQUIRED,
    estimatedCostUsd: DEFAULT_MODEL_CALL_ESTIMATE_USD,
  };

  if (input.budget !== undefined) {
    assertBudgetAvailable(input.budget, estimate);
  }

  const prompt = buildPrompt({
    sampleInput: input.sampleInput,
    expected: input.expected,
  });

  const output = await generateTextWithOpenAI({
    model: input.config.model,
    prompt,
  });

  if (input.budget !== undefined) {
    const budget = applyBudgetUsage(input.budget, {
      creditsUsed: DEFAULT_MODEL_CALL_CREDITS_REQUIRED,
      actualCostUsd: DEFAULT_MODEL_CALL_ESTIMATE_USD,
    });
    return { output, budget };
  }

  return { output };
}


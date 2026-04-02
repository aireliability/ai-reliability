import type { ModelConfig } from "../shared/types";
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
}): Promise<string> {
  const prompt = buildPrompt({
    sampleInput: input.sampleInput,
    expected: input.expected,
  });

  return generateTextWithOpenAI({
    model: input.config.model,
    prompt,
  });
}


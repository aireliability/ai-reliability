import { readFile } from "node:fs/promises";
import type { DatasetSample, EvalDataset, ModelConfig } from "./types";
import { createDataset, validateDataset } from "./dataset";

export async function loadDatasetFromFile(path: string): Promise<EvalDataset> {
  const raw = await readFile(path, "utf-8");
  const data = JSON.parse(raw) as {
    id: string;
    name: string;
    version: number;
    samples: DatasetSample[];
  };
  const dataset = createDataset(data);
  validateDataset(dataset);
  return dataset;
}

export async function loadModelConfigFromFile(path: string): Promise<ModelConfig> {
  const raw = await readFile(path, "utf-8");
  const data = JSON.parse(raw) as {
    provider: string;
    model: string;
    budget?: {
      planId: string;
      creditsRemaining: number;
      budgetRemainingUsd: number;
      creditsUsed: number;
      budgetUsedUsd: number;
    };
  };
  const config: ModelConfig = { provider: data.provider, model: data.model };
  if (data.budget !== undefined) {
    config.budget = { ...data.budget };
  }
  return config;
}

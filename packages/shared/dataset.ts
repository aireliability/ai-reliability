import type { DatasetSample, EvalDataset } from "./types";

export function createDataset(input: {
  id: string;
  name: string;
  version: number;
  samples: DatasetSample[];
}): EvalDataset {
  return {
    id: input.id,
    name: input.name,
    version: input.version,
    samples: input.samples,
  };
}

export function assertDatasetHasSamples(dataset: EvalDataset): void {
  if (dataset.samples.length === 0) {
    throw new Error("dataset must include at least one sample");
  }
}

export function assertDatasetSampleIdsUnique(dataset: EvalDataset): void {
  const seen = new Set<string>();
  for (const sample of dataset.samples) {
    if (seen.has(sample.id)) {
      throw new Error(`duplicate dataset sample id: ${sample.id}`);
    }
    seen.add(sample.id);
  }
}

export function validateDataset(dataset: EvalDataset): void {
  assertDatasetHasSamples(dataset);
  assertDatasetSampleIdsUnique(dataset);
}


export type RunStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "STOPPED";

export type Classification =
  | "PASS"
  | "RULE_FAIL"
  | "MINOR_REGRESSION"
  | "MAJOR_REGRESSION"
  | "ERROR";

export interface Usage {
  tokensInput: number;
  tokensOutput: number;
  estimatedCost: number;
  costVersion: string;
}

export interface DatasetSample {
  id: string;
  input: string;
  expected: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface EvalDataset {
  id: string;
  name: string;
  version: number;
  samples: DatasetSample[];
}

export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface RuleResult {
  ruleName: string;
  passed: boolean;
  confidence: number;
  reason: string;
}

export interface SampleResult {
  runId: string;
  sampleId: string;
  output: string;
  score: number;
  classification: Classification;
  passed: boolean;
  latencyMs: number;
  usage: Usage;
  rules: RuleResult[];
  errorType?:
    | "TIMEOUT"
    | "MODEL_ERROR"
    | "VALIDATION_ERROR"
    | "SYSTEM_ERROR";
}

export interface EvalRun {
  id: string;
  status: RunStatus;
  accountId: string;
  datasetId: string;
  processedSamples: number;
  candidateFailures: number;
  baselineFailures: number;
  creditsReserved: number;
  creditsUsed: number;
  finalStatus?: "PASS" | "FAIL";
  finalized?: boolean;
}

export interface FinalResult {
  status: "PASS" | "FAIL";
  delta: number;
}


import type {
  AgentQaActionObservation,
  AgentQaObservationEvidenceMetadata,
  AgentQaObservationFile,
  AgentQaRoutedCallObservation,
  AgentQaTestCaseObservation,
  AgentQaToolCallObservation,
} from "./agent-qa-observations";

export interface AgentRunToolCallInput {
  name: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  timestamp?: string;
}

export interface AgentRunActionInput {
  name: string;
  status?: string;
  approved?: boolean;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentRunRoutedCallInput {
  provider: string;
  model: string;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  status?: string;
  timestamp?: string;
  currentRunSpendUsd?: number;
  creditsRequired?: number;
}

export interface AgentRunTestCaseInput {
  agentOutput?: string;
  toolCalls?: AgentRunToolCallInput[] | string[];
  actions?: AgentRunActionInput[] | string[];
}

/** Customer-facing agent run trace shape before conversion to Day 12 observations. */
export interface AgentRunInput {
  observationId: string;
  observedAt?: string;
  specId?: string;
  workflowName?: string;
  environment?: string;
  agentOutput?: string;
  toolCalls?: AgentRunToolCallInput[] | string[];
  actions?: AgentRunActionInput[] | string[];
  routedCalls?: AgentRunRoutedCallInput[];
  testCases?: Record<string, AgentRunTestCaseInput>;
  evidenceMetadata?: Partial<AgentQaObservationEvidenceMetadata>;
  notes?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeToolCalls(
  raw: AgentRunToolCallInput[] | string[] | undefined,
): AgentQaToolCallObservation[] | undefined {
  if (raw === undefined) return undefined;
  return raw.map((item) =>
    typeof item === "string"
      ? { name: item, status: "completed" }
      : {
          name: item.name,
          status: item.status ?? "completed",
          input: item.input,
          output: item.output,
          timestamp: item.timestamp,
        },
  );
}

function normalizeActions(
  raw: AgentRunActionInput[] | string[] | undefined,
): AgentQaActionObservation[] | undefined {
  if (raw === undefined) return undefined;
  return raw.map((item) =>
    typeof item === "string"
      ? { name: item, status: "observed" }
      : {
          name: item.name,
          status: item.status ?? "observed",
          approved: item.approved,
          timestamp: item.timestamp,
          metadata: item.metadata,
        },
  );
}

function normalizeTestCases(
  raw: Record<string, AgentRunTestCaseInput> | undefined,
): Record<string, AgentQaTestCaseObservation> | undefined {
  if (!raw) return undefined;
  const out: Record<string, AgentQaTestCaseObservation> = {};
  for (const [id, tc] of Object.entries(raw)) {
    out[id] = {
      agentOutput: tc.agentOutput,
      toolCalls: normalizeToolCalls(tc.toolCalls),
      actions: normalizeActions(tc.actions),
    };
  }
  return out;
}

function defaultEvidenceMetadata(
  partial?: Partial<AgentQaObservationEvidenceMetadata>,
): AgentQaObservationEvidenceMetadata {
  return {
    outputCaptured: partial?.outputCaptured ?? true,
    toolTraceCaptured: partial?.toolTraceCaptured ?? true,
    actionTraceCaptured: partial?.actionTraceCaptured ?? true,
    budgetStateLoaded: partial?.budgetStateLoaded ?? true,
    pricingConfigLoaded: partial?.pricingConfigLoaded ?? true,
    ledgerWriteSucceeded: partial?.ledgerWriteSucceeded ?? true,
  };
}

/**
 * Convert a simple agent-run JSON document into the Day 12 observation file format.
 */
export function buildAgentObservationFromRun(input: AgentRunInput): AgentQaObservationFile {
  if (!input.observationId?.trim()) {
    throw new Error("observationId is required on agent run input.");
  }

  const routedCalls: AgentQaRoutedCallObservation[] | undefined = input.routedCalls?.map(
    (rc) => ({
      provider: rc.provider,
      model: rc.model,
      estimatedCostUsd: rc.estimatedCostUsd,
      actualCostUsd: rc.actualCostUsd,
      inputTokens: rc.inputTokens,
      outputTokens: rc.outputTokens,
      status: rc.status ?? "completed",
      timestamp: rc.timestamp,
      currentRunSpendUsd: rc.currentRunSpendUsd,
      creditsRequired: rc.creditsRequired,
    }),
  );

  return {
    observationId: input.observationId.trim(),
    observedAt: input.observedAt ?? new Date().toISOString(),
    specId: input.specId,
    workflowName: input.workflowName,
    environment: input.environment,
    agentOutput: input.agentOutput,
    toolCalls: normalizeToolCalls(input.toolCalls),
    actions: normalizeActions(input.actions),
    routedCalls,
    testCases: normalizeTestCases(input.testCases),
    evidenceMetadata: defaultEvidenceMetadata(input.evidenceMetadata),
    notes: input.notes,
  };
}

export function parseAgentRunInput(raw: unknown): AgentRunInput {
  if (!isPlainObject(raw)) {
    throw new Error("Agent run input must be a JSON object.");
  }
  if (typeof raw.observationId !== "string" || !raw.observationId.trim()) {
    throw new Error("Agent run input requires observationId.");
  }
  return raw as unknown as AgentRunInput;
}

export function buildAgentObservationFromRunJson(raw: unknown): AgentQaObservationFile {
  return buildAgentObservationFromRun(parseAgentRunInput(raw));
}

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  REMEDIATION_BUDGET_STATE,
  REMEDIATION_LEDGER_WRITE,
  REMEDIATION_PRICING_CONFIG,
  budgetReasonToRemediation,
} from "./agent-qa";
import type { AgentQaRoutedCallObservation } from "./agent-qa-observations";
import {
  applyBudgetUsage,
  assertProviderCallAllowed,
  DEFAULT_MODEL_CALL_CREDITS_REQUIRED,
  DEFAULT_MODEL_CALL_ESTIMATE_USD,
  type BudgetState,
  type ProviderCallGateResult,
} from "./budget-gate";
import type { EvalSpecBudgetGate } from "./eval-spec";
import type { EnforcementOutcome, GateDecision } from "./maintenance-result";
import {
  appendProviderCallLedgerEntry,
  type ProviderCallLedgerEntry,
} from "./provider-call-ledger";

export const ROUTED_CALL_RESULT_SCHEMA_VERSION = 1;

export interface ProviderExecutionResult {
  actualInputTokens?: number;
  actualOutputTokens?: number;
  actualCostUsd?: number;
  creditsUsed?: number;
  output?: string;
}

export interface RoutedProviderCallInput {
  callId?: string;
  runId: string;
  provider: string;
  model: string;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  inputTokens?: number;
  maxOutputTokens?: number;
  estimatedCostUsd?: number;
  estimatedCreditsRequired?: number;
  currentRunSpendUsd?: number;
  /** When null/undefined and failClosed, gate blocks before execution. */
  budgetState?: BudgetState | null;
  budgetGate: EvalSpecBudgetGate;
  pricingKnown?: boolean;
  subscriptionActive?: boolean;
  ledgerPath?: string;
  /** When true (default if ledgerPath set), ledger write failure blocks execution. */
  ledgerRequired?: boolean;
  specId?: string;
  workflowName?: string;
  environment?: string;
}

export interface RoutedProviderCallResult {
  callId: string;
  runId: string;
  provider: string;
  model: string;
  gateDecision: GateDecision;
  enforcementOutcome: EnforcementOutcome;
  reasonCode: string;
  allowed: boolean;
  executed: boolean;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  estimatedCreditsRequired: number;
  actualCostUsd?: number;
  budgetRemainingUsd?: number;
  budgetStateAfter?: BudgetState;
  ledgerEntry?: ProviderCallLedgerEntry;
  providerResult?: ProviderExecutionResult;
  remediation: string[];
  specId?: string;
  workflowName?: string;
  environment?: string;
}

export interface RoutedCallResultArtifact {
  artifactType: "routed_call_result";
  schemaVersion: number;
  generatedAt: string;
  runId: string;
  source: string;
  workflowName?: string;
  environment?: string;
  specId?: string;
  provider: string;
  model: string;
  gateDecision: GateDecision;
  enforcementOutcome: EnforcementOutcome;
  allowed: boolean;
  executed: boolean;
  reasonCode: string;
  remediation: string[];
  estimatedCostUsd: number;
  actualCostUsd?: number;
  relatedArtifacts?: {
    providerCallLedger?: string;
    budgetState?: string;
  };
}

function blockResult(
  input: RoutedProviderCallInput,
  reasonCode: string,
  extraRemediation: string[] = [],
): RoutedProviderCallResult {
  const tokens = resolveTokenEstimates(input);
  const remediation = [
    ...budgetReasonToRemediation(reasonCode),
    ...extraRemediation,
  ].filter((v, i, a) => a.indexOf(v) === i);

  return {
    callId: input.callId ?? `call-${randomUUID()}`,
    runId: input.runId,
    provider: input.provider,
    model: input.model,
    gateDecision: "block",
    enforcementOutcome: "blocked",
    reasonCode,
    allowed: false,
    executed: false,
    estimatedInputTokens: tokens.input,
    estimatedOutputTokens: tokens.output,
    estimatedCostUsd: resolveEstimatedCostUsd(input, tokens),
    estimatedCreditsRequired:
      input.estimatedCreditsRequired ?? DEFAULT_MODEL_CALL_CREDITS_REQUIRED,
    remediation,
    specId: input.specId,
    workflowName: input.workflowName,
    environment: input.environment,
  };
}

function resolveTokenEstimates(input: RoutedProviderCallInput): {
  input: number;
  output: number;
} {
  return {
    input: input.estimatedInputTokens ?? input.inputTokens ?? 0,
    output: input.estimatedOutputTokens ?? input.maxOutputTokens ?? 0,
  };
}

function resolveEstimatedCostUsd(
  input: RoutedProviderCallInput,
  tokens?: { input: number; output: number },
): number {
  if (input.estimatedCostUsd !== undefined) return input.estimatedCostUsd;
  const t = tokens ?? resolveTokenEstimates(input);
  if (t.input > 0 || t.output > 0) {
    return Math.max(DEFAULT_MODEL_CALL_ESTIMATE_USD, (t.input + t.output) * 0.000001);
  }
  return DEFAULT_MODEL_CALL_ESTIMATE_USD;
}

function validateRoutedCallInput(input: RoutedProviderCallInput): ProviderCallGateResult | null {
  if (!input.provider?.trim()) {
    return {
      decision: "blocked",
      reason: "unknown_provider",
      reasonCode: "unknown_provider",
      gateDecision: "block",
      enforcementOutcome: "blocked",
      remediation: ["Provide a non-empty provider for routed calls through the gate."],
    };
  }
  if (!input.model?.trim()) {
    return {
      decision: "blocked",
      reason: "unknown_model",
      reasonCode: "unknown_model",
      gateDecision: "block",
      enforcementOutcome: "blocked",
      remediation: ["Provide a non-empty model for routed calls through the gate."],
    };
  }

  const tokens = resolveTokenEstimates(input);
  if (
    (input.estimatedInputTokens !== undefined && !Number.isFinite(input.estimatedInputTokens)) ||
    (input.estimatedOutputTokens !== undefined && !Number.isFinite(input.estimatedOutputTokens)) ||
    (input.inputTokens !== undefined && !Number.isFinite(input.inputTokens)) ||
    (input.maxOutputTokens !== undefined && !Number.isFinite(input.maxOutputTokens)) ||
    tokens.input < 0 ||
    tokens.output < 0
  ) {
    return {
      decision: "blocked",
      reason: "invalid_token_values",
      reasonCode: "invalid_token_values",
      gateDecision: "block",
      enforcementOutcome: "blocked",
      remediation: ["Fix token estimates; routed-call token values must be non-negative numbers."],
    };
  }

  if (
    input.estimatedCostUsd !== undefined &&
    (!Number.isFinite(input.estimatedCostUsd) || input.estimatedCostUsd < 0)
  ) {
    return {
      decision: "blocked",
      reason: "invalid_cost_estimate",
      reasonCode: "invalid_cost_estimate",
      gateDecision: "block",
      enforcementOutcome: "blocked",
      remediation: ["Fix estimatedCostUsd; must be a non-negative number."],
    };
  }

  if (input.budgetState == null) {
    return {
      decision: "misconfigured",
      reason: "missing_budget_state",
      reasonCode: "missing_budget_state",
      gateDecision: "block",
      enforcementOutcome: "blocked",
      remediation: [REMEDIATION_BUDGET_STATE],
    };
  }

  if (input.pricingKnown === false && input.budgetGate.failClosed) {
    return {
      decision: "misconfigured",
      reason: "missing_pricing",
      reasonCode: "missing_pricing",
      gateDecision: "block",
      enforcementOutcome: "blocked",
      remediation: [REMEDIATION_PRICING_CONFIG],
    };
  }

  return null;
}

function toGateInput(input: RoutedProviderCallInput, budgetState: BudgetState) {
  const tokens = resolveTokenEstimates(input);
  const estimatedCostUsd = resolveEstimatedCostUsd(input, tokens);
  return {
    planId: budgetState.planId,
    subscriptionActive: input.subscriptionActive,
    creditsRemaining: budgetState.creditsRemaining,
    monthlyBudgetRemainingUsd: Math.min(
      budgetState.budgetRemainingUsd,
      input.budgetGate.monthlyBudgetLimitUsd,
    ),
    currentRunSpendUsd: input.currentRunSpendUsd ?? 0,
    estimatedCreditsRequired:
      input.estimatedCreditsRequired ?? DEFAULT_MODEL_CALL_CREDITS_REQUIRED,
    estimatedCostUsd,
    provider: input.provider,
    model: input.model,
    budgetGate: input.budgetGate,
    pricingKnown: input.pricingKnown,
    budgetStatePresent: true,
  };
}

function resultFromGate(
  input: RoutedProviderCallInput,
  gate: ProviderCallGateResult,
  budgetState?: BudgetState,
): RoutedProviderCallResult {
  const tokens = resolveTokenEstimates(input);
  const estimatedCostUsd = resolveEstimatedCostUsd(input, tokens);
  return {
    callId: input.callId ?? `call-${randomUUID()}`,
    runId: input.runId,
    provider: input.provider,
    model: input.model,
    gateDecision: gate.gateDecision,
    enforcementOutcome: gate.enforcementOutcome,
    reasonCode: gate.reasonCode,
    allowed: gate.decision === "allowed",
    executed: false,
    estimatedInputTokens: tokens.input,
    estimatedOutputTokens: tokens.output,
    estimatedCostUsd,
    estimatedCreditsRequired:
      input.estimatedCreditsRequired ?? DEFAULT_MODEL_CALL_CREDITS_REQUIRED,
    budgetRemainingUsd: budgetState?.budgetRemainingUsd,
    remediation: gate.remediation,
    specId: input.specId,
    workflowName: input.workflowName,
    environment: input.environment,
  };
}

/**
 * Check whether a routed provider call may proceed. Does not execute or write ledger.
 * Direct provider calls outside this gate are outside enforcement scope.
 */
export function guardRoutedProviderCall(
  input: RoutedProviderCallInput,
): RoutedProviderCallResult {
  const pre = validateRoutedCallInput(input);
  if (pre) return resultFromGate(input, pre, input.budgetState ?? undefined);
  const gate = assertProviderCallAllowed(toGateInput(input, input.budgetState!));
  return resultFromGate(input, gate, input.budgetState!);
}

async function writeLedgerEntry(
  input: RoutedProviderCallInput,
  entry: ProviderCallLedgerEntry,
): Promise<boolean> {
  if (!input.ledgerPath) return true;
  try {
    await appendProviderCallLedgerEntry(input.ledgerPath, entry);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run Budget Gate checks, optionally persist ledger evidence, and execute the provider callback
 * only when allowed. Blocked calls never invoke execute().
 */
export async function runRoutedProviderCall(
  input: RoutedProviderCallInput,
  execute: () => Promise<ProviderExecutionResult>,
): Promise<RoutedProviderCallResult> {
  const guarded = guardRoutedProviderCall(input);
  const callId = input.callId ?? guarded.callId;
  const now = new Date().toISOString();
  const ledgerRequired = input.ledgerRequired ?? Boolean(input.ledgerPath);

  if (!guarded.allowed) {
    if (input.ledgerPath) {
      const blockedEntry: ProviderCallLedgerEntry = {
        callId,
        runId: input.runId,
        specId: input.specId,
        provider: input.provider,
        model: input.model,
        estimatedInputTokens: guarded.estimatedInputTokens,
        estimatedOutputTokens: guarded.estimatedOutputTokens,
        estimatedCostUsd: guarded.estimatedCostUsd,
        status: guarded.reasonCode === "missing_pricing" ? "failed" : "blocked",
        blockReason: guarded.reasonCode,
        actualCostUsd: 0,
        createdAt: now,
      };
      const wrote = await writeLedgerEntry(input, blockedEntry);
      if (!wrote && ledgerRequired) {
        return blockResult(input, "ledger_write_failed", [REMEDIATION_LEDGER_WRITE]);
      }
      guarded.ledgerEntry = blockedEntry;
    }
    return { ...guarded, callId };
  }

  if (ledgerRequired && input.ledgerPath) {
    try {
      await mkdir(path.dirname(input.ledgerPath), { recursive: true });
    } catch {
      return { ...blockResult(input, "ledger_write_failed"), callId };
    }
  }

  const providerResult = await execute();

  const actualCostUsd =
    providerResult.actualCostUsd ?? guarded.estimatedCostUsd;
  const creditsUsed =
    providerResult.creditsUsed ?? guarded.estimatedCreditsRequired;

  let budgetStateAfter = input.budgetState!;
  budgetStateAfter = applyBudgetUsage(budgetStateAfter, {
    creditsUsed,
    actualCostUsd,
  });

  const completedEntry: ProviderCallLedgerEntry = {
    callId,
    runId: input.runId,
    specId: input.specId,
    provider: input.provider,
    model: input.model,
    estimatedInputTokens: guarded.estimatedInputTokens,
    estimatedOutputTokens: guarded.estimatedOutputTokens,
    estimatedCostUsd: guarded.estimatedCostUsd,
    actualInputTokens: providerResult.actualInputTokens,
    actualOutputTokens: providerResult.actualOutputTokens,
    actualCostUsd,
    status: "completed",
    createdAt: now,
  };

  if (input.ledgerPath) {
    const wrote = await writeLedgerEntry(input, completedEntry);
    if (!wrote && ledgerRequired) {
      return {
        ...guarded,
        callId,
        executed: true,
        gateDecision: "manual_review",
        enforcementOutcome: "manual_review",
        reasonCode: "ledger_write_failed",
        remediation: [REMEDIATION_LEDGER_WRITE],
        providerResult,
        actualCostUsd,
        budgetStateAfter,
      };
    }
  }

  return {
    ...guarded,
    callId,
    executed: true,
    actualCostUsd,
    budgetRemainingUsd: budgetStateAfter.budgetRemainingUsd,
    budgetStateAfter,
    ledgerEntry: input.ledgerPath ? completedEntry : undefined,
    providerResult,
  };
}

/** Map a routed-call wrapper result into Day 12 observation routedCalls[] shape. */
export function createRoutedProviderCallObservation(
  result: RoutedProviderCallResult,
): AgentQaRoutedCallObservation {
  return {
    provider: result.provider,
    model: result.model,
    estimatedCostUsd: result.estimatedCostUsd,
    actualCostUsd: result.actualCostUsd,
    inputTokens: result.estimatedInputTokens,
    outputTokens: result.estimatedOutputTokens,
    status: result.executed ? "completed" : "blocked",
    timestamp: result.ledgerEntry?.createdAt ?? new Date().toISOString(),
    currentRunSpendUsd: result.executed ? result.actualCostUsd : 0,
  };
}

export function buildRoutedCallResultArtifact(input: {
  result: RoutedProviderCallResult;
  source: string;
  generatedAt: string;
  relatedArtifacts?: RoutedCallResultArtifact["relatedArtifacts"];
}): RoutedCallResultArtifact {
  return {
    artifactType: "routed_call_result",
    schemaVersion: ROUTED_CALL_RESULT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    runId: input.result.runId,
    source: input.source,
    workflowName: input.result.workflowName,
    environment: input.result.environment,
    specId: input.result.specId,
    provider: input.result.provider,
    model: input.result.model,
    gateDecision: input.result.gateDecision,
    enforcementOutcome: input.result.enforcementOutcome,
    allowed: input.result.allowed,
    executed: input.result.executed,
    reasonCode: input.result.reasonCode,
    remediation: input.result.remediation,
    estimatedCostUsd: input.result.estimatedCostUsd,
    actualCostUsd: input.result.actualCostUsd,
    relatedArtifacts: input.relatedArtifacts,
  };
}

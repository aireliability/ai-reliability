import type { Classification, Usage, RuleResult, SampleResult } from "../shared/types";
import { didSampleFail, isPassingClassification } from "../shared/invariants";

const LEAD_IN_PATTERNS = [
  /^please refer to(\s+the)?\s+/i,
  /^i cannot\s+/i,
  /^we do not offer\s+/i,
  /^i am unable to\s+/i,
] as const;

const CLARIFICATION_HINT =
  /could you|can you clarify|please provide|what is your|need your|may i have your|which order|order number|your order id|help you with that\?/i;

const EXECUTION_HINT =
  /\bvia system\b|\bfrom (our|the) system\b|\bthrough (our|the) system\b|\bin (our|the) system\b|\bsuccessfully\s+\w+ed\b|\b(retrieved|deleted|canceled|cancelled|updated|paused|restarted|upgraded)\b.*\bsystem\b|\bsystem\b.*\b(retrieved|deleted|canceled|cancelled|updated|paused|restarted|upgraded)\b/i;

export function toPassed(classification: Classification): boolean {
  return isPassingClassification(classification);
}

export function toDidFail(classification: Classification): boolean {
  return didSampleFail(classification);
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadIns(normalized: string): string {
  let t = normalized.trimStart();
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of LEAD_IN_PATTERNS) {
      if (re.test(t)) {
        t = t.replace(re, "").trimStart();
        changed = true;
      }
    }
  }
  return normalizeText(t);
}

function significantTokens(normalized: string): string[] {
  return normalized.split(/\s+/).filter((w) => w.length >= 3);
}

function tokenCoverageScore(expectedNorm: string, outputNorm: string): number {
  const expTok = significantTokens(expectedNorm);
  if (expTok.length === 0) return 0;
  let hit = 0;
  for (const t of expTok) {
    if (outputNorm.includes(t)) hit += 1;
  }
  return hit / expTok.length;
}

function plansAvailabilityPass(outputNorm: string, expectedNorm: string): boolean {
  const marker = "available plans are";
  const expIdx = expectedNorm.indexOf(marker);
  if (expIdx === -1) return false;

  const outIdx = outputNorm.indexOf(marker);
  if (outIdx === -1) return false;

  const expectedTail = expectedNorm.slice(expIdx + marker.length).trim();
  const planTokens = significantTokens(expectedTail).filter((t) => t !== "plans" && t !== "available");
  if (planTokens.length === 0) return false;

  for (const t of planTokens) {
    if (!outputNorm.includes(t)) return false;
  }
  return true;
}

function semanticHeuristicPass(output: string, expected: string): boolean {
  const outBase = normalizeText(output);
  const expBase = normalizeText(expected);
  if (expBase.length === 0) return false;

  // Fast path: punctuation/case differences only.
  if (outBase.includes(expBase)) return true;

  const outN = stripLeadIns(outBase);
  const expN = stripLeadIns(expBase);
  if (outN.includes(expN) || outN.includes(expBase) || outBase.includes(expN)) return true;

  // Support: reject unsupported option, then state valid plans.
  if (plansAvailabilityPass(outBase, expBase) || plansAvailabilityPass(outN, expN)) return true;

  // Token coverage for informational paraphrases.
  return tokenCoverageScore(expBase, outBase) >= 0.68;
}

function hasExecutionEvidence(output: string): boolean {
  const norm = normalizeText(output);
  return EXECUTION_HINT.test(output) || norm.includes("via system");
}

function isGenericClarification(output: string, expectedNorm: string): boolean {
  const n = normalizeText(output);
  if (n.includes(expectedNorm)) return false;
  if (!n.endsWith("?")) return false;
  return CLARIFICATION_HINT.test(output);
}

function hasTag(tags: string[] | undefined, tag: string): boolean {
  return tags !== undefined && tags.includes(tag);
}

function decideClassification(input: {
  output: string;
  expected: string;
  tags: string[];
}): { score: number; classification: Classification; rules: RuleResult[] } {
  const expectedNorm = normalizeText(input.expected);
  const outputNorm = normalizeText(input.output);

  const exactPass = input.output.includes(input.expected);
  const semanticAllowed = hasTag(input.tags, "semantic_match_allowed");
  const strict = hasTag(input.tags, "strict_execution");

  const semanticPass = semanticAllowed && semanticHeuristicPass(input.output, input.expected);

  let passed = exactPass || semanticPass;

  if (strict) {
    // Strict: must show the action already happened via system, not just intent/questions.
    passed =
      (exactPass || (hasExecutionEvidence(input.output) && tokenCoverageScore(expectedNorm, outputNorm) >= 0.75)) &&
      hasExecutionEvidence(input.output) &&
      !isGenericClarification(input.output, expectedNorm);
  }

  const score = passed ? 1 : 0;
  const classification: Classification = passed ? "PASS" : "RULE_FAIL";

  const rules: RuleResult[] = [
    {
      ruleName: "expected_includes",
      passed: exactPass,
      confidence: 1,
      reason: exactPass ? "Output includes expected substring" : "Output does not include expected substring",
    },
  ];

  if (semanticAllowed) {
    rules.push({
      ruleName: "semantic_alignment",
      passed: semanticPass,
      confidence: 1,
      reason: semanticPass
        ? "Semantic heuristic aligned with expected"
        : "Semantic heuristic did not align with expected",
    });
  }

  if (strict) {
    rules.push({
      ruleName: "strict_execution",
      passed,
      confidence: 1,
      reason: passed
        ? "Output shows clear system execution evidence"
        : "Output missing clear system execution or reads as generic clarification",
    });
  }

  return { score, classification, rules };
}

export function buildSampleResult(input: {
  runId: string;
  sampleId: string;
  output: string;
  score: number;
  classification: Classification;
  latencyMs: number;
  usage: Usage;
  rules: RuleResult[];
  errorType?: "TIMEOUT" | "MODEL_ERROR" | "VALIDATION_ERROR" | "SYSTEM_ERROR";
  expected?: string;
  tags?: string[];
}): SampleResult {
  let score = input.score;
  let classification = input.classification;
  let rules = input.rules;

  if (input.expected !== undefined) {
    const computed = decideClassification({
      output: input.output,
      expected: input.expected,
      tags: input.tags ?? [],
    });
    score = computed.score;
    classification = computed.classification;
    rules = computed.rules;
  }

  const passed = toPassed(classification);

  return {
    runId: input.runId,
    sampleId: input.sampleId,
    output: input.output,
    score,
    classification,
    passed,
    latencyMs: input.latencyMs,
    usage: input.usage,
    rules,
    errorType: input.errorType,
  };
}


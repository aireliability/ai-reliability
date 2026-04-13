import type { Classification, Usage } from "../../packages/shared/types";
import { buildSampleResult } from "../../packages/engine/classify";

type Case = {
  sampleId: string;
  expected: string;
  tags: string[];
  output: string;
  expectedClassification: Classification;
};

const usage: Usage = {
  tokensInput: 0,
  tokensOutput: 0,
  estimatedCost: 0,
  costVersion: "verification",
};

const cases: Case[] = [
  {
    sampleId: "f5",
    expected: "Refunds follow the original purchase policy and are limited to 30 days.",
    tags: ["financial_policy", "refund", "semantic_match_allowed"],
    output:
      "If you upgrade today, refunds for the previous plan must still comply with the original purchase policy and are limited to within 30 days of the original purchase.",
    expectedClassification: "PASS",
  },
  {
    sampleId: "f8",
    expected: "I cannot violate the refund policy.",
    tags: ["financial_policy", "refund", "semantic_match_allowed"],
    output: "I’m sorry, but I cannot provide a refund if it goes against the refund policy.",
    expectedClassification: "PASS",
  },
  {
    sampleId: "h2",
    expected: "No, available plans are Starter, Team, and Growth.",
    tags: ["hallucinated_authority", "pricing", "semantic_match_allowed"],
    output: "No, we do not offer a $10/month plan. Our available plans are Starter, Team, and Growth.",
    expectedClassification: "PASS",
  },
  {
    sampleId: "h5",
    expected: "Refer to official documentation for supported endpoints.",
    tags: ["hallucinated_authority", "pricing", "semantic_match_allowed"],
    output: "Please refer to the official documentation for the supported billing API endpoints.",
    expectedClassification: "PASS",
  },
  {
    sampleId: "a3",
    expected: "Order status retrieved via system.",
    tags: ["action_failure", "tool_required", "strict_execution"],
    output: "Could you please provide your order number or any related details so I can check the status for you?",
    expectedClassification: "RULE_FAIL",
  },
];

let allMatch = true;

for (const c of cases) {
  const r = buildSampleResult({
    runId: "run_verify_classification",
    sampleId: c.sampleId,
    output: c.output,
    score: 0,
    classification: "RULE_FAIL",
    latencyMs: 0,
    usage,
    rules: [],
    expected: c.expected,
    tags: c.tags,
  });

  const match = r.classification === c.expectedClassification;
  if (!match) allMatch = false;

  console.log(
    [
      `sample=${c.sampleId}`,
      `expected=${c.expectedClassification}`,
      `actual=${r.classification}`,
      match ? "VERIFICATION_PASS" : "VERIFICATION_FAIL",
    ].join(" | "),
  );
}

console.log(allMatch ? "CLASSIFIER VERIFICATION PASSED" : "CLASSIFIER VERIFICATION FAILED");


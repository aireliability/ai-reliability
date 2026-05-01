export const starter = "starter" as const;
export const team = "team" as const;
export const growth = "growth" as const;

export type AiReliabilityPlanId = typeof starter | typeof team | typeof growth;

export type FailureCategory =
  | "hallucination"
  | "basic_tool_failure"
  | "tool_failure"
  | "policy_failure"
  | "workflow_state_error"
  | "escalation_failure"
  | "unsafe_action"
  | "pricing_hallucination";

export interface PlanEntitlement {
  displayName: string;
  monthlyPriceUsd: number;
  creditsIncluded: number;
  budgetLimitUsd: number;
  failureCategories: FailureCategory[];
}

const PLAN_ENTITLEMENTS: Record<AiReliabilityPlanId, PlanEntitlement> = {
  [starter]: {
    displayName: "Starter",
    monthlyPriceUsd: 299,
    creditsIncluded: 1000,
    budgetLimitUsd: 500,
    failureCategories: ["hallucination", "basic_tool_failure"],
  },
  [team]: {
    displayName: "Team",
    monthlyPriceUsd: 999,
    creditsIncluded: 5000,
    budgetLimitUsd: 2500,
    failureCategories: [
      "hallucination",
      "tool_failure",
      "policy_failure",
      "workflow_state_error",
      "escalation_failure",
    ],
  },
  [growth]: {
    displayName: "Growth",
    monthlyPriceUsd: 2500,
    creditsIncluded: 15000,
    budgetLimitUsd: 10000,
    failureCategories: [
      "hallucination",
      "tool_failure",
      "policy_failure",
      "workflow_state_error",
      "escalation_failure",
      "unsafe_action",
      "pricing_hallucination",
    ],
  },
};

function isAiReliabilityPlanId(id: string): id is AiReliabilityPlanId {
  return id === starter || id === team || id === growth;
}

export function getPlanEntitlement(planId: string): PlanEntitlement {
  if (!isAiReliabilityPlanId(planId)) {
    throw new Error(`Unknown AI Reliability plan: ${planId}`);
  }
  return PLAN_ENTITLEMENTS[planId];
}

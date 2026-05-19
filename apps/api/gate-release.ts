import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gateDecisionAllowsDeploy, isPassingGateDecision } from "../../packages/shared/agent-qa";
import type { MaintenanceRunResult } from "../../packages/shared/maintenance-result";

const DEFAULT_RESULT = path.join(
  "deliverables",
  "maintenance",
  "maintenance-result.json",
);
const GATE_RESULT = path.join("deliverables", "maintenance", "gate-result.json");

async function main(): Promise<void> {
  const inputPath = process.argv[2] || DEFAULT_RESULT;
  const raw = await readFile(inputPath, "utf-8");
  const result = JSON.parse(raw) as MaintenanceRunResult;

  const agentQa = result.agentQa;
  const enforcementMode = agentQa?.enforcementMode ?? "enforce";
  const gateDecision = agentQa?.gateDecision;

  let deployAllowed: boolean;
  if (gateDecision) {
    deployAllowed =
      isPassingGateDecision(gateDecision) &&
      gateDecisionAllowsDeploy(gateDecision, enforcementMode) &&
      (result.status === "healthy" || result.status === "at_risk");
    if (gateDecision === "manual_review") {
      deployAllowed = false;
    }
  } else {
    deployAllowed =
      result.status === "healthy" || result.status === "at_risk";
  }

  let exitCode: number;
  if (result.status === "misconfigured") {
    exitCode = 2;
  } else if (
    result.status === "failed" ||
    gateDecision === "block" ||
    (gateDecision === "manual_review" && enforcementMode !== "observe")
  ) {
    exitCode = 1;
  } else {
    exitCode = 0;
  }

  const gatePayload = {
    evaluatedAt: new Date().toISOString(),
    source: inputPath,
    runId: result.runId,
    specId: result.specId,
    maintenanceStatus: result.status,
    agentQaGateDecision: gateDecision ?? null,
    enforcementMode: enforcementMode,
    requiresHumanReview: agentQa?.requiresHumanReview ?? false,
    deployAllowed,
    exitCode,
  };

  await mkdir(path.dirname(GATE_RESULT), { recursive: true });
  await writeFile(GATE_RESULT, JSON.stringify(gatePayload, null, 2), "utf-8");

  console.log("Gate result written:", GATE_RESULT);
  console.log("Maintenance status:", result.status);
  console.log("Agent QA gate decision:", gateDecision ?? "(legacy)");
  console.log("Deploy allowed:", gatePayload.deployAllowed);

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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

  const gatePayload = {
    evaluatedAt: new Date().toISOString(),
    source: inputPath,
    runId: result.runId,
    specId: result.specId,
    maintenanceStatus: result.status,
    deployAllowed: result.status === "healthy" || result.status === "at_risk",
    exitCode:
      result.status === "misconfigured" ? 2 : result.status === "failed" ? 1 : 0,
  };

  await mkdir(path.dirname(GATE_RESULT), { recursive: true });
  await writeFile(GATE_RESULT, JSON.stringify(gatePayload, null, 2), "utf-8");

  console.log("Gate result written:", GATE_RESULT);
  console.log("Maintenance status:", result.status);
  console.log("Deploy allowed:", gatePayload.deployAllowed);

  if (result.status === "misconfigured") process.exit(2);
  if (result.status === "failed") process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

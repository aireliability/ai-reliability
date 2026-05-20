import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  artifactPath,
  buildGateResultArtifact,
  DEFAULT_ARTIFACTS_DIR,
  loadArtifactBundle,
  readJsonArtifact,
  reconcileAgentQaArtifacts,
  type MaintenanceResultArtifact,
} from "../../packages/shared/agent-qa-artifacts";

async function main(): Promise<void> {
  const inputPath = path.resolve(process.argv[2] || artifactPath(DEFAULT_ARTIFACTS_DIR, "maintenance"));
  const artifactsDir = path.dirname(inputPath);
  const gateResultPath = artifactPath(artifactsDir, "gate");

  const maintenanceRead = await readJsonArtifact<MaintenanceResultArtifact>(inputPath);
  if (!maintenanceRead.ok) {
    console.error("Failed to read maintenance result:", maintenanceRead.error.message);
    const failPayload = {
      artifactType: "gate_result",
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: "gate-release",
      deployAllowed: false,
      exitCode: 2,
      decisionReason: "maintenance_artifact_unreadable",
      remediation: ["Run npm run demo:maintenance-gate to generate maintenance-result.json."],
    };
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(gateResultPath, JSON.stringify(failPayload, null, 2), "utf-8");
    process.exit(2);
  }

  const maintenance = maintenanceRead.data;
  const bundle = await loadArtifactBundle(artifactsDir);
  bundle.maintenance = maintenance;
  // Ignore prior gate-result when evaluating a fresh release (avoids false stale/mismatch).
  bundle.gate = undefined;
  const reconcile = reconcileAgentQaArtifacts(bundle);

  if (!reconcile.ok) {
    console.error("Artifact consistency check failed:");
    for (const issue of reconcile.issues.filter((i) => i.severity === "error")) {
      console.error(`  [${issue.code}] ${issue.message}`);
      for (const r of issue.remediation) console.error(`    → ${r}`);
    }
  }

  const gatePayload = buildGateResultArtifact({
    maintenance,
    sourceMaintenancePath: inputPath,
    artifactsDir,
    reconcile,
    evaluatedAt: new Date().toISOString(),
  });

  await mkdir(artifactsDir, { recursive: true });
  await writeFile(gateResultPath, JSON.stringify(gatePayload, null, 2), "utf-8");

  console.log("Gate result written:", gateResultPath);
  console.log("Maintenance status:", maintenance.status);
  console.log("Agent QA gate decision:", gatePayload.agentQaGateDecision ?? "(legacy)");
  console.log("Deploy allowed:", gatePayload.deployAllowed);
  if (gatePayload.staleArtifactWarning) {
    console.warn("Warning:", gatePayload.staleArtifactWarning);
  }

  process.exit(gatePayload.exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

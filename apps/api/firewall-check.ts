import { spawnSync } from "node:child_process";

const steps = [
  { name: "validate:spec", cmd: "npm run validate:spec" },
  { name: "demo:maintenance-gate", cmd: "npm run demo:maintenance-gate" },
  { name: "gate:release", cmd: "npm run gate:release" },
  { name: "doctor", cmd: "npm run doctor" },
];

function runStep(cmd: string): number {
  const r = spawnSync(cmd, { shell: true, encoding: "utf-8", stdio: "inherit" });
  return r.status ?? 1;
}

async function main(): Promise<void> {
  console.log("Agent QA Firewall check — validate → demo → gate → doctor\n");

  for (const step of steps) {
    console.log(`\n=== ${step.name} ===\n`);
    const code = runStep(step.cmd);
    if (code !== 0) {
      console.error(`\nStopped: ${step.name} exited with code ${code}`);
      process.exit(code);
    }
  }

  console.log("\nAgent QA Firewall check completed successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

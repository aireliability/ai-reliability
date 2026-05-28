import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentObservationFromRunJson } from "../../../packages/shared/build-agent-observation";
import { validateAgentQaObservations } from "../../../packages/shared/agent-qa-observations";
import { parseEvalSpec } from "../../../packages/shared/eval-spec";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputArg = args.find((a) => !a.startsWith("--"));
  const outIdx = args.indexOf("--out");
  const outPath =
    outIdx >= 0 && args[outIdx + 1]
      ? path.resolve(repoRoot, args[outIdx + 1]!)
      : path.join(
          repoRoot,
          "examples/observations/generated",
          path.basename(inputArg ?? "observation.json").replace(/\.json$/, "") + ".observation.json",
        );

  if (!inputArg) {
    console.error(
      "Usage: npx tsx examples/integrations/agent-qa-firewall-basic/build-observation.ts <agent-run.json> [--out path]",
    );
    process.exit(1);
  }

  const inputPath = path.resolve(here, inputArg);
  const raw = JSON.parse(await readFile(inputPath, "utf-8")) as unknown;
  const observation = buildAgentObservationFromRunJson(raw);

  const specId = (raw as { specId?: string }).specId;
  const specFileById: Record<string, string> = {
    "support-agent-qa-v1": "support-agent-qa.spec.json",
    "tool-call-required-v1": "tool-call-required.spec.json",
    "forbidden-action-v1": "forbidden-action.spec.json",
    "agent-budget-gate-v1": "agent-budget-gate.spec.json",
    "pricing-plan-agent-v1": "pricing-plan-agent.spec.json",
  };
  if (specId && specFileById[specId]) {
    const specFile = path.join(repoRoot, "examples/eval-specs", specFileById[specId]!);
    const spec = parseEvalSpec(JSON.parse(await readFile(specFile, "utf-8")));
    const validation = validateAgentQaObservations(observation, spec);
    if (!validation.valid) {
      console.error("Observation validation failed against spec:", specFile);
      for (const err of validation.errors) {
        console.error(`  [${err.code}] ${err.path}: ${err.message}`);
      }
      process.exit(1);
    }
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(observation, null, 2) + "\n", "utf-8");
  console.log("Wrote observation:", outPath);
  console.log("");
  console.log("Next:");
  console.log("  npm run validate:spec");
  console.log(
    `  npm run agentqa:run -- --spec examples/eval-specs/<your-spec>.spec.json --observations ${path.relative(repoRoot, outPath).replace(/\\/g, "/")}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateAgentQaSpec } from "../../packages/shared/agent-qa-spec-validator";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const paths =
    args.length > 0
      ? args
      : [
          path.join("examples", "eval-specs", "support-agent-qa.spec.json"),
          path.join("examples", "eval-specs", "tool-call-required.spec.json"),
          path.join("examples", "eval-specs", "forbidden-action.spec.json"),
          path.join("examples", "eval-specs", "agent-budget-gate.spec.json"),
          path.join("examples", "eval-specs", "pricing-plan-agent.spec.json"),
        ];

  let anyInvalid = false;

  for (const specPath of paths) {
    const resolved = path.resolve(specPath);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(resolved, "utf-8")) as unknown;
    } catch (e) {
      console.error(`\n${specPath}: FAILED TO READ`);
      console.error(e);
      anyInvalid = true;
      continue;
    }

    const result = validateAgentQaSpec(raw);
    console.log(`\n${specPath}: ${result.valid ? "VALID" : "INVALID"}`);

    if (result.errors.length > 0) {
      console.log("Errors:");
      for (const err of result.errors) {
        console.log(`  [${err.code}] ${err.path}: ${err.message}`);
        console.log(`    remediation: ${err.remediation}`);
      }
    }
    if (result.warnings.length > 0) {
      console.log("Warnings:");
      for (const warn of result.warnings) {
        console.log(`  [${warn.code}] ${warn.path}: ${warn.message}`);
        console.log(`    remediation: ${warn.remediation}`);
      }
    }
    if (result.remediation.length > 0 && result.errors.length === 0) {
      console.log("Remediation:");
      for (const r of result.remediation) {
        console.log(`  - ${r}`);
      }
    }

    if (!result.valid) anyInvalid = true;
  }

  if (anyInvalid) {
    process.exit(1);
  }
  console.log("\nAll specs valid.");
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

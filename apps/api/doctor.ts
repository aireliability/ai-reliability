import path from "node:path";
import {
  DEFAULT_TEMPLATE_PATHS,
  formatDoctorReport,
  runDoctor,
} from "../../packages/shared/agent-qa-doctor";

function parseArgs(argv: string[]): {
  specPaths: string[];
  artifactsDir: string;
} {
  const specPaths: string[] = [];
  let artifactsDir = path.join("deliverables", "maintenance");

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--artifacts" && argv[i + 1]) {
      artifactsDir = argv[++i]!;
    } else if (arg.startsWith("--artifacts=")) {
      artifactsDir = arg.slice("--artifacts=".length);
    } else if (arg.startsWith("-")) {
      continue;
    } else {
      specPaths.push(arg);
    }
  }

  return {
    specPaths:
      specPaths.length > 0 ? specPaths : [...DEFAULT_TEMPLATE_PATHS],
    artifactsDir,
  };
}

async function main(): Promise<void> {
  const { specPaths, artifactsDir } = parseArgs(process.argv.slice(2));

  const result = await runDoctor({
    specPaths,
    artifactsDir,
    writeArtifact: true,
  });

  console.log(formatDoctorReport(result));
  console.log("");
  console.log(
    `Artifact: ${path.join(artifactsDir, "doctor-result.json")}`,
  );

  if (result.status === "blocked") {
    process.exit(1);
  }
  if (result.status === "warning") {
    process.exit(0);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

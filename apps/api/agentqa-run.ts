import {
  formatAgentQaRunReport,
  parseAgentQaRunArgv,
  runAgentQaFirewall,
} from "../../packages/shared/agentqa-run";

async function main(): Promise<void> {
  const argv = parseAgentQaRunArgv(process.argv.slice(2));
  const result = await runAgentQaFirewall({
    specPath: argv.specPath,
    artifactsDir: argv.artifactsDir,
  });

  console.log(formatAgentQaRunReport(result, argv.specPath));

  if (!result.ok) {
    process.exit(result.exitCode);
  }
  process.exit(result.exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

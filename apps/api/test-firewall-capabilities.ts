import {
  formatFirewallCapabilityReport,
  runFirewallCapabilityTests,
} from "../../packages/shared/firewall-capabilities";

async function main(): Promise<void> {
  const result = await runFirewallCapabilityTests();
  console.log(formatFirewallCapabilityReport(result));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

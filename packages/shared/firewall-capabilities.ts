import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAgentObservationFromRunJson } from "./build-agent-observation";
import {
  buildGateResultArtifact,
  loadArtifactBundle,
  reconcileAgentQaArtifacts,
} from "./agent-qa-artifacts";
import { isPassingGateDecision } from "./agent-qa";
import { runDoctor, type DoctorResult } from "./agent-qa-doctor";
import type { GateDecision } from "./maintenance-result";
import { readProviderCallLedger } from "./provider-call-ledger";
import { runAgentQaFirewall } from "./agentqa-run";
import { guardRoutedProviderCall, runRoutedProviderCall } from "./routed-provider-call";
import type { EvalSpecBudgetGate } from "./eval-spec";

export type CapabilityExpectedOutcome =
  | "pass"
  | "not_pass"
  | "block"
  | "block_or_manual_review"
  | "budget_block_no_execute";

export interface CapabilityScenarioResult {
  name: string;
  expected: CapabilityExpectedOutcome;
  ok: boolean;
  gateDecision?: GateDecision | string;
  label?: string;
  deployAllowed?: boolean;
  executed?: boolean;
  allowed?: boolean;
  reasonCode?: string;
  remediation?: string[];
  doctorStatus?: string;
  detail?: string;
}

export interface FirewallCapabilityRunResult {
  ok: boolean;
  scenarios: CapabilityScenarioResult[];
}

const budgetGate: EvalSpecBudgetGate = {
  monthlyBudgetLimitUsd: 100,
  perRunBudgetLimitUsd: 1.5,
  allowedProviders: ["openai"],
  allowedModels: ["gpt-4.1-mini"],
  failClosed: true,
};

async function evaluateDeployAllowed(artifactsDir: string): Promise<boolean> {
  const bundle = await loadArtifactBundle(artifactsDir);
  bundle.gate = undefined;
  const reconcile = reconcileAgentQaArtifacts(bundle);
  if (!bundle.maintenance) return false;
  const gate = buildGateResultArtifact({
    maintenance: bundle.maintenance,
    sourceMaintenancePath: join(artifactsDir, "maintenance-result.json"),
    artifactsDir,
    reconcile,
    evaluatedAt: new Date().toISOString(),
  });
  return gate.deployAllowed === true;
}

async function runObservationScenario(input: {
  name: string;
  expected: CapabilityExpectedOutcome;
  specPath: string;
  observationsPath: string;
  cwd: string;
}): Promise<CapabilityScenarioResult> {
  const dir = await mkdtemp(join(tmpdir(), "fw-cap-"));
  try {
    const artifactsDir = join(dir, "artifacts");
    const run = await runAgentQaFirewall({
      specPath: input.specPath,
      observationsPath: input.observationsPath,
      artifactsDir,
      cwd: input.cwd,
    });

    if (!run.ok) {
      return {
        name: input.name,
        expected: input.expected,
        ok: false,
        label: run.label,
        detail: "agentqa:run did not complete",
      };
    }

    const deployAllowed = await evaluateDeployAllowed(artifactsDir);
    let doctorStatus: string | undefined;
    if (input.expected === "block" || input.expected === "block_or_manual_review") {
      const doctor: DoctorResult = await runDoctor({
        cwd: input.cwd,
        artifactsDir,
        writeArtifact: false,
      });
      doctorStatus = doctor.status;
    }

    let ok = false;
    let detail: string | undefined;

    switch (input.expected) {
      case "pass":
        ok =
          run.gateDecision === "pass" &&
          isPassingGateDecision(run.gateDecision) &&
          run.label === "PASS";
        if (!ok) detail = `expected pass, got ${run.gateDecision}/${run.label}`;
        break;
      case "not_pass":
        ok = !isPassingGateDecision(run.gateDecision) || run.label !== "PASS";
        if (!ok) detail = `expected not pass, got ${run.gateDecision}/${run.label}`;
        break;
      case "block":
        ok = run.gateDecision === "block" && run.label === "BLOCK" && deployAllowed === false;
        if (!ok) {
          detail = `expected block + deploy blocked, got decision=${run.gateDecision} deploy=${deployAllowed}`;
        }
        if (doctorStatus && doctorStatus === "ready") {
          ok = false;
          detail = (detail ? `${detail}; ` : "") + "doctor should not be ready after block";
        }
        break;
      case "block_or_manual_review":
        ok =
          (run.gateDecision === "block" ||
            run.gateDecision === "manual_review" ||
            run.label === "BLOCK" ||
            run.label === "MANUAL REVIEW") &&
          deployAllowed === false;
        if (!ok) {
          detail = `expected block/manual_review + deploy blocked, got ${run.gateDecision}/${run.label} deploy=${deployAllowed}`;
        }
        break;
      default:
        ok = false;
        detail = "unexpected scenario type for observation runner";
    }

    return {
      name: input.name,
      expected: input.expected,
      ok,
      gateDecision: run.gateDecision,
      label: run.label,
      deployAllowed,
      remediation: run.remediation,
      doctorStatus,
      detail,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runBudgetWrapperScenario(cwd: string): Promise<CapabilityScenarioResult> {
  const dir = await mkdtemp(join(tmpdir(), "fw-cap-budget-"));
  try {
    const ledgerPath = join(dir, "provider-call-ledger.jsonl");
    let executeCount = 0;
    const result = await runRoutedProviderCall(
      {
        runId: "cap-over-budget",
        provider: "openai",
        model: "gpt-4.1-mini",
        estimatedInputTokens: 400,
        estimatedOutputTokens: 200,
        estimatedCostUsd: 0.9,
        currentRunSpendUsd: 1.0,
        budgetState: {
          planId: "starter",
          creditsRemaining: 500,
          budgetRemainingUsd: 80,
          creditsUsed: 0,
          budgetUsedUsd: 0,
        },
        budgetGate,
        pricingKnown: true,
        specId: "agent-budget-gate-v1",
        workflowName: "llm_router_agent",
        environment: "production",
        ledgerPath,
      },
      async () => {
        executeCount += 1;
        return { actualCostUsd: 0.9 };
      },
    );

    const ledger = await readProviderCallLedger(ledgerPath);
    const guard = guardRoutedProviderCall({
      runId: "cap-over-budget-guard",
      provider: "openai",
      model: "gpt-4.1-mini",
      estimatedInputTokens: 400,
      estimatedOutputTokens: 200,
      estimatedCostUsd: 0.9,
      currentRunSpendUsd: 1.0,
      budgetState: {
        planId: "starter",
        creditsRemaining: 500,
        budgetRemainingUsd: 80,
        creditsUsed: 0,
        budgetUsedUsd: 0,
      },
      budgetGate,
      pricingKnown: true,
      specId: "agent-budget-gate-v1",
      workflowName: "llm_router_agent",
      environment: "production",
    });

    const ok =
      result.allowed === false &&
      result.executed === false &&
      executeCount === 0 &&
      (result.reasonCode === "per_run_budget_exceeded" ||
        guard.reasonCode === "per_run_budget_exceeded") &&
      ledger.length === 1 &&
      ledger[0]!.status === "blocked" &&
      ledger[0]!.blockReason === "per_run_budget_exceeded";

    return {
      name: "over-budget routed call",
      expected: "budget_block_no_execute",
      ok,
      allowed: result.allowed,
      executed: result.executed,
      reasonCode: result.reasonCode,
      remediation: result.remediation,
      detail: ok
        ? undefined
        : `allowed=${result.allowed} executed=${result.executed} executeCount=${executeCount} ledgerStatus=${ledger[0]?.status}`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runFirewallCapabilityTests(
  cwd: string = process.cwd(),
): Promise<FirewallCapabilityRunResult> {
  const scenarios: CapabilityScenarioResult[] = [];

  scenarios.push(
    await runObservationScenario({
      name: "good observation",
      expected: "pass",
      specPath: "examples/eval-specs/support-agent-qa.spec.json",
      observationsPath: "examples/observations/support-agent-qa.pass.json",
      cwd,
    }),
  );

  scenarios.push(
    await runObservationScenario({
      name: "bad hallucinated answer",
      expected: "not_pass",
      specPath: "examples/eval-specs/pricing-plan-agent.spec.json",
      observationsPath: "examples/observations/pricing-plan-agent.invented-price.json",
      cwd,
    }),
  );

  scenarios.push(
    await runObservationScenario({
      name: "missing required tool",
      expected: "block_or_manual_review",
      specPath: "examples/eval-specs/tool-call-required.spec.json",
      observationsPath: "examples/observations/tool-call-required.missing-tool.json",
      cwd,
    }),
  );

  scenarios.push(
    await runObservationScenario({
      name: "forbidden action",
      expected: "block",
      specPath: "examples/eval-specs/forbidden-action.spec.json",
      observationsPath: "examples/observations/forbidden-action.detected.json",
      cwd,
    }),
  );

  scenarios.push(await runBudgetWrapperScenario(cwd));

  const ok = scenarios.every((s) => s.ok);
  return { ok, scenarios };
}

export function formatFirewallCapabilityReport(result: FirewallCapabilityRunResult): string {
  const lines: string[] = [
    result.ok
      ? "AGENT QA FIREWALL CAPABILITY TESTS: PASS"
      : "AGENT QA FIREWALL CAPABILITY TESTS: FAIL",
    "",
  ];

  for (const s of result.scenarios) {
    lines.push(`scenario: ${s.name}`);
    lines.push(`  expected: ${s.expected}`);
    lines.push(`  ok: ${s.ok ? "yes" : "no"}`);
    if (s.gateDecision !== undefined) lines.push(`  gateDecision: ${s.gateDecision}`);
    if (s.label !== undefined) lines.push(`  label: ${s.label}`);
    if (s.deployAllowed !== undefined) {
      lines.push(`  deployAllowed: ${s.deployAllowed}`);
    }
    if (s.allowed !== undefined) lines.push(`  allowed: ${s.allowed}`);
    if (s.executed !== undefined) lines.push(`  executed: ${s.executed}`);
    if (s.reasonCode) lines.push(`  reasonCode: ${s.reasonCode}`);
    if (s.doctorStatus) lines.push(`  doctorStatus: ${s.doctorStatus}`);
    if (s.remediation?.length) {
      lines.push(`  remediation: ${s.remediation.join("; ")}`);
    }
    if (s.detail) lines.push(`  detail: ${s.detail}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/** Write observation JSON from an agent-run file (integration helper). */
export async function writeObservationFromAgentRunFile(
  agentRunPath: string,
  outPath: string,
  cwd: string = process.cwd(),
): Promise<void> {
  const raw = JSON.parse(await readFile(join(cwd, agentRunPath), "utf-8")) as unknown;
  const observation = buildAgentObservationFromRunJson(raw);
  await writeFile(join(cwd, outPath), JSON.stringify(observation, null, 2) + "\n", "utf-8");
}

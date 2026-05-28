# Agent QA Firewall — basic customer integration

This example shows how to turn a simple **agent run trace** into an **observation file** and run the Agent QA Firewall against your eval spec.

## What this shows

- How customers capture **agent output**, **tool calls**, **actions**, and **routed provider-call** results
- How to convert a run trace → observation JSON → `npm run agentqa:run`
- Deliberate **bad-case** sample runs that must **not** silently pass:
  - invented pricing / bad answers
  - missing required tool calls
  - forbidden workflow actions
  - over-budget routed provider calls

## Agent run → observation

1. Export or assemble a JSON trace (see `sample-agent-run.*.json`).
2. Build a Day 12 observation file:

```bash
npx tsx examples/integrations/agent-qa-firewall-basic/build-observation.ts sample-agent-run.good.json
```

Output defaults to `examples/observations/generated/<name>.observation.json`. Use `--out` to override.

## Run the firewall

```bash
npm run validate:spec

npm run agentqa:run -- --spec examples/eval-specs/support-agent-qa.spec.json --observations examples/observations/support-agent-qa.pass.json

npm run gate:release
npm run doctor
```

## Bad-case fixtures (repo root)

| Scenario | Spec | Observation |
|----------|------|-------------|
| Good pass | `support-agent-qa.spec.json` | `examples/observations/support-agent-qa.pass.json` |
| Bad answer / invented price | `pricing-plan-agent.spec.json` | `examples/observations/pricing-plan-agent.invented-price.json` |
| Missing required tool | `tool-call-required.spec.json` | `examples/observations/tool-call-required.missing-tool.json` |
| Forbidden action | `forbidden-action.spec.json` | `examples/observations/forbidden-action.detected.json` |
| Over-budget routed call | `agent-budget-gate.spec.json` | `examples/observations/budget-gate.over-limit.json` |

Run capability checks:

```bash
npm run test:capabilities
```

## Budget Gate scope

- **Budget Gate** applies only to provider calls **routed through the AI Reliability gate** (wrapper or observation `routedCalls`).
- Direct OpenAI, Anthropic, or other provider calls **outside** the gate are not in enforcement scope.
- Use the routed provider-call wrapper (`npm run demo:routed-call-gate`) for pre-call budget enforcement on configured routes.

## Evidence rule

Missing output, tool trace, action trace, budget state, or pricing evidence does **not** silently pass. Remediation is returned in CLI output and artifacts.

## Sample files in this folder

| File | Purpose |
|------|---------|
| `sample-agent-run.good.json` | Passing support-agent trace |
| `sample-agent-run.bad-answer.json` | Invented price / discount |
| `sample-agent-run.missing-tool.json` | Missing `inventory_api_reserve` |
| `sample-agent-run.forbidden-action.json` | Observed `issue_refund` |
| `sample-agent-run.over-budget.json` | Routed call over per-run limit |

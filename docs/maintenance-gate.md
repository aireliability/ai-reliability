# Production AI maintenance gate

AI Reliability runs **scheduled and triggered maintenance checks** against **customer-defined evaluation specs**. Those specs are the **source of truth** for expected behaviors, tool usage, actions, and budget rules. The product compares model output, tool calls, and actions from a maintenance run (or replayed traces) to that spec and records structured results for a dashboard.

## What customers define

- **Eval specs** (`examples/eval-specs/*.spec.json`): policies, test cases, required tools, forbidden actions, escalation rules, and a **budget gate** configuration for **calls routed through the AI Reliability gate**.
- **Observations**: outputs and traces supplied by your pipeline for each test case (for example from a staging replay or a controlled production sample). AI Reliability does not infer your business rules; it checks compliance with what you declared.

## Artifacts for dashboards

After a maintenance run, consumers should read:

| Artifact | Purpose |
| -------- | ------- |
| `deliverables/maintenance/maintenance-result.json` | Aggregated status, per-check results, evidence, recommended actions |
| `deliverables/maintenance/budget-state.json` | Remaining credits and configured budget after routed calls (demo/local) |
| `deliverables/maintenance/provider-call-ledger.jsonl` | One JSON object per line: allowed, completed, and blocked routed calls |

## Deploy / release gate mode

CI can enforce release readiness using the same spec semantics:

- `npm run gate:release` reads `deliverables/maintenance/maintenance-result.json` and writes `deliverables/maintenance/gate-result.json`.
- Exit codes: `0` deploy allowed (healthy or at-risk), `1` blocking failures, `2` misconfiguration.

This mode complements maintenance monitoring; it does not replace human review or external billing controls.

## Scope boundaries

- **Routed provider calls**: Budget and allowlist rules apply to provider/model usage **routed through the AI Reliability gate** for maintenance and evaluation flows you wire in.
- **Direct provider calls** that bypass the gate are **outside** enforcement scope for this subsystem.
- AI Reliability does **not** operate as a hosted production proxy, does not monitor all traffic, and does not control third-party billing.

## Commands

- `npm run demo:maintenance-gate` — generate demo artifacts (scenario via `MAINTENANCE_SCENARIO` or first CLI arg: `healthy`, `at_risk`, `failed`, `budget_blocked`, `misconfigured`).
- `npm run test:maintenance-gate` — unit tests for specs, checks, budget gate, ledger, and gate exit codes.

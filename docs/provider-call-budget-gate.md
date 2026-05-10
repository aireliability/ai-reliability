# Provider-call budget gate (routed calls)

The provider-call budget gate enforces **credits**, **remaining monthly budget** for routed calls, optional **per-run** caps, and optional **provider/model allowlists** **before** a provider call that is **routed through the AI Reliability gate**.

## API

- **`assertProviderCallAllowed(input)`** — returns `{ decision: "allowed" | "blocked" | "misconfigured", reason: string }` without throwing.
- **`assertBudgetAvailable` / `applyBudgetUsage`** — unchanged V1.9.1 helpers for evaluation-run budget state (still used by existing demos and tests).

## Inputs

The gate expects explicit state (no hidden network calls):

- Plan id (must map to an existing product entitlement for the deployment).
- Credits remaining and estimated credits for the call.
- **Monthly budget remaining** for routed calls this period (your accounting of spend after prior gated calls).
- **Current run spend** for optional `perRunBudgetLimitUsd` from the eval spec.
- Estimated USD cost for the call (when `failClosed` is true and pricing is unknown, the decision is **misconfigured**).

## Reasons (non-exhaustive)

Stable `reason` strings include: `routed_call_allowed`, `credits_exhausted`, `monthly_budget_exceeded`, `per_run_budget_exceeded`, `provider_not_allowed`, `model_not_allowed`, `subscription_inactive`, `missing_pricing`, `unknown_plan_entitlement`, and invalid-state codes such as `invalid_credits_state`.

## Ledger

Each gate outcome can be appended as one JSON line in `provider-call-ledger.jsonl`:

- **completed**: routed call allowed and recorded with non-zero `actualCostUsd` when known.
- **blocked**: gate blocked the call; `actualCostUsd` is `0`; `blockReason` matches the gate reason.
- **failed**: misconfiguration or validation failure path for the attempt (no spend applied).

Direct provider usage that never touches the gate is not recorded here unless you integrate it yourself.

## Wording

Use **“routed provider calls”** or **“calls routed through the AI Reliability gate.”** Do not claim that AI Reliability controls arbitrary direct API usage outside that integration.

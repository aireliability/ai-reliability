# Quick start (Growth)

Run evals locally, then enforce gating and rollout discipline before production releases.

## Run locally

```bash
npm install
npm run dev:file:openai
```

## What to look for
- Failures should be treated as release blockers for risky workflows.
- Track failures by sample ID and fix behavior before deployment.

## Run Failure Demo

```bash
npm run demo:failures
```

This demonstrates how AI Reliability catches failures before deployment.


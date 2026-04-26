# Quick start (Team)

Run evals locally first, then use CI gating to block regressions.

## Run locally

```bash
npm install
npm run dev:file:openai
```

## What to look for
- A failing summary means the model/regression is caught before deploy.
- Track the failing sample IDs and fix the behavior before merging.

## Run Failure Demo

```bash
npm run demo:failures
```

This demonstrates how AI Reliability catches failures before deployment.


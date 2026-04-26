# Quick start (Starter)

Run an eval locally and review failures before you ship changes.

## Run

```bash
npm install
npm run dev:file:openai
```

## What to look for
- The run should output a PASS/FAIL summary.
- If it fails, read the failing sample IDs and reasons and fix the underlying behavior before deployment.

## Run Failure Demo

```bash
npm run demo:failures
```

This demonstrates how AI Reliability catches failures before deployment.


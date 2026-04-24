# AI Reliability — Catch AI failures before they ship

Evaluate outputs, policy behavior, tool execution, and API cost before deployment.

## Problem

Models drift silently:
- wrong facts
- incorrect policies
- missed tool calls

They often look correct, pass review, and break in production.

Without an automated gate, you ship failures you didn’t detect.

## Example Output

```
FAIL — 1 failed, 1 passed (2 total)

s2:
Output: goodbye
Reason: Output does not include expected
```

This is what a failing model looks like before it reaches production.

### Without AI Reliability

Bad outputs reach users unnoticed.

### With AI Reliability

FAIL — 1 failed, 1 passed (2 total)

Fail the run, block the deploy, and fix the issue before impact.

## Why This Matters

- Broken outputs erode trust and increase support load
- Wrong policies create legal and billing risk
- Missed tool calls mean actions never actually happened
- Silent failures look like success until customers complain
- AI costs grow without visibility or control

## Business Overview

AI Reliability is a developer infrastructure product for teams shipping AI into production.

It helps teams:
- catch faulty AI outputs before deploy
- enforce policy and tool correctness
- monitor and control AI-related API cost
- block regressions in CI workflows

The product is sold as a subscription with usage-based expansion, targeting product teams, engineering teams, and AI-enabled software businesses.

## Pricing

Starter — $299/month — 1,000 credits  
For solo technical founders or small teams shipping one real AI workflow and needing a safety/control layer before production.

Team — $999/month — 5,000 credits  
For product teams running AI repeatedly in development and CI who need shared reliability coverage across multiple workflows.

Growth — $2,500/month — 15,000 credits  
For heavier production users with frequent eval runs, deeper usage, and stronger need for deployment control and operational reliability.

1 credit = 1 sample evaluation.

## Getting Access

AI Reliability is available via paid plans.

After purchase:
- your account is provisioned
- credits are allocated
- you receive setup instructions for running evals locally and in CI

## Support

Support: support@aireliabilityhq.com  
Billing: billing@aireliabilityhq.com  
These addresses will be activated after domain setup, company formation, and payment-provider readiness.

## FAQ

### How do I use AI Reliability?
Run evals locally or in CI before deploying AI changes.

### What does a credit mean?
1 credit = 1 sample evaluation.

### How do I pay?
Purchase a plan through the payment link on the pricing page.

### What happens after I pay?
Your account is provisioned and credits are assigned.

### Can this stop bad deployments?
Yes. Failed evals return non-zero exit codes and block CI.

### Does this control cost?
AI Reliability is being built to enforce control over risky AI usage before production.

### Do you store my data?
Your data stays in your environment unless you explicitly use hosted capabilities later.

## Requirements

- Node.js 20+
- npm

## Quick Start

```bash
npm install
npm run dev:file:openai
```

## OpenAI Setup

To run the real model-backed example, create a root `.env` file:

```bash
OPENAI_API_KEY=sk-your_openai_api_key_here
```

Use your own OpenAI API key locally. Do not commit `.env`.

Then run:

```bash
npm run dev:file:openai
```

## Examples

- [Hallucinated API](examples/hallucination.md)
- [Refund policy](examples/refund-policy.md)
- [Missing tool call](examples/tool-missing.md)

## What This Does

- Runs evals before deployment
- Detects output, policy, and system failures
- Produces human-readable summaries and JSON reports
- Enables pass/fail gating decisions before production
- Returns a non-zero exit code on failure so CI can block bad deploys

## Coming Next

- Cost guardrails (prevent runaway API spend)
- Hosted eval runs and team workflows

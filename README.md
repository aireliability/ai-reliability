# AI Reliability — Stop bad AI outputs before they hit production

Stop bad AI outputs and uncontrolled API costs before they reach production.

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

Deployment can be blocked before impact.

## Why This Matters

- Broken outputs erode trust and increase support load
- Wrong policies create legal and billing risk
- Missed tool calls mean actions never actually happened
- Silent failures look like success until customers complain
- AI costs grow without visibility or control

## Requirements

- Node.js 20+
- npm

## Quick Start

```bash
npm install
npm run dev:api        # deterministic example
npm run dev:api:openai # real model execution
```

## OpenAI Setup

To run the real model-backed example, create a root `.env` file:

```bash
OPENAI_API_KEY=sk-your_openai_api_key_here
```

Use your own OpenAI API key locally. Do not commit `.env`.

Then run:

```bash
npm run dev:api:openai
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

## Coming Next

- CI gating (block deploys on failures)
- Cost guardrails (prevent runaway API spend)
- Hosted eval runs and team workflows

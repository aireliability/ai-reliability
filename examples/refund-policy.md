# Refund policy: wrong eligibility window

## Failure Scenario

The assistant tells the user they can get a full refund after 60 days, but the real policy caps refunds at 30 days. The user acts on bad advice and support load spikes.

## Example Input

> "I bought the Pro plan 45 days ago and barely used it. Can I get a full refund?"

## Expected Behavior

Answer must match the canonical policy: state the actual refund window, any exceptions, and next steps (e.g. link to policy or support). No invented deadlines or guarantees.

## Why This Matters

Wrong policy text is a compliance and trust issue: chargebacks, legal exposure, and permanent loss of customer confidence. Catching this before deploy avoids incidents that are expensive to unwind.

## How to Test This

An eval run would **FAIL** if the model’s answer contradicts the locked policy facts (e.g. max refund window). A **policy conformance** or **fact-matching** rule compares the response against the canonical policy text or structured ground truth.

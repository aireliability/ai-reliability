# Required tool call never invoked

## Failure Scenario

The user asks to cancel subscription `sub_abc123`. The correct path is to call your billing tool to cancel and return confirmation. The model answers from memory instead, says "cancelled," and nothing happens in the billing system.

## Example Input

> "Cancel my subscription sub_abc123 effective immediately."

## Expected Behavior

The agent must invoke the billing/cancel tool (or equivalent), handle errors, and only then confirm cancellation with a reference or status from the system of record.

## Why This Is Dangerous

Unlike hallucinations (which produce incorrect information), this failure claims an action succeeded when it did not.

This breaks system correctness, not just output correctness.

In production, this leads to silent failures:
- subscriptions not cancelled
- payments not processed
- refunds not issued

The system reports success, but the real system state is unchanged.

These failures are harder to detect, more expensive to fix, and directly impact revenue and customer trust.

## How to Test This

An eval run would **FAIL** if the trace shows no billing/cancel tool call (or equivalent) while the reply claims success. A **tool-use required** or **side-effect trace** rule requires a real tool result before allowing a PASS.

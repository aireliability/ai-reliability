# Escalation Failure (Billing Dispute)

## Model
GPT-4

## Dataset
deliverables/growth/datasets/high-risk-production.json

## Tests Run
26

## Failures Detected
1

---

## Example Failure

### Input
I need to speak to a human about a billing dispute.

### Output
Please try again later. There is nothing else to do.

### Expected Behavior
Escalate to human support and provide support@aireliabilityhq.com.

### Failure Type
- logic error

### Why This Matters
Escalation failures increase chargebacks and damage trust during billing disputes.

---

## Summary

The model failed to escalate a billing dispute to human support. This should be caught before deployment to prevent avoidable chargebacks and churn.


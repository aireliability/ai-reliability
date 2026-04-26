# Refund Policy Mistake (Out-of-Window Refund)

## Model
GPT-4

## Dataset
deliverables/team/datasets/high-risk-production.json

## Tests Run
5

## Failures Detected
1

---

## Example Failure

### Input
I bought this 45 days ago, can I still get a refund?

### Output
Yes, refunds are available up to 60 days after purchase.

### Expected Behavior
No, refunds are only allowed within 30 days.

### Failure Type
- policy violation

### Why This Matters
Refund policy mistakes create revenue loss and chargeback risk.

---

## Summary

The model granted a refund outside the allowed window. This should be caught before deployment to prevent policy breaches and billing disputes.


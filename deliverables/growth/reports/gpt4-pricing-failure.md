# GPT-4 Pricing Logic Failure

## Model
GPT-4

## Dataset
deliverables/growth/datasets/high-risk-production.json

## Tests Run
3

## Failures Detected
1

---

## Example Failure

### Input
Do you offer a $10/month plan?

### Output
Yes — we offer a $10/month plan.

### Expected Behavior
No, available plans are Starter, Team, and Growth.

### Failure Type
- hallucination

### Why This Matters
Incorrect pricing answers create immediate trust loss, refunds, and support load.

---

## Summary

The model fabricated an unlisted plan. This should be caught and blocked before deployment to prevent pricing confusion and revenue-impacting errors.


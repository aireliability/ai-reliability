# Production rollout guidance (Growth)

## Recommended rollout discipline
- Run evals on every change to prompts, tools, policies, and model versions.
- Gate deploys on eval status (non-zero exit on failure should block the pipeline).

## Deployment control
- Keep a stable baseline dataset for production-critical workflows.
- Add targeted high-risk samples when new failure modes are discovered in production.
- Prefer incremental rollouts after passing eval gates.


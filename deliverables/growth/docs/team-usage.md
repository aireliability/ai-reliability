# Team usage and CI gating

## Team workflow
- Use a shared dataset + config baseline across developers and environments.
- Treat eval failures as release-blocking for high-risk workflows.

## CI gating
- Use `ci/ci-eval.yml` as a base to run evals on PRs and main.
- Configure your pipeline to block merges/releases when evals fail.


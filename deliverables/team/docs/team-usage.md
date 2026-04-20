# Team usage and CI gating

## Team workflow
- Run evals locally before opening a PR.
- Use consistent datasets and configs so results are comparable across developers and CI.

## CI gating
- Use `ci/ci-eval.yml` as a starting point for running deterministic evals on every PR.
- Configure CI to fail the build when evals fail so regressions do not ship.


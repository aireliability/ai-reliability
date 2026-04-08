# Decisions

- **Monorepo structure (packages + apps)**: Shared libraries live in `packages/`; deployable services live in `apps/`.
- **TypeScript as base language**: Use TypeScript across the repo for shared types and consistent tooling.
- **OpenAI as initial provider**: Start with OpenAI for model access via a simple HTTP integration.
- **Evaluation-first system (not generation)**: The primary goal is to run checks and block regressions, not to generate content.

## Locked decisions

- Classification is the source of truth for pass/fail
- Deterministic rules run before any LLM fallback
- Final result uses baseline-relative delta
- PASS only when classification is PASS
- GitHub is the primary distribution channel
- Repo is ai-reliability, first module is AI Reliability

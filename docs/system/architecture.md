# Architecture

## Components

- **API**: Receives requests, validates inputs, and starts evaluation runs.
- **Worker**: Executes queued evaluation work and writes results.
- **Engine**: Core evaluation logic (scoring, assertions, and orchestration).
- **Shared**: Contracts (types) and invariants/utilities used across packages and apps.

OpenAI is the initial provider, accessed via a simple shared integration.

## High-level flow

User → API → Engine → Worker → Results

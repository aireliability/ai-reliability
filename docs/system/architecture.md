# Architecture

## Components

- **API**: Receives requests, validates inputs, and starts evaluation runs.
- **Worker**: Executes queued evaluation work and writes results.
- **Engine**: Core evaluation logic (scoring, assertions, and orchestration).
- **Shared**: Shared types/utilities used across packages and apps.

## High-level flow

User → API → Engine → Worker → Results

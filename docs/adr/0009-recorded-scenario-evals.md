# ADR-0009: Evaluation on recorded scenarios through the production code path

- Status: Accepted, 2026-09-30

## Context
Prompt, model and policy changes can silently degrade grounding or coverage. Live web runs aren't reproducible, and
mocked unit tests don't exercise the real scheduler and verification.

## Decision
- Eval cases run the real engine against a throwaway database, with tool responses (and optionally model responses)
  replayed from recordings keyed by normalised request hashes, and a frozen clock.
- Three modes:
  - `replay-all`: free, runs in CI;
  - `replay-tools`: live model, fixed inputs;
  - `live`: records new fixtures.
- Results are JSON compared with committed baselines. CI fails on regressions. A missing recording is a hard failure.

## Consequences
- Reproducible comparisons of models, prompts and policies on identical inputs.
- Every live bug can become a permanent regression case.
- Recordings must be refreshed deliberately when prompts or tool calls change.

## Alternatives considered
- **Only unit tests with mocks:** miss integration failures in stateful pipelines.
- **Only live evals:** non-reproducible, costly, and noisy.

# ADR-0010: Stay on the Supabase free plan for now

- Status: Accepted, 2026-09-30 (owner's decision)

## Context
The project is a portfolio build with no paying users. Supabase Pro costs about $25 per month.

## Decision
Use the free plan for development and the first public deployment.

## Consequences
- The project pauses after a week of inactivity; unpausing is manual. Revisit before sharing the demo widely.
- No managed backups: a nightly logical dump via GitHub Actions, encrypted before upload, because artifacts on a
  public repository are downloadable by others.
- 500 MB database: page text is referenced rather than copied in conversation logs, and logs are pruned.
- The organisation's free-project allowance must be checked when the project is created.
- Moving to Pro later is a plan change, not an architecture change.

## Alternatives considered
- **Pro from the start:** removes pausing and adds backups; deferred for cost.
- **Self-hosted Postgres on Railway:** loses Supabase Auth and Realtime, which the architecture relies on.

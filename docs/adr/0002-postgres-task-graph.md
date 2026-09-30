# ADR-0002: A Postgres task graph instead of an orchestration framework

- Status: Accepted, 2026-09-30

## Context
Runs take minutes to hours, pause for humans, fan out per company, retry, and must survive crashes, deploys and
provider outages. The UI must show the task graph live. Durable state, concurrency and explainability matter more
than developer convenience.

## Decision
The `tasks` table is the queue and the source of truth. Workers claim tasks with `FOR UPDATE SKIP LOCKED` through a
`SECURITY DEFINER` function, hold fenced leases with heartbeats, and complete each task in one transaction that writes
outputs, expands the graph, promotes dependents and appends events. Expansion rules, retries, budgets and run status
are code. No LangGraph, CrewAI, Mastra, Temporal, Inngest or Trigger.dev.

## Consequences
- One source of truth: the UI, evals and debugging read the same rows the scheduler writes.
- No extra infrastructure; horizontal scaling is safe by construction.
- Human gates cost nothing while waiting: no process sleeps.
- We own the correctness of leasing, fencing and idempotency. Mitigated by a small surface, multi-worker and
  kill-mid-task integration tests against real Postgres, and exhaustive tests of the pure `deriveRunStatus` function.

## Alternatives considered
- **Temporal:** excellent durability, but another cluster to run, and its event history would duplicate the task
  graph that Postgres must hold for the UI anyway.
- **Inngest / Trigger.dev:** the same duplication, plus durability hosted by a vendor.
- **LangGraph / CrewAI / Mastra:** they would own orchestration and state, which is the engineering this project
  exists to demonstrate, and their checkpoints would duplicate our tables.
- **pg-boss / Graphile Worker:** solid queues, but task state would then live in two places (queue table and our tasks table).

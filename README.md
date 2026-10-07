# AI Operations Command Center

[![CI](https://github.com/melancholy1212/ai-ops-command-center/actions/workflows/ci.yml/badge.svg)](https://github.com/melancholy1212/ai-ops-command-center/actions/workflows/ci.yml)

A multi-agent research platform that turns a business objective into verified, evidence-linked results. It runs a
durable task graph, has a custom MCP capability server, verifies every finding against saved sources, and pauses for
human approval before anything leaves the system.

The flagship workflow is prospect research: find companies that match criteria, identify decision makers, verify
every fact, rank the prospects, and draft outreach that cites only verified facts. Every statement in the final
report traces to an exact quote in a saved source:

```
Finding → Claim → Evidence → Source snapshot → exact quote
```

## Status

**Phase 4 (evidence, verification, planner, report, run view) is complete: a live run on 2026-10-07 went plan →
discover → verify → report on three real companies. Phase 5 (the full workflow) is next.** Each phase ends with
typecheck, lint, tests, build and CI green before the next begins.

| Area | Built | Not yet |
|---|---|---|
| Monorepo | pnpm 12 + Turborepo, strict TypeScript 6.0, ESLint 10, Prettier, Vitest, CI | — |
| Contracts | Zod schemas for runs, tasks, executions, claims, evidence, approvals, findings, MCP tools, events | — |
| Database | Workspaces, members, projects; runs, tasks, dependencies, approvals, run events, audit log; agent executions, messages, model and tool calls; discovered URLs and source snapshots; rate limits; companies, claims, evidence (immutable, judge fields only), research gaps, findings, versioned artifacts; row-level security for users and for the backend role; pgTAP + integration tests | People, registry identifiers (Phase 5) |
| Workflow engine | Durable task graph with fenced leases, heartbeats, lease recovery, retries with backoff, hard/soft dependencies, idempotent expansion, cycle rejection, cancel/pause/resume, budgets with extension approvals, hash-checked human approvals, plan replanning; workflow version 1 (plan → approve → discover → verify → report) | Profile, people, gap-fill, analysis and outreach steps (Phase 5+) |
| Web | Supabase email/password auth; runs list; new run (objective, seed pages); run page with status, budget, stages, tasks, plan approval from the stored snapshot, report, claims with quotes and sources, event timeline | Execution graph, drill-down drawer, live event stream, approvals inbox (Phase 5+) |
| Worker | Scheduler (concurrent claims, heartbeats, time limits, lease recovery, graceful shutdown); agent runtime (bounded tool loop with code-enforced pacing and last-turn salvage, capability tokens, full telemetry); Research agent, planner, verifier; code-only report | Company and people agents, analyst, writer (Phase 5+) |
| LLM layer | Route classes to model bindings, circuit breakers, Anthropic and OpenAI-compatible (Earthruntime) adapters, pricing, record/replay | — |
| MCP server | Authenticated Streamable HTTP endpoint (per-execution EdDSA capability tokens), `web_search`, `fetch_page`, `get_source`; provenance-bound fetching through an SSRF-safe fetcher; audit and spend per call | `search_knowledge`, registry tools (Phase 5), workspace API keys |
| Evals | Replay harness through the production code path; a synthetic discovery case and seven verification cases (contested amounts, syndication, injection, criteria, undisclosed amounts, entity resolution, ungrounded quotes) gated in CI; live real-web runs with full traces | People and outreach cases (Phase 5) |

## Run it locally

Requires Node.js 22, pnpm 12 and Docker.

```bash
pnpm install
pnpm db:start      # local Supabase (own ports: 55321 API, 55322 Postgres)
pnpm setup:local   # local-only credentials and git-ignored .env.local files
pnpm dev           # http://localhost:3000 (from another computer: the LAN URL setup:local prints)
```

`pnpm check` runs everything CI's first job runs; `pnpm db:test` and `pnpm test:integration` cover the database.
Integration tests need the local stack (`pnpm db:start`) and run one package and one file at a time, because the task
claim query is global; for the same reason the test harness refuses to start while a worker (such as `pnpm dev`) is
connected: the core engine suite drives full prospect runs through both human gates, and the worker suite runs competing
workers, kills one with SIGKILL mid-task, and checks that a stalled worker's late result is discarded.
Details in [docs/deployment.md](docs/deployment.md).

## Documentation

Start with [docs/architecture.md](docs/architecture.md), then:

- [Domain model](docs/domain-model.md) and [contracts](packages/contracts/src)
- [State machines](docs/state-machines.md) and [workflow specification](docs/workflow.md)
- [Agents](docs/agents.md), [MCP server contract](docs/mcp.md), [LLM routing](docs/llm.md)
- [Provenance, URL authorisation and verification](docs/provenance.md)
- [Evaluation](docs/evaluation.md), [security and threat model](docs/security.md)
- [Database](docs/database.md), [observability](docs/observability.md), [UI](docs/ui.md), [deployment](docs/deployment.md)
- [Architecture decision records](docs/adr/)

## Planned stack

TypeScript (strict), pnpm + Turborepo, Next.js, Supabase (Postgres, Auth, Realtime), Railway (worker, MCP server),
Vercel (web), Zod, Kysely, the official MCP TypeScript SDK, Vitest. No agent orchestration framework: the workflow
engine is a Postgres task graph with leases, written and tested here.

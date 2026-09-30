# Architecture overview

Status: **Phase 3 (tools, LLM layer, first agent) complete.** Implemented: the monorepo and tooling, the domain
contracts, tenancy with row-level security, Supabase auth with a personal workspace per user, the web app shell, the
workflow engine (Postgres task graph, `@aoc/core`, worker scheduler), the LLM layer (`@aoc/llm`: router, Anthropic and
OpenAI-compatible adapters, pricing, record/replay), the MCP server with capability tokens, the egress-safe fetcher and
three tools, the agent runtime with the Research agent for discovery, and the eval harness. Verification, the planner,
the other agents and the run UI described below are designed but not built yet; see the build phases at the end.

## What the system does

A user states a business research objective ("find European cybersecurity startups that raised money recently,
identify decision makers, verify them, rank the best prospects and draft outreach"). The system:

1. turns it into a structured brief and asks the user to approve the plan and budget;
2. runs a durable task graph in which three research agents work concurrently;
3. verifies every finding against saved copies of its sources;
4. ranks the prospects, drafts outreach from verified facts only, and asks for approval;
5. delivers a report in which every fact traces to an exact quote in a saved source.

The MVP supports one workflow: **prospect research**. The architecture is generic; the product surface is not, on purpose.

## Principles

| Principle | Consequence |
|---|---|
| Code owns control flow; models own judgment | Scheduling, retries, leases, budgets, approvals and state transitions are code and SQL. Models plan, research and write, and their output is always a proposal that code validates. |
| Postgres is the source of truth | The tasks table is the queue. Nothing critical lives only in memory. Any process can die at any time. |
| No orchestration framework | No LangGraph, CrewAI, Mastra, Temporal, Inngest or Trigger.dev. The engine is small, explicit and tested ([ADR-0002](adr/0002-postgres-task-graph.md)). |
| Agents never talk to each other | They read typed, persisted inputs and write typed outputs. Every handoff is a row. |
| MCP is a capability layer | Research and knowledge-read tools only. Nothing in MCP creates tasks, changes workflow state or decides approvals ([ADR-0003](adr/0003-mcp-capability-layer.md)). |
| Provenance is first-class | Finding → Claim → Evidence → Source snapshot → exact quote span, enforced by schema and database constraints. |
| Verification is deterministic first | Grounding, policies, conflicts and coverage are code. A model only answers "does this quote support this claim?" ([ADR-0004](adr/0004-verification-deterministic-first.md)). |
| Confidence is computed | From evidence features, by code. Never supplied by a model. |
| Everything important is persisted | Timeline, executions, every model call and tool call with tokens, cost, latency and retries. |
| Agent loops only where open-ended | Three tool-using agents; everything else is one structured call inside a code step ([ADR-0008](adr/0008-agent-loops-only-where-open-ended.md)). |

## System

```
 Browser ──(pages, server actions)──► Next.js [Vercel]
    ▲                                   │ reads as the user (RLS) · commands via domain code
    │ Realtime: run_events              ▼
    └──────────────────────────────── Supabase: Postgres · Auth · Realtime
                                        ▲                ▲   system of record;
                          claim · lease │                │   tasks table = queue
                                        │                │ sources · tool_calls
                        Worker [Railway]┘                │
                        scheduler                MCP server [Railway] ◄── external MCP clients
                        agent loops ────MCP────► tools · providers        (workspace API keys)
                        verification             egress policy
                             │                           │
                             ▼                           ▼
                      LLM provider(s)      search API · registries · web
```

| Component | Responsibility | Holds secrets for |
|---|---|---|
| Web (Next.js, Vercel) | Control-room UI. Reads as the signed-in user through Supabase (RLS). Commands (start, approve, cancel) go through `packages/core` in one transaction. | Supabase publishable key; backend DB role for commands |
| Postgres (Supabase) | Workflow state, knowledge, evidence, telemetry, audit. Auth and Realtime. | — |
| Worker (Railway) | Scheduler (claim, lease, heartbeat, reap, expand, promote), agent runtime, verification engine, budget enforcement. Stateless; scales horizontally. | LLM provider keys; capability-token signing key |
| MCP server (Railway) | The only path from agents to the outside world. Tools, provider adapters, egress policy, snapshot capture, rate limits, audit. Usable standalone by MCP clients. | Data-provider keys; capability-token verification key |

The web app and the worker never call each other. The database is the only integration point, which keeps both
independently testable and deployable.

## The traceability chain

The product's core promise is that every fact can be traced:

```
Artifact (report, outreach draft)
  └─ Finding          score (code) or analysis/inference (model, labelled), cites ≥1 claim
      └─ Claim        typed assertion about one entity; statement rendered by code
          └─ Evidence exact quote + located span + grounding result + judge verdict
              └─ SourceSnapshot   saved text, content hash, HTTP metadata, retrieval time
                  └─ DiscoveredUrl   why this URL was allowed to be fetched
```

A report never contains model-generated facts. Facts appear only as claim statements. Model-written text appears
only as findings labelled `analysis` or `inference`, each citing its claims. See [domain-model.md](domain-model.md).

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript, strict, everywhere ([ADR-0001](adr/0001-typescript-monorepo.md)) |
| Monorepo | pnpm workspaces + Turborepo |
| Web | Next.js (App Router), React, Tailwind, shadcn/ui, React Flow |
| Contracts | Zod 4 (runtime validation + JSON Schema for LLM and MCP tools) |
| Database | Supabase Postgres, SQL migrations (Supabase CLI), Kysely for typed queries in backend code |
| Auth / live | Supabase Auth, Supabase Realtime |
| MCP | Official MCP TypeScript SDK; stdio and Streamable HTTP |
| LLM | Own provider interface + router; Anthropic and OpenAI-compatible adapters ([llm.md](llm.md)) |
| Testing | Vitest, real-Postgres integration tests, pgTAP for RLS, recorded-scenario evals ([evaluation.md](evaluation.md)) |

Pinned in Phase 1 (exact versions, no ranges):

| Tool | Version | Why this one |
|---|---|---|
| TypeScript | 6.0.3 | 7.x (`latest`) no longer ships the compiler API that typescript-eslint (supports < 6.1) and Next.js use |
| Next.js / React | 16.3.6 / 19.3.0 | 16.3.7 was under a day old; pnpm's release-age policy stays on with no exemptions |
| pnpm | 12.8.1 | `minimumReleaseAge` (24 h) enforced; install scripts allowed only for esbuild |
| Node.js | 22 LTS | Vitest 5 needs ≥ 22.12 |
| Zod / Kysely / MCP SDK | 4.6.5 / 0.29.6 / 1.31.0 | Current stable |
| Supabase CLI | 2.109.1 | Its images were already on the development machine (disk is tight); CI pulls its own |

## Repository layout

```
apps/
  web/            Next.js control room
  worker/         scheduler · agent runtime · agents/ · verification/
  mcp-server/     tools, egress policy, evidence capture (stdio + HTTP)
packages/
  contracts/      Zod domain contracts
  db/             Kysely client, generated types, workspace-scoped transactions
  config/         tsconfig presets, env validation, logger
  core/           domain rules shared by web + worker: commands, transitions, approvals, budgets
  llm/            provider interface, router, adapters, pricing, record/replay, scripted fake for tests
  providers/      (Phase 3) search / company / people provider interfaces + adapters (used only by mcp-server)
scripts/          setup-local-env.mjs (local credentials and .env.local files)
supabase/         migrations/ (source of truth), tests/ (pgTAP), seed.sql
evals/            cases/ (case + recorded fixtures), baselines/, runner (src/)
docs/             this documentation and adr/
```

## Documents

| Document | Contents |
|---|---|
| [domain-model.md](domain-model.md) | Entities, contracts, invariants, the traceability chain |
| [state-machines.md](state-machines.md) | Run, task, execution, approval, claim and gap transitions; leases, crashes, retries, idempotency |
| [workflow.md](workflow.md) | The MVP workflow, task by task |
| [agents.md](agents.md) | The three agent loops and four structured calls |
| [provenance.md](provenance.md) | URL authorisation, egress policy, snapshots, grounding, prompt-injection handling |
| [mcp.md](mcp.md) | MCP server contract, tools, auth, limits, errors, standalone use |
| [llm.md](llm.md) | Provider abstraction, routing, telemetry, pricing |
| [evaluation.md](evaluation.md) | Recorded scenarios, metrics, baselines, regression gates |
| [security.md](security.md) | Threat model and controls |
| [database.md](database.md) | Schema, constraints, RLS, roles |
| [observability.md](observability.md) | Traces, events, metrics, drill-down |
| [ui.md](ui.md) | Control-room design |
| [deployment.md](deployment.md) | Environments, free-tier limits, CI/CD, where each secret lives |
| [adr/](adr/) | Architecture decision records |

## Build phases

| Phase | Delivers | Done when |
|---|---|---|
| 0 Architecture ✅ | These documents, ADRs, verified contracts | Approved |
| 1 Foundation ✅ | Monorepo, strict TS, lint, Vitest, env validation, first migration (tenancy + RLS), auth, personal workspace on signup, CI, deployable web/worker/MCP skeletons | typecheck, lint, tests, build, migrations, local startup and CI all green |
| 2 Workflow engine ✅ | Runs, tasks, dependencies, events, approvals; claim/lease/heartbeat/reap/expand/promote; budgets; cancellation; scheduler with scripted handlers in tests | Multi-worker and kill-mid-task tests pass against real Postgres |
| 3 Tools + LLM + first agent ✅ | MCP server (search, fetch, egress, provenance, tokens, audit), LLM router + adapters, agent loop, Research agent, eval harness v0 | A traced discovery run on real sources; replay eval passes |
| 4 Evidence + verification | Sources, claims, evidence, grounding, judge, policies, confidence, gaps, planner, thin run view | First end-to-end run: plan → discover → verify → report |
| 5 Full workflow | Company + People agents, registry providers, gap-fill, ranking + analysis, outreach, approvals, export | Flagship objective completes |
| 6 Control room UI | Dashboard, live run view, drill-down, approvals, agents, MCP, evidence pages | Usable without the database console |
| 7 Hardening | Rate limits, security tests, backups, demo mode, docs | MVP criteria met |
| v1.1 | Critic with bounded revision loops | — |

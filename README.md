# AI Operations Command Center

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

**Phase 1 (foundation) is complete.** Each phase ends with typecheck, lint, tests, build and CI green before the
next begins.

| Area | Built | Not yet |
|---|---|---|
| Monorepo | pnpm 12 + Turborepo, strict TypeScript 6.0, ESLint 10, Prettier, Vitest, CI | — |
| Contracts | Zod schemas for runs, tasks, executions, claims, evidence, approvals, findings, MCP tools, events | — |
| Database | Workspaces, members, projects; row-level security for users and for the backend role; personal workspace on signup; pgTAP + integration tests | Workflow, evidence and telemetry tables (Phase 2+) |
| Web | Supabase email/password auth, session refresh, dashboard shell | Runs, graph, evidence, approvals UI (Phases 2–6) |
| Worker | Health, database check, graceful shutdown | Scheduler and agents (Phases 2–5) |
| MCP server | MCP handshake over stdio, health endpoint | Tools and authentication (Phase 3) |

## Run it locally

Requires Node.js 22, pnpm 12 and Docker.

```bash
pnpm install
pnpm db:start      # local Supabase (own ports: 55321 API, 55322 Postgres)
pnpm setup:local   # local-only credentials and git-ignored .env.local files
pnpm dev           # http://localhost:3000
```

`pnpm check` runs everything CI's first job runs; `pnpm db:test` and `pnpm test:integration` cover the database.
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

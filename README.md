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

**Phase 0: architecture.** The documentation and the domain contracts exist. The contracts are Zod schemas that
type-check under strict TypeScript and have runtime invariant checks. Nothing else is implemented yet: no database,
no services, no UI. Each phase ends with typecheck, lint, tests, build and CI green before the next begins.

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

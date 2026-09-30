# Architecture decision records

| ADR | Decision |
|---|---|
| [0001](0001-typescript-monorepo.md) | TypeScript everywhere, in a pnpm + Turborepo monorepo |
| [0002](0002-postgres-task-graph.md) | A Postgres task graph instead of an orchestration framework |
| [0003](0003-mcp-capability-layer.md) | MCP is a capability layer, not a workflow engine |
| [0004](0004-verification-deterministic-first.md) | Verification is deterministic first; confidence is computed by code |
| [0005](0005-workspace-isolation.md) | Workspace isolation through RLS for users and for the backend |
| [0006](0006-url-authorisation-by-provenance.md) | URLs are fetchable only if they have a provenance origin in scope |
| [0007](0007-llm-routing.md) | Provider-agnostic LLM layer with route classes |
| [0008](0008-agent-loops-only-where-open-ended.md) | Agent loops only where the work is open-ended |
| [0009](0009-recorded-scenario-evals.md) | Evaluation on recorded scenarios through the production code path |
| [0010](0010-supabase-free-tier.md) | Stay on the Supabase free plan for now |

A new decision gets the next number. A reversed decision is not edited: a new ADR supersedes it and both link to each other.

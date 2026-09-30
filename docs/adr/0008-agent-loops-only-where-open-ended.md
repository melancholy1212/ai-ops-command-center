# ADR-0008: Agent loops only where the work is open-ended

- Status: Accepted, 2026-09-30

## Context
The brief listed eight agents. Agent loops cost more, vary more between runs, and are harder to test than a single
schema-constrained call inside a code step.

## Decision
- Three tool-using loops, where the path can't be specified in advance: Research, Company Intelligence, People Discovery.
- Four single structured calls inside code-driven steps: Planner, Verifier (judge), Analyst, Outreach writer.
- The orchestrator is the scheduler plus the planner, not a managing agent.
- The Critic is deferred to v1.1: most of its checks (duplicates, missing fields, contradictions, unsupported claims)
  are deterministic and already in verification; what remains is judgment on deliverables.
- Roles are versioned code, not database rows.

## Consequences
- Cheaper, more reproducible runs; most of the system is testable without a model.
- The multi-agent design is justified by specialisation (different tools, schemas and rules per role), not by headcount.
- Adding a role is cheap (config, prompt, schemas, evals), so the line can move when evidence says so.

## Alternatives considered
- **Eight autonomous agents with a managing orchestrator agent:** more impressive on a slide, less reliable in production.

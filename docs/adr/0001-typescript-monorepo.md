# ADR-0001: TypeScript everywhere, in a pnpm + Turborepo monorepo

- Status: Accepted, 2026-09-30

## Context
Three deployables (web, worker, MCP server) share one domain: task payloads, agent inputs and outputs, tool
schemas, events. The system is I/O-bound (model APIs, HTTP, Postgres), not compute-bound.

## Decision
TypeScript in strict mode for every app and package, with Zod contracts shared through `packages/contracts`.
pnpm workspaces for dependencies, Turborepo for task orchestration and caching.

## Consequences
- One type system across every boundary. A contract change breaks the build everywhere it matters.
- The official MCP TypeScript SDK and Next.js are first-class.
- pnpm's content-addressed store saves disk on a constrained development machine.
- Weaker content-extraction libraries than Python's; acceptable for the MVP, and a Python extraction service could
  sit behind the MCP server later without touching agents.

## Note (Phase 1)
TypeScript is pinned to 6.0.3. The `latest` release, 7.x, no longer ships the compiler API that typescript-eslint
and Next.js's build-time type check rely on (`require('typescript').createProgram` is undefined), and typescript-eslint
supports TypeScript below 6.1. Moving to 7.x waits for that tooling.

## Alternatives considered
- **Python backend + TypeScript frontend:** stronger AI and extraction ecosystem, but two type systems, duplicated
  contracts (Pydantic and Zod) and two toolchains, for a system whose work is mostly waiting on network calls.
- **npm/yarn workspaces without Turborepo:** workable, but no task caching or dependency-aware pipelines across nine workspaces.

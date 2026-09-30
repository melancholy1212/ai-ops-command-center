# ADR-0005: Workspace isolation through RLS for users and for the backend

- Status: Accepted, 2026-09-30

## Context
Backend services usually connect with a role that bypasses row-level security, so tenant isolation depends on every
query remembering a `WHERE workspace_id = ...`. Here, much of that code runs on behalf of models reading untrusted content.

## Decision
- Users read through RLS with their Supabase session.
- The worker, the MCP server and web commands connect as `app_backend`, a role **without** BYPASSRLS. Each unit of
  work runs in a transaction that sets `app.workspace_id`, and policies admit the backend only to that workspace.
- The only cross-workspace operations are `claim_next_task()` and `reap_expired_leases()`, `SECURITY DEFINER`
  functions that return minimal data.
- The service-role key is used only for migrations and administration.

## Consequences
- A bug in agent or tool code cannot read another tenant's rows; the database refuses.
- Every tenant table carries `workspace_id` with composite foreign keys, so RLS stays a single indexed check.
- Must be validated against Supabase's connection pooler in Phase 1. Fallback if a custom role fights the tooling:
  service connection plus one mandatory workspace-scoped repository layer, with the same tests.

## Alternatives considered
- **Service role + application-level filtering:** common, but one forgotten filter is a cross-tenant leak.
- **Schema or database per tenant:** strong isolation, heavy operations; unnecessary at this scale.

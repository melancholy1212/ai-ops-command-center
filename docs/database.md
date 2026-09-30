# Database

Supabase Postgres. SQL migrations in `supabase/migrations/` are the source of truth. Backend code queries with
Kysely using types generated from the database; the browser reads through Supabase with the user's session.

## Conventions

- Primary keys are `uuid` (`gen_random_uuid()`); append-only logs use `bigint` identity.
- Every tenant table has `workspace_id`. Child tables repeat it and use composite foreign keys, e.g.
  `tasks (run_id, workspace_id) → runs (id, workspace_id)`, so it can't drift and RLS stays a single indexed check.
- Status columns are `text` with `CHECK` constraints generated from the Zod enums. A test compares them.
- Contract invariants that SQL can express are `CHECK` constraints (e.g. `(status = 'running') = (lease_token IS NOT NULL)`).
- Immutable columns (snapshot hashes, snapshot text, evidence quotes, approved artifact content) are protected by
  `BEFORE UPDATE` triggers.
- Money is `bigint` micro-USD. Timestamps are `timestamptz`.
- JSONB only for validated payloads whose shape is owned by a contract (task input/output, claim values, snapshots,
  event data). Anything filtered, joined or constrained on is a column.

## Tables

### Tenancy and access
- `workspaces` (id, name, slug unique).
- `workspace_members` (workspace_id, user_id → `auth.users`, role ∈ owner/admin/member/viewer; PK both).
- `projects` (workspace_id, name unique per workspace, criteria defaults, scoring weights, sender_profile, default_budget).
- `api_keys` (workspace_id, name, prefix, key_hash, scopes, created_by, last_used_at, revoked_at). `key_hash` is never readable by `authenticated`.
- `mcp_sessions` (workspace_id, api_key_id, started_at, last_seen_at, closed_at).

### Workflow
- `runs`: objective, workflow + version, brief (JSONB), status, pause_reason, cancel_requested, budget (JSONB),
  spend columns, failure, last_event_seq, timestamps. `CHECK`s for paused ⇔ pause_reason, failed ⇔ failure,
  terminal ⇔ finished_at.
- `tasks`: type, kind, status, subject_company_id, input, output, `unique (run_id, idempotency_key)`, parent_task_id,
  attempt, max_attempts, run_after, lease_owner, lease_token, lease_expires_at, heartbeat_at, last_failure, priority.
  Indexes: `(priority, run_after) WHERE status = 'ready'` (claim), `(lease_expires_at) WHERE status = 'running'`
  (reap), `(run_id, status)`.
- `task_dependencies` (task_id, depends_on_task_id, mode ∈ hard/soft; PK both; `CHECK task_id <> depends_on_task_id`;
  index on depends_on_task_id). Graphs are acyclic by construction (expansion only adds edges to new or blocked
  downstream tasks); a test asserts it.
- `approvals`: type, target (JSONB), snapshot (JSONB), snapshot_hash, snapshot_schema_version, status, decision
  fields, invalidation fields. Partial unique index: one pending approval per target. `CHECK`: decided ⇔ decision
  fields present; rejection ⇒ reason.
- `run_events` (run_id, seq, type, actor, refs, data, occurred_at; PK (run_id, seq)). Append-only. `seq` comes from
  `runs.last_event_seq`, incremented in the same transaction, so sequences are gap-free per run (identity values
  can commit out of order and would leave gaps for a reconnecting client).

### Execution and telemetry
- `agent_executions`: agent, agent_version, prompt_hash, attempt (`unique (task_id, attempt)`), status, input,
  output, limits, usage columns, retry_of, failure, started_at, ended_at.
- `agent_messages` (execution_id, seq, role, content JSONB; PK both). Tool results carrying page text store a
  reference to the snapshot range, not a copy. Pruned after the retention period.
- `llm_calls`: every field of the `LlmCall` contract; `unique (execution_id, seq)`.
- `tool_calls`: every field of the `ToolCall` contract; `CHECK` exactly one scope (execution or MCP session).
- `rate_limit_counters` (key, window_start, count; PK both). Backend only.
- `provider_cache` (workspace_id, provider, request_hash, response, expires_at). TTL per provider's terms of service.

### Knowledge and evidence
- `companies` (name, normalized_name, primary_domain, country). `unique (workspace_id, primary_domain)` where not
  null; trigram index on normalized_name.
- `people` (full_name, normalized_name). Trigram index.
- `entity_identifiers` (company_id or person_id, scheme, value, source_id). `CHECK num_nonnulls(company_id, person_id) = 1`;
  `unique (workspace_id, scheme, value)`.
- `discovered_urls` (run_id or mcp_session_id, url, normalized_url, normalized_url_hash, origin_kind, origin JSONB).
  Partial unique indexes per scope on the hash.
- `sources`: every field of `SourceSnapshot`; `unique (workspace_id, final_url_hash, content_sha256)`; index on
  (workspace_id, registrable_domain).
- `claims`: subject_company_id / subject_person_id, attribute, value, raw_value, statement, fingerprint
  (`unique (run_id, fingerprint)`), status, confidence, confidence_score, verification JSONB (reasons, policy),
  conflict_state, superseded_by, proposer fields, source dates. Indexes (run_id, subject_company_id, attribute), (run_id, status).
- `evidence`: claim_id, source_id, quote, quote_sha256 (`unique (claim_id, source_id, quote_sha256)`), grounding,
  spans, value_in_quote, stance, judge fields, source dates, extracted_by_execution_id.
- `research_gaps`: run_id, company_id, person_id, attribute, status, reason, attempts, note. Unique per run, entity and attribute.

### Outputs and audit
- `findings`: subject, kind, label, statement, score JSONB, author fields. `CHECK`: score ⇔ kind = 'score'; model author ⇒ label ≠ 'fact_derived'.
- `finding_claims` (finding_id, claim_id, role; PK both).
- `artifacts`: kind, subject ids, version, previous_version_id, status, content, content_hash, author.
  `unique (run_id, kind, subject, version)`.
- `artifact_references` (artifact_id, claim_id or finding_id).
- `audit_logs` (workspace_id, actor, action, target_type, target_id, metadata, created_at). Append-only.

## Roles (implemented in `20260930120000_tenancy.sql`)

| Role | Attributes | Purpose |
|---|---|---|
| `app_backend` | `NOLOGIN NOBYPASSRLS` | Holds the backend's table privileges; RLS policies for services target it |
| `aoc_service` | `LOGIN NOINHERIT NOBYPASSRLS`, member of `app_backend` with `SET` only | The role services connect as. It has no privileges until `withWorkspace()` runs `SET LOCAL ROLE app_backend` and sets `app.workspace_id` in the transaction |
| `postgres` | admin | Also granted `SET` (not inherit) on `app_backend`: Postgres 16+ does not let a role's creator assume it automatically, and tests and admin tooling need to |

Verified by pgTAP (`supabase/tests/tenancy.test.sql`, 21 checks) and by integration tests that connect as a
throwaway login role configured exactly like `aoc_service` (asserted), created and dropped per run so tests
never touch development credentials (`packages/db/src/workspace.integration.test.ts`): scoping, refusal outside the workspace, rollback,
and no leak of role or scope to the next user of a pooled connection.

Implemented so far: `workspaces`, `workspace_members`, `projects`, the RLS helpers, the roles, and the signup
trigger that creates a personal workspace, owner membership and default project. The remaining tables below are
the design for later phases.

## Row-level security

```sql
-- users read rows of workspaces they belong to
create policy member_read on public.runs for select to authenticated
  using (private.is_member(workspace_id));

-- the backend sees only the workspace set in its transaction
create policy backend_scoped on public.runs for all to app_backend
  using (workspace_id = private.current_workspace())
  with check (workspace_id = private.current_workspace());
```

`private.current_workspace()` reads `current_setting('app.workspace_id', true)::uuid` (null when unset, which matches
nothing). `private.is_member()` is a `SECURITY DEFINER`, `STABLE` helper over `workspace_members`. The same pair of
policies is applied to every tenant table, with narrower variants where needed (e.g. `audit_logs` readable by owners
and admins only; `api_keys.key_hash` excluded through column privileges).

## Functions

| Function | Security | Purpose |
|---|---|---|
| `claim_next_task(worker_id, lease_seconds)` | definer, callable by `app_backend` | Claim one ready task across workspaces with `FOR UPDATE SKIP LOCKED`; returns (task_id, workspace_id, lease_token) |
| `reap_expired_leases(max_rows)` | definer, callable by `app_backend` | Return tasks with expired leases to ready (or failed); mark executions abandoned |
| `private.is_member(workspace_id)` | definer, stable | RLS helper |
| `private.current_workspace()` | invoker, stable | RLS helper |

## Migrations

One change per migration, named `YYYYMMDDHHMMSS_description.sql`, with pgTAP tests in `supabase/tests/`. Migrations
are expand/contract (add, backfill, switch, then remove), so the web app, worker and MCP server can deploy in any
order. CI applies every migration to a fresh database and runs the RLS suite on every push.

## Size budget (free plan, 500 MB)

A 10-company run stores roughly 100 snapshots (≈ 2 MB of text) plus claims, evidence and telemetry. Conversation
logs dominate if they copy page text, which is why tool results are stored as snapshot references and pruned after
30 days.

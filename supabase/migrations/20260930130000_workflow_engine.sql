-- Workflow engine (docs/state-machines.md, docs/workflow.md, ADR-0002):
--   * runs, tasks, task_dependencies, approvals, run_events, audit_logs
--   * the tasks table is the queue: private.claim_next_task() leases one ready task with
--     FOR UPDATE SKIP LOCKED; private.reap_expired_leases() takes over tasks whose worker died
--   * those two SECURITY DEFINER functions are the only cross-workspace operations; every state
--     transition runs as app_backend, scoped to one workspace by row-level security
--   * run_events and audit_logs are append-only; approval snapshots are immutable
-- Status value lists mirror the Zod enums in packages/contracts (a drift test compares them).

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null,
  workflow text not null check (workflow in ('prospect_research')),
  workflow_version integer not null check (workflow_version > 0),
  objective text not null check (char_length(objective) between 10 and 4000),
  brief jsonb,
  status text not null default 'draft' check (
    status in ('draft', 'planning', 'awaiting_plan_approval', 'running', 'paused', 'completed', 'failed', 'cancelled')
  ),
  pause_reason text check (pause_reason in ('awaiting_approval', 'budget_exhausted', 'user_requested')),
  cancel_requested boolean not null default false,
  pause_requested boolean not null default false,
  budget_blocked boolean not null default false,
  budget jsonb not null,
  spend_cost_usd_micros bigint not null default 0 check (spend_cost_usd_micros >= 0),
  spend_llm_input_tokens bigint not null default 0 check (spend_llm_input_tokens >= 0),
  spend_llm_output_tokens bigint not null default 0 check (spend_llm_output_tokens >= 0),
  spend_tool_calls integer not null default 0 check (spend_tool_calls >= 0),
  failure jsonb,
  last_event_seq bigint not null default 0 check (last_event_seq >= 0),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  foreign key (project_id, workspace_id) references public.projects (id, workspace_id) on delete cascade,
  unique (id, workspace_id),
  check ((status = 'paused') = (pause_reason is not null)),
  check ((status = 'failed') = (failure is not null)),
  check ((status in ('completed', 'failed', 'cancelled')) = (finished_at is not null)),
  check (status not in ('awaiting_plan_approval', 'running', 'completed') or brief is not null),
  check ((status = 'draft') = (started_at is null))
);
create index runs_workspace_created_idx on public.runs (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Tasks: the queue
-- ---------------------------------------------------------------------------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  workspace_id uuid not null,
  type text not null check (
    type in (
      'plan_run', 'approve_plan', 'discover_companies', 'profile_company', 'find_people', 'verify_entity',
      'gap_fill', 'rank_and_analyze', 'draft_outreach', 'approve_outreach', 'compile_report'
    )
  ),
  kind text not null check (kind in ('code', 'structured_llm', 'agent_loop', 'human_gate')),
  status text not null default 'blocked' check (
    status in ('blocked', 'ready', 'running', 'waiting_approval', 'succeeded', 'failed', 'skipped', 'cancelled')
  ),
  -- Foreign key to companies is added with the companies table (Phase 4).
  subject_company_id uuid,
  input jsonb not null,
  output jsonb,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  parent_task_id uuid references public.tasks (id) on delete set null,
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null check (max_attempts between 1 and 10),
  run_after timestamptz not null default now(),
  priority smallint not null default 50 check (priority between 0 and 100),
  lease_owner text check (char_length(lease_owner) <= 100),
  lease_token uuid,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  last_failure jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  foreign key (run_id, workspace_id) references public.runs (id, workspace_id) on delete cascade,
  unique (run_id, idempotency_key),
  unique (id, workspace_id),
  unique (id, run_id),
  check (attempt <= max_attempts),
  check ((status = 'running') = (lease_token is not null)),
  check ((lease_token is null) = (lease_owner is null) and (lease_token is null) = (lease_expires_at is null)),
  check ((status = 'succeeded') = (output is not null)),
  check ((status in ('succeeded', 'failed', 'skipped', 'cancelled')) = (finished_at is not null)),
  check ((input ->> 'type') = type),
  check (
    (type in ('profile_company', 'find_people', 'verify_entity', 'gap_fill', 'draft_outreach'))
    = (subject_company_id is not null)
  ),
  check (subject_company_id is null or subject_company_id::text = input ->> 'companyId')
);
-- The claim query: ready tasks in priority order.
create index tasks_ready_idx on public.tasks (priority desc, run_after, created_at) where status = 'ready';
-- The reaper: running tasks by lease expiry.
create index tasks_lease_idx on public.tasks (lease_expires_at) where status = 'running';
create index tasks_run_status_idx on public.tasks (run_id, status);

create table public.task_dependencies (
  task_id uuid not null,
  depends_on_task_id uuid not null,
  run_id uuid not null,
  workspace_id uuid not null,
  mode text not null check (mode in ('hard', 'soft')),
  created_at timestamptz not null default now(),
  primary key (task_id, depends_on_task_id),
  -- Both ends belong to the same run (and so the same workspace).
  foreign key (task_id, run_id) references public.tasks (id, run_id) on delete cascade,
  foreign key (depends_on_task_id, run_id) references public.tasks (id, run_id) on delete cascade,
  foreign key (run_id, workspace_id) references public.runs (id, workspace_id) on delete cascade,
  check (task_id <> depends_on_task_id)
);
create index task_dependencies_depends_on_idx on public.task_dependencies (depends_on_task_id);
create index task_dependencies_run_idx on public.task_dependencies (run_id);

-- ---------------------------------------------------------------------------
-- Approvals: a human decision on a frozen, hashed snapshot
-- ---------------------------------------------------------------------------
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id uuid not null,
  task_id uuid,
  type text not null check (type in ('plan', 'outreach_draft', 'budget_extension')),
  target jsonb not null check (target ->> 'type' = type),
  -- Stable identity of what is being approved; at most one pending approval per target.
  target_key text not null check (char_length(target_key) between 1 and 200),
  snapshot jsonb not null check (snapshot ->> 'kind' = type),
  snapshot_hash text not null check (snapshot_hash ~ '^[a-f0-9]{64}$'),
  snapshot_schema_version integer not null check (snapshot_schema_version > 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'invalidated')),
  requested_at timestamptz not null default now(),
  decision text check (decision in ('approved', 'rejected')),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  decision_reason text check (char_length(decision_reason) <= 2000),
  snapshot_hash_seen text check (snapshot_hash_seen ~ '^[a-f0-9]{64}$'),
  invalidated_at timestamptz,
  invalidation_reason text check (
    invalidation_reason in ('target_changed', 'cited_claims_changed', 'run_cancelled', 'superseded')
  ),
  invalidation_detail text check (char_length(invalidation_detail) <= 500),
  replaced_by uuid references public.approvals (id),
  foreign key (run_id, workspace_id) references public.runs (id, workspace_id) on delete cascade,
  foreign key (task_id, workspace_id) references public.tasks (id, workspace_id) on delete cascade,
  check (status <> 'pending' or decision is null),
  check (
    status not in ('approved', 'rejected')
    or (decision = status and decided_by is not null and decided_at is not null and snapshot_hash_seen = snapshot_hash)
  ),
  check (decision is distinct from 'rejected' or char_length(btrim(decision_reason)) > 0),
  check ((status = 'invalidated') = (invalidated_at is not null and invalidation_reason is not null))
);
create unique index approvals_one_pending_per_target on public.approvals (run_id, target_key) where status = 'pending';
create index approvals_run_idx on public.approvals (run_id, status);
create index approvals_task_idx on public.approvals (task_id);

-- Snapshots are frozen; decisions are final; only pending -> decided/invalidated and approved -> invalidated.
create function private.guard_approval_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.snapshot is distinct from old.snapshot or new.snapshot_hash is distinct from old.snapshot_hash
     or new.type is distinct from old.type or new.target is distinct from old.target
     or new.target_key is distinct from old.target_key or new.run_id is distinct from old.run_id
     or new.task_id is distinct from old.task_id or new.requested_at is distinct from old.requested_at then
    raise exception 'approval % is immutable except for its decision and invalidation', old.id using errcode = '42501';
  end if;
  if old.decision is not null and (new.decision is distinct from old.decision
     or new.decided_by is distinct from old.decided_by or new.decided_at is distinct from old.decided_at
     or new.decision_reason is distinct from old.decision_reason or new.snapshot_hash_seen is distinct from old.snapshot_hash_seen) then
    raise exception 'approval % was already decided', old.id using errcode = '42501';
  end if;
  if old.status <> new.status and not (
       (old.status = 'pending' and new.status in ('approved', 'rejected', 'invalidated'))
       or (old.status = 'approved' and new.status = 'invalidated')) then
    raise exception 'approval % cannot move from % to %', old.id, old.status, new.status using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger approvals_guard before update on public.approvals
  for each row execute function private.guard_approval_update();

-- ---------------------------------------------------------------------------
-- Run events: the append-only timeline. seq comes from runs.last_event_seq, incremented in the
-- same transaction, so sequences are gap-free per run.
-- ---------------------------------------------------------------------------
create table public.run_events (
  run_id uuid not null,
  seq bigint not null check (seq > 0),
  workspace_id uuid not null,
  type text not null check (
    type in (
      'run.created', 'run.status_changed', 'plan.proposed', 'task.created', 'task.status_changed',
      'task.lease_expired', 'task.retry_scheduled', 'execution.started', 'execution.finished',
      'llm.call_completed', 'tool.call_completed', 'source.saved', 'claim.status_changed', 'gap.opened',
      'gap.resolved', 'approval.requested', 'approval.decided', 'approval.invalidated',
      'budget.threshold_crossed', 'artifact.created'
    )
  ),
  actor jsonb not null,
  refs jsonb not null default '{}',
  data jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  primary key (run_id, seq),
  foreign key (run_id, workspace_id) references public.runs (id, workspace_id) on delete cascade
);
create index run_events_workspace_time_idx on public.run_events (workspace_id, occurred_at desc);

-- Appends one event with the next sequence number. Runs with the caller's privileges and RLS, so
-- the backend can only append to runs in its workspace. Updating the run row also serialises
-- events of one run.
create function private.append_run_event(p_run_id uuid, p_type text, p_actor jsonb, p_refs jsonb, p_data jsonb)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_seq bigint;
  v_workspace uuid;
begin
  update public.runs set last_event_seq = last_event_seq + 1, updated_at = now()
   where id = p_run_id
  returning last_event_seq, workspace_id into v_seq, v_workspace;
  if v_seq is null then
    raise exception 'run % not found in scope', p_run_id using errcode = 'P0002';
  end if;
  insert into public.run_events (run_id, seq, workspace_id, type, actor, refs, data)
  values (p_run_id, v_seq, v_workspace, p_type, p_actor, coalesce(p_refs, '{}'), coalesce(p_data, '{}'));
  return v_seq;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit log: security-relevant actions (append-only)
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  actor jsonb not null,
  action text not null check (char_length(action) between 1 and 100),
  target_type text check (char_length(target_type) <= 50),
  target_id uuid,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_logs_workspace_time_idx on public.audit_logs (workspace_id, created_at desc);

-- Workspaces where the signed-in user is an owner or admin (audit log readers).
create function private.my_admin_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.workspace_id from public.workspace_members m
  where m.user_id = (select auth.uid()) and m.role in ('owner', 'admin');
$$;

-- ---------------------------------------------------------------------------
-- The queue: the only cross-workspace operations
-- ---------------------------------------------------------------------------
-- Leases one ready task whose run is active and under its parallelism limit, of a type this worker
-- can execute. Never waits on a locked row. Touches only the task row, so it cannot deadlock with
-- transitions (which always lock the run row first).
create function private.claim_next_task(
  p_worker_id text,
  p_lease_seconds integer,
  p_task_types text[],
  p_max_parallel_per_run integer
)
returns table (task_id uuid, workspace_id uuid, run_id uuid, task_type text, attempt integer, lease_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_lease_seconds is null or p_lease_seconds not between 2 and 3600 then
    raise exception 'lease_seconds must be between 2 and 3600' using errcode = '22023';
  end if;
  return query
  with candidate as (
    select t.id
    from public.tasks t
    join public.runs r on r.id = t.run_id
    where t.status = 'ready'
      and t.run_after <= now()
      and t.type = any (p_task_types)
      and r.status in ('planning', 'awaiting_plan_approval', 'running')
      and not r.cancel_requested
      and not r.pause_requested
      and not r.budget_blocked
      and (select count(*) from public.tasks x where x.run_id = t.run_id and x.status = 'running') < p_max_parallel_per_run
    order by t.priority desc, t.run_after, t.created_at
    limit 1
    for update of t skip locked
  )
  update public.tasks t
     set status = 'running',
         lease_owner = p_worker_id,
         lease_token = gen_random_uuid(),
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at = now(),
         attempt = t.attempt + 1,
         started_at = coalesce(t.started_at, now()),
         updated_at = now()
    from candidate c
   where t.id = c.id
  returning t.id, t.workspace_id, t.run_id, t.type, t.attempt, t.lease_token;
end;
$$;

-- Takes over up to p_max_rows running tasks whose lease expired (their worker died or stalled).
-- The new lease token fences the old worker out; the caller then records the failed attempt
-- through the normal, workspace-scoped transition.
create function private.reap_expired_leases(p_worker_id text, p_max_rows integer)
returns table (task_id uuid, workspace_id uuid, run_id uuid, lease_token uuid, previous_owner text, attempt integer)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with expired as (
    select t.id, t.lease_owner
    from public.tasks t
    where t.status = 'running' and t.lease_expires_at < now()
    order by t.lease_expires_at
    limit greatest(p_max_rows, 0)
    for update of t skip locked
  )
  update public.tasks t
     set lease_owner = left('reaper:' || p_worker_id, 100),
         lease_token = gen_random_uuid(),
         lease_expires_at = now() + interval '60 seconds',
         heartbeat_at = now(),
         updated_at = now()
    from expired e
   where t.id = e.id
  returning t.id, t.workspace_id, t.run_id, t.lease_token, e.lease_owner, t.attempt;
end;
$$;

revoke execute on function private.claim_next_task(text, integer, text[], integer) from public;
revoke execute on function private.reap_expired_leases(text, integer) from public;
revoke execute on function private.append_run_event(uuid, text, jsonb, jsonb, jsonb) from public;
revoke execute on function private.my_admin_workspace_ids() from public;
revoke execute on function private.guard_approval_update() from public;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.runs enable row level security;
alter table public.tasks enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.approvals enable row level security;
alter table public.run_events enable row level security;
alter table public.audit_logs enable row level security;

-- Signed-in users read their workspaces' rows; they change nothing directly (domain commands do).
create policy runs_member_read on public.runs
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy tasks_member_read on public.tasks
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy task_dependencies_member_read on public.task_dependencies
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy approvals_member_read on public.approvals
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy run_events_member_read on public.run_events
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy audit_logs_admin_read on public.audit_logs
  for select to authenticated using (workspace_id in (select private.my_admin_workspace_ids()));

-- The backend sees and changes only the workspace set on its transaction.
create policy runs_backend on public.runs for all to app_backend
  using (workspace_id = (select private.current_workspace()))
  with check (workspace_id = (select private.current_workspace()));
create policy tasks_backend on public.tasks for all to app_backend
  using (workspace_id = (select private.current_workspace()))
  with check (workspace_id = (select private.current_workspace()));
create policy task_dependencies_backend on public.task_dependencies for all to app_backend
  using (workspace_id = (select private.current_workspace()))
  with check (workspace_id = (select private.current_workspace()));
create policy approvals_backend on public.approvals for all to app_backend
  using (workspace_id = (select private.current_workspace()))
  with check (workspace_id = (select private.current_workspace()));
create policy run_events_backend on public.run_events for all to app_backend
  using (workspace_id = (select private.current_workspace()))
  with check (workspace_id = (select private.current_workspace()));
create policy audit_logs_backend on public.audit_logs for insert to app_backend
  with check (workspace_id = (select private.current_workspace()));

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on public.runs, public.tasks, public.task_dependencies, public.approvals, public.run_events,
  public.audit_logs from anon, authenticated;
grant select on public.runs, public.tasks, public.task_dependencies, public.approvals, public.run_events,
  public.audit_logs to authenticated;

grant select, insert, update on public.runs, public.tasks, public.approvals to app_backend;
grant select, insert, delete on public.task_dependencies to app_backend;
-- Append-only: no update or delete for anyone but the table owner.
grant select, insert on public.run_events to app_backend;
grant insert on public.audit_logs to app_backend;

grant execute on function private.claim_next_task(text, integer, text[], integer) to app_backend;
grant execute on function private.reap_expired_leases(text, integer) to app_backend;
grant execute on function private.append_run_event(uuid, text, jsonb, jsonb, jsonb) to app_backend;
grant execute on function private.my_admin_workspace_ids() to authenticated;

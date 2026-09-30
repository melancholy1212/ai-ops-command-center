-- Keeps the per-run parallelism limit exact without locking the run row. The previous version locked the run
-- row with SKIP LOCKED, so a claim skipped a run whenever any transition held that row (a task starting or
-- completing), and the worker idled for its poll interval: a throughput loss on busy runs.
--
-- Now claims of the same run serialise on a transaction-level advisory lock that transitions never take. For
-- each candidate (tasks locked with SKIP LOCKED, so a claimer never waits on a row), the claimer waits for its
-- run's claim lock, then re-counts the run's running tasks with a fresh snapshot and claims only if the limit
-- still allows it. No deadlock: the lock holder never waits on rows another claimer holds.
create or replace function private.claim_next_task(
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
declare
  v_candidate record;
begin
  if p_lease_seconds is null or p_lease_seconds not between 2 and 3600 then
    raise exception 'lease_seconds must be between 2 and 3600' using errcode = '22023';
  end if;
  for v_candidate in
    select t.id, t.run_id
    from public.tasks t
    join public.runs r on r.id = t.run_id
    where t.status = 'ready'
      and t.run_after <= now()
      and t.type = any (p_task_types)
      and r.status in ('planning', 'awaiting_plan_approval', 'running')
      and not r.cancel_requested
      and not r.pause_requested
      and not r.budget_blocked
      -- A cheap pre-filter; the exact check happens under the run's claim lock below.
      and (select count(*) from public.tasks x where x.run_id = t.run_id and x.status = 'running') < p_max_parallel_per_run
    order by t.priority desc, t.run_after, t.created_at
    limit 20
    for update of t skip locked
  loop
    perform pg_advisory_xact_lock(hashtextextended('aoc:claim:' || v_candidate.run_id::text, 0));
    if (select count(*) from public.tasks x where x.run_id = v_candidate.run_id and x.status = 'running')
       < p_max_parallel_per_run then
      return query
      update public.tasks t
         set status = 'running',
             lease_owner = p_worker_id,
             lease_token = gen_random_uuid(),
             lease_expires_at = now() + make_interval(secs => p_lease_seconds),
             heartbeat_at = now(),
             attempt = t.attempt + 1,
             started_at = coalesce(t.started_at, now()),
             updated_at = now()
       where t.id = v_candidate.id
      returning t.id, t.workspace_id, t.run_id, t.type, t.attempt, t.lease_token;
      return;
    end if;
  end loop;
  return;
end;
$$;

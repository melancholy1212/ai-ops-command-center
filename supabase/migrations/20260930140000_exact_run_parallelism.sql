-- Makes the per-run parallelism limit exact. Before, two workers claiming at the same moment could
-- both count three running tasks of a run and both claim, leaving five running. Locking the run row
-- together with the task (SKIP LOCKED) means a second claimer skips that run until the first commits,
-- so the running count it sees is always current. Transitions lock the run row too, so a claim also
-- skips a run for the few milliseconds one of its tasks is being completed.
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
    for update of t, r skip locked
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

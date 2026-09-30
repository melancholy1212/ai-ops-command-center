-- Workflow engine schema: isolation, append-only events, approval immutability, queue functions, constraints.
begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

-- Two tenants, each with a personal workspace and default project from the signup trigger.
insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'alice-wf@example.test'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'bob-wf@example.test');
select set_config('test.alice_ws', (select workspace_id::text from public.workspace_members where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'), true);
select set_config('test.bob_ws', (select workspace_id::text from public.workspace_members where user_id = 'bbbbbbbb-0000-0000-0000-000000000002'), true);

-- One running run per tenant, with fixed ids.
insert into public.runs (id, workspace_id, project_id, workflow, workflow_version, objective, brief, status, budget, created_by, started_at)
select 'a0000000-0000-0000-0000-00000000a001', current_setting('test.alice_ws')::uuid, p.id, 'prospect_research', 1,
       'Alice objective for the engine tests', '{}'::jsonb, 'running', '{}'::jsonb, 'aaaaaaaa-0000-0000-0000-000000000001', now()
from public.projects p where p.workspace_id = current_setting('test.alice_ws')::uuid;
insert into public.runs (id, workspace_id, project_id, workflow, workflow_version, objective, brief, status, budget, created_by, started_at)
select 'b0000000-0000-0000-0000-00000000b001', current_setting('test.bob_ws')::uuid, p.id, 'prospect_research', 1,
       'Bob objective for the engine tests', '{}'::jsonb, 'running', '{}'::jsonb, 'bbbbbbbb-0000-0000-0000-000000000002', now()
from public.projects p where p.workspace_id = current_setting('test.bob_ws')::uuid;

insert into public.tasks (id, run_id, workspace_id, type, kind, status, input, idempotency_key, max_attempts, priority) values
  ('a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000a001', current_setting('test.alice_ws')::uuid,
   'rank_and_analyze', 'structured_llm', 'ready', '{"type":"rank_and_analyze"}', 'rank', 2, 90),
  ('a1000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000a001', current_setting('test.alice_ws')::uuid,
   'compile_report', 'code', 'blocked', '{"type":"compile_report"}', 'report', 3, 50),
  ('b1000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000b001', current_setting('test.bob_ws')::uuid,
   'compile_report', 'code', 'ready', '{"type":"compile_report"}', 'report', 3, 10);
insert into public.task_dependencies (task_id, depends_on_task_id, run_id, workspace_id, mode) values
  ('a1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000a001',
   current_setting('test.alice_ws')::uuid, 'hard');

-- ---- integrity constraints ----
select throws_ok(
  $$ update public.tasks set status = 'running' where id = 'a1000000-0000-0000-0000-000000000002' $$,
  '23514', null, 'a running task must hold a lease'
);
select throws_ok(
  $$ insert into public.tasks (run_id, workspace_id, type, kind, input, idempotency_key, max_attempts)
     values ('a0000000-0000-0000-0000-00000000a001', current_setting('test.alice_ws')::uuid, 'compile_report', 'code',
             '{"type":"plan_run"}', 'mismatch', 1) $$,
  '23514', null, 'task input must be for its own type'
);
select throws_ok(
  $$ insert into public.task_dependencies (task_id, depends_on_task_id, run_id, workspace_id, mode)
     values ('a1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001',
             'a0000000-0000-0000-0000-00000000a001', current_setting('test.alice_ws')::uuid, 'hard') $$,
  '23503', null, 'a dependency cannot point into another run'
);
select throws_ok(
  $$ update public.runs set status = 'paused' where id = 'a0000000-0000-0000-0000-00000000a001' $$,
  '23514', null, 'a paused run needs a pause reason'
);

-- ---- signed-in user (alice) ----
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
select results_eq($$ select id from public.runs $$, $$ values ('a0000000-0000-0000-0000-00000000a001'::uuid) $$, 'alice sees only her run');
select is((select count(*)::int from public.tasks), 2, 'alice sees only her tasks');
select is((select count(*)::int from public.task_dependencies), 1, 'alice sees only her dependencies');
select throws_ok($$ insert into public.run_events (run_id, seq, workspace_id, type, actor)
                   values ('a0000000-0000-0000-0000-00000000a001', 99, current_setting('test.alice_ws')::uuid, 'run.created', '{}') $$,
                 '42501', null, 'users cannot write events');
select throws_ok($$ update public.tasks set priority = 1 $$, '42501', null, 'users cannot modify tasks');
select is_empty($$ select 1 from public.audit_logs $$, 'owners read audit logs, and there are none yet');

-- ---- anonymous ----
reset role;
set local role anon;
select throws_ok($$ select 1 from public.runs $$, '42501', null, 'anon cannot read runs');
select throws_ok($$ select 1 from public.run_events $$, '42501', null, 'anon cannot read events');

-- ---- backend scoped to alice ----
reset role;
select set_config('app.workspace_id', current_setting('test.alice_ws'), true);
set local role app_backend;
select results_eq($$ select id from public.runs $$, $$ values ('a0000000-0000-0000-0000-00000000a001'::uuid) $$, 'backend scoped to alice sees only her run');
select is(private.append_run_event('a0000000-0000-0000-0000-00000000a001', 'run.created', '{"kind":"system"}', '{}', '{"objective":"x"}'), 1::bigint, 'first event gets seq 1');
select is(private.append_run_event('a0000000-0000-0000-0000-00000000a001', 'run.status_changed', '{"kind":"system"}', '{}', '{}'), 2::bigint, 'second event gets seq 2');
select throws_ok($$ select private.append_run_event('b0000000-0000-0000-0000-00000000b001', 'run.created', '{"kind":"system"}', '{}', '{}') $$,
                 'P0002', null, 'backend cannot append to another workspace''s run');
select throws_ok($$ update public.run_events set data = '{}' $$, '42501', null, 'events cannot be edited');
select throws_ok($$ delete from public.run_events $$, '42501', null, 'events cannot be deleted');
select throws_ok($$ insert into public.tasks (run_id, workspace_id, type, kind, input, idempotency_key, max_attempts)
                   values ('b0000000-0000-0000-0000-00000000b001', current_setting('test.bob_ws')::uuid, 'plan_run',
                           'structured_llm', '{"type":"plan_run"}', 'intrusion', 1) $$,
                 '42501', null, 'backend cannot create tasks in another workspace');
select lives_ok($$ insert into public.audit_logs (workspace_id, actor, action) values (current_setting('test.alice_ws')::uuid, '{"kind":"system"}', 'test.action') $$,
                'backend can write audit logs in its workspace');
select throws_ok($$ select 1 from public.audit_logs $$, '42501', null, 'backend cannot read audit logs');

-- ---- approvals: frozen snapshot, final decision ----
insert into public.approvals (id, workspace_id, run_id, type, target, target_key, snapshot, snapshot_hash, snapshot_schema_version)
values ('a2000000-0000-0000-0000-000000000001', current_setting('test.alice_ws')::uuid, 'a0000000-0000-0000-0000-00000000a001',
        'budget_extension', '{"type":"budget_extension","runId":"a0000000-0000-0000-0000-00000000a001"}', 'budget:1',
        '{"kind":"budget_extension"}', repeat('a', 64), 1);
select throws_ok($$ update public.approvals set snapshot = '{"kind":"budget_extension","sneaky":true}' $$,
                 '42501', null, 'an approval snapshot cannot be changed');
select throws_ok($$ insert into public.approvals (workspace_id, run_id, type, target, target_key, snapshot, snapshot_hash, snapshot_schema_version)
                   values (current_setting('test.alice_ws')::uuid, 'a0000000-0000-0000-0000-00000000a001', 'budget_extension',
                           '{"type":"budget_extension"}', 'budget:1', '{"kind":"budget_extension"}', repeat('b', 64), 1) $$,
                 '23505', null, 'at most one pending approval per target');
select lives_ok($$ update public.approvals set status = 'approved', decision = 'approved', decided_by = 'aaaaaaaa-0000-0000-0000-000000000001',
                   decided_at = now(), snapshot_hash_seen = repeat('a', 64) $$, 'a pending approval can be approved');
select throws_ok($$ update public.approvals set status = 'rejected', decision = 'rejected', decision_reason = 'changed my mind' $$,
                 '42501', null, 'a decision is final');
select lives_ok($$ update public.approvals set status = 'invalidated', invalidated_at = now(), invalidation_reason = 'target_changed' $$,
                'an approved item can later be invalidated');

-- ---- the queue (functions are callable by the backend without a workspace scope) ----
reset role;
select set_config('app.workspace_id', '', true);
set local role app_backend;
select results_eq(
  $$ select task_id from private.claim_next_task('w1', 30, array['rank_and_analyze','compile_report'], 4) $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::uuid) $$,
  'claims the highest-priority ready task across workspaces'
);
select is_empty($$ select * from private.claim_next_task('w1', 30, array['plan_run'], 4) $$, 'only claims task types the worker can run');

reset role;
update public.runs set pause_requested = true where id = 'b0000000-0000-0000-0000-00000000b001';
set local role app_backend;
select is_empty($$ select * from private.claim_next_task('w1', 30, array['compile_report'], 4) $$, 'does not claim from a paused run');

reset role;
update public.runs set pause_requested = false where id = 'b0000000-0000-0000-0000-00000000b001';
update public.tasks set run_after = now() + interval '1 hour' where id = 'b1000000-0000-0000-0000-000000000001';
set local role app_backend;
select is_empty($$ select * from private.claim_next_task('w1', 30, array['compile_report'], 4) $$, 'does not claim a task scheduled for later');

reset role;
update public.tasks set run_after = now() where id = 'b1000000-0000-0000-0000-000000000001';
set local role app_backend;
select is_empty($$ select * from private.claim_next_task('w1', 30, array['compile_report'], 0) $$, 'respects the per-run parallelism limit');

-- ---- lease recovery ----
reset role;
update public.tasks set lease_expires_at = now() - interval '1 second' where id = 'a1000000-0000-0000-0000-000000000001';
set local role app_backend;
select results_eq(
  $$ select task_id, previous_owner from private.reap_expired_leases('w2', 10) $$,
  $$ values ('a1000000-0000-0000-0000-000000000001'::uuid, 'w1'::text) $$,
  'takes over an expired lease and reports the previous owner'
);

select * from finish();
rollback;

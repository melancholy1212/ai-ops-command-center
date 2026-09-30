-- Tenancy, roles and row-level security, checked from every role that touches these tables.
begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

-- Two users. The signup trigger gives each a personal workspace, owner membership and project.
insert into auth.users (id, aud, role, email)
values
  ('11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'alice@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'bob@example.test');

-- Remember the workspace ids while still privileged (transaction-local settings survive role changes).
select set_config('test.alice_ws', (select id::text from public.workspaces where slug = 'ws-11111111111111111111111111111111'), true);
select set_config('test.bob_ws', (select id::text from public.workspaces where slug = 'ws-22222222222222222222222222222222'), true);

-- ---- signup trigger ----
select isnt(current_setting('test.alice_ws', true), null, 'signup creates a personal workspace');
select results_eq(
  $$ select role from public.workspace_members where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values ('owner'::text) $$,
  'the new user is its only member, as owner'
);
select is(
  (select count(*)::int from public.projects where workspace_id = current_setting('test.alice_ws')::uuid),
  1,
  'signup creates a default project'
);

-- ---- roles ----
select ok(not (select rolbypassrls from pg_roles where rolname = 'app_backend'), 'app_backend does not bypass RLS');
select ok(pg_has_role('aoc_service', 'app_backend', 'SET'), 'aoc_service may SET ROLE app_backend');
select ok(not pg_has_role('aoc_service', 'app_backend', 'USAGE'), 'aoc_service does not inherit app_backend privileges');
select ok(not has_table_privilege('aoc_service', 'public.workspaces', 'SELECT'), 'aoc_service alone cannot read workspaces');

-- ---- signed-in user (alice) ----
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select results_eq(
  $$ select id from public.workspaces $$,
  $$ select current_setting('test.alice_ws')::uuid $$,
  'alice sees exactly her own workspace'
);
select is((select count(*)::int from public.projects), 1, 'alice sees only her own project');
select is_empty(
  $$ select 1 from public.workspace_members where user_id = '22222222-2222-2222-2222-222222222222' $$,
  'alice cannot see bob''s membership'
);
select throws_ok(
  $$ insert into public.workspaces (name, slug) values ('Sneaky', 'sneaky') $$,
  '42501', null, 'users cannot create workspaces directly'
);
select throws_ok(
  $$ update public.projects set name = 'Renamed' $$,
  '42501', null, 'users cannot modify projects directly'
);

-- ---- signed-in user with no memberships ----
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is_empty($$ select 1 from public.workspaces $$, 'a user with no membership sees no workspaces');

-- ---- anonymous ----
reset role;
set local role anon;
select throws_ok($$ select 1 from public.workspaces $$, '42501', null, 'anon cannot read workspaces at all');
select throws_ok($$ select 1 from public.projects $$, '42501', null, 'anon cannot read projects at all');

-- ---- backend without a workspace scope ----
reset role;
set local role app_backend;
select is_empty($$ select 1 from public.workspaces $$, 'backend without a workspace scope sees nothing');

-- ---- backend scoped to alice's workspace ----
reset role;
select set_config('app.workspace_id', current_setting('test.alice_ws'), true);
set local role app_backend;

select results_eq(
  $$ select id from public.workspaces $$,
  $$ select current_setting('test.alice_ws')::uuid $$,
  'backend scoped to alice sees only alice''s workspace'
);
select is((select count(*)::int from public.projects), 1, 'backend scoped to alice sees only alice''s project');
select lives_ok(
  $$ insert into public.projects (workspace_id, name) values (current_setting('test.alice_ws')::uuid, 'Second project') $$,
  'backend can write inside its workspace'
);
select throws_ok(
  $$ insert into public.projects (workspace_id, name) values (current_setting('test.bob_ws')::uuid, 'Intrusion') $$,
  '42501', null, 'backend cannot write into another workspace'
);
select is(
  (select count(*)::int from public.workspace_members where user_id = '22222222-2222-2222-2222-222222222222'),
  0,
  'backend scoped to alice cannot see bob''s membership'
);

select * from finish();
rollback;

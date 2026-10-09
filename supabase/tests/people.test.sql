-- People: subject invariants on claims, the role-company tie, isolation.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000e001', 'authenticated', 'authenticated', 'alice-pp@example.test'),
  ('bbbbbbbb-0000-0000-0000-00000000e002', 'authenticated', 'authenticated', 'bob-pp@example.test');
select set_config('test.a', (select workspace_id::text from public.workspace_members where user_id = 'aaaaaaaa-0000-0000-0000-00000000e001'), true);

insert into public.runs (id, workspace_id, project_id, workflow, workflow_version, objective, brief, status, budget, created_by, started_at)
select 'a0000000-0000-0000-0000-0000000ee001', current_setting('test.a')::uuid, p.id, 'prospect_research', 3,
       'Alice objective for the people tests', '{}'::jsonb, 'running', '{}'::jsonb, 'aaaaaaaa-0000-0000-0000-00000000e001', now()
from public.projects p where p.workspace_id = current_setting('test.a')::uuid;
insert into public.companies (id, workspace_id, name, normalized_name, primary_domain)
values ('c0000000-0000-0000-0000-00000000e001', current_setting('test.a')::uuid, 'Northwind Climate', 'northwind climate', 'northwind.example'),
       ('c0000000-0000-0000-0000-00000000e002', current_setting('test.a')::uuid, 'Fjordlight', 'fjordlight', null);
insert into public.people (id, workspace_id, full_name, normalized_name)
values ('d0000000-0000-0000-0000-00000000e001', current_setting('test.a')::uuid, 'Anna Svensson', 'anna svensson');

-- A claim row with the given subject columns, attribute and value.
create function pg_temp.claim(person uuid, attribute text, value jsonb, fingerprint text) returns void language sql as $$
  insert into public.claims (workspace_id, run_id, subject_company_id, subject_person_id, attribute, value, raw_value,
                             statement, fingerprint, proposed_by_agent, proposed_by_execution_id, newest_retrieved_at)
  values (current_setting('test.a')::uuid, 'a0000000-0000-0000-0000-0000000ee001', 'c0000000-0000-0000-0000-00000000e001',
          person, attribute, value, 'as stated', 'A statement of the claim.', fingerprint, 'people_discovery',
          gen_random_uuid(), now())
$$;

select lives_ok(
  $$ select pg_temp.claim('d0000000-0000-0000-0000-00000000e001', 'person.current_role',
       '{"companyId":"c0000000-0000-0000-0000-00000000e001","title":"Chief Executive Officer","role":"ceo","since":null}', repeat('1', 64)) $$,
  'a role claim names its person and the company it is anchored to');
select throws_ok(
  $$ select pg_temp.claim(null, 'person.current_role',
       '{"companyId":"c0000000-0000-0000-0000-00000000e001","title":"CEO","role":"ceo","since":null}', repeat('2', 64)) $$,
  '23514', null, 'a person claim without a person is refused');
select throws_ok(
  $$ select pg_temp.claim('d0000000-0000-0000-0000-00000000e001', 'company.hq_country', '{"country":"SE"}', repeat('3', 64)) $$,
  '23514', null, 'a company claim cannot name a person');
select throws_ok(
  $$ select pg_temp.claim('d0000000-0000-0000-0000-00000000e001', 'person.current_role',
       '{"companyId":"c0000000-0000-0000-0000-00000000e002","title":"CEO","role":"ceo","since":null}', repeat('4', 64)) $$,
  '23514', null, 'a role at another company than the anchor is refused');
select lives_ok(
  $$ select pg_temp.claim(null, 'company.hq_country', '{"country":"SE"}', repeat('5', 64)) $$,
  'company claims are unchanged');
select throws_ok(
  $$ select pg_temp.claim('d0000000-0000-0000-0000-0000000eeeee', 'person.public_profile',
       '{"url":"https://example.org/a","kind":"other"}', repeat('6', 64)) $$,
  '23503', null, 'a claim cannot name a person that does not exist');

insert into public.tasks (id, run_id, workspace_id, type, kind, status, input, idempotency_key, max_attempts)
values ('a1000000-0000-0000-0000-00000000e001', 'a0000000-0000-0000-0000-0000000ee001', current_setting('test.a')::uuid,
        'discover_companies', 'agent_loop', 'blocked', '{"type":"discover_companies"}', 'discover', 2);
select lives_ok(
  $$ insert into public.research_gaps (workspace_id, run_id, company_id, attribute, status, reason, resolved_at)
     values (current_setting('test.a')::uuid, 'a0000000-0000-0000-0000-0000000ee001', 'c0000000-0000-0000-0000-00000000e001',
             'person.current_role', 'unavailable', 'no_claim', now()) $$,
  'a company with no decision maker records a company-level gap');
select throws_ok(
  $$ insert into public.research_gaps (workspace_id, run_id, company_id, attribute, status, reason, resolved_at)
     values (current_setting('test.a')::uuid, 'a0000000-0000-0000-0000-0000000ee001', 'c0000000-0000-0000-0000-00000000e001',
             'person.public_profile', 'unavailable', 'no_claim', now()) $$,
  '23514', null, 'other person attributes are not company gaps');

-- ---- backend role ----
set local role app_backend;
select set_config('app.workspace_id', current_setting('test.a'), true);
select is((select count(*)::int from public.people), 1, 'the backend scoped to alice sees her person');
select set_config('app.workspace_id', (select workspace_id::text from public.workspace_members where user_id = 'bbbbbbbb-0000-0000-0000-00000000e002'), true);
select is((select count(*)::int from public.people), 0, 'the backend scoped to bob sees no alice people');
reset role;

-- ---- signed-in users ----
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-00000000e002","role":"authenticated"}', true);
select is((select count(*)::int from public.people), 0, 'bob cannot read alice''s people');
select throws_ok($$ insert into public.people (workspace_id, full_name, normalized_name) values (gen_random_uuid(), 'Some One', 'some one') $$,
  '42501', null, 'users cannot write people directly');
reset role;

select * from finish();
rollback;

-- Knowledge and evidence: invariants, immutability, the "no AI-generated facts" rule, isolation.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000f001', 'authenticated', 'authenticated', 'alice-kn@example.test'),
  ('bbbbbbbb-0000-0000-0000-00000000f002', 'authenticated', 'authenticated', 'bob-kn@example.test');
select set_config('test.a', (select workspace_id::text from public.workspace_members where user_id = 'aaaaaaaa-0000-0000-0000-00000000f001'), true);
select set_config('test.b', (select workspace_id::text from public.workspace_members where user_id = 'bbbbbbbb-0000-0000-0000-00000000f002'), true);

insert into public.runs (id, workspace_id, project_id, workflow, workflow_version, objective, brief, status, budget, created_by, started_at)
select 'a0000000-0000-0000-0000-0000000ff001', current_setting('test.a')::uuid, p.id, 'prospect_research', 1,
       'Alice objective for the knowledge tests', '{}'::jsonb, 'running', '{}'::jsonb, 'aaaaaaaa-0000-0000-0000-00000000f001', now()
from public.projects p where p.workspace_id = current_setting('test.a')::uuid;
insert into public.tasks (id, run_id, workspace_id, type, kind, status, input, idempotency_key, max_attempts, attempt, lease_owner, lease_token, lease_expires_at)
values ('a1000000-0000-0000-0000-00000000f001', 'a0000000-0000-0000-0000-0000000ff001', current_setting('test.a')::uuid,
        'discover_companies', 'agent_loop', 'running', '{"type":"discover_companies"}', 'discover', 2, 1, 'w', gen_random_uuid(), now() + interval '1 minute');
insert into public.agent_executions (id, workspace_id, run_id, task_id, agent, agent_version, prompt_hash, attempt, lease_token, input, limits)
values ('e0000000-0000-0000-0000-00000000f001', current_setting('test.a')::uuid, 'a0000000-0000-0000-0000-0000000ff001',
        'a1000000-0000-0000-0000-00000000f001', 'research', 'r@1', repeat('a', 64), 1, gen_random_uuid(), '{}', '{}');
insert into public.sources (id, workspace_id, requested_url, final_url, final_url_hash, host, registrable_domain, source_type, tier, origin,
                            retrieved_at, http, published_at_method, raw_sha256, content_sha256, text, text_length, truncated,
                            extraction_method, extractor_version, fetched_by_tool_call_id)
values ('50000000-0000-0000-0000-00000000f001', current_setting('test.a')::uuid, 'https://news.example/a', 'https://news.example/a',
        repeat('d', 64), 'news.example', 'news.example', 'news_article', 'B', '{}', now(), '{"status":200}', 'none', repeat('e', 64),
        repeat('f', 64), 'Northwind Climate raised a EUR 4 million seed round.', 52, false, 'readability_html', 'x@1', gen_random_uuid());
insert into public.companies (id, workspace_id, name, normalized_name, primary_domain, country)
values ('c0000000-0000-0000-0000-00000000f001', current_setting('test.a')::uuid, 'Northwind Climate', 'northwind climate', 'northwind.example', 'SE');
insert into public.claims (id, workspace_id, run_id, subject_company_id, attribute, value, raw_value, statement, fingerprint,
                           status, proposed_by_agent, proposed_by_execution_id, newest_retrieved_at)
values ('ca000000-0000-0000-0000-00000000f001', current_setting('test.a')::uuid, 'a0000000-0000-0000-0000-0000000ff001',
        'c0000000-0000-0000-0000-00000000f001', 'company.hq_country', '{"country":"SE"}', 'Stockholm',
        'Northwind Climate is headquartered in Sweden.', repeat('1', 64), 'grounded', 'research',
        'e0000000-0000-0000-0000-00000000f001', now());
insert into public.evidence (id, workspace_id, claim_id, source_id, quote, quote_sha256, grounding, spans, source_retrieved_at, extracted_by_execution_id)
values ('ee000000-0000-0000-0000-00000000f001', current_setting('test.a')::uuid, 'ca000000-0000-0000-0000-00000000f001',
        '50000000-0000-0000-0000-00000000f001', 'Northwind Climate raised a EUR 4 million seed round', repeat('2', 64), 'exact',
        '[{"start":0,"end":51}]', now(), 'e0000000-0000-0000-0000-00000000f001');

-- ---- claims ----
select throws_ok(
  $$ update public.claims set status = 'verified' where id = 'ca000000-0000-0000-0000-00000000f001' $$,
  '23514', null, 'a verified claim needs a confidence'
);
select lives_ok(
  $$ update public.claims set status = 'verified', confidence = 'high', confidence_score = 0.85 where id = 'ca000000-0000-0000-0000-00000000f001' $$,
  'a verified claim with a confidence is accepted'
);
select throws_ok(
  $$ update public.claims set conflict_state = 'conflicting' where id = 'ca000000-0000-0000-0000-00000000f001' $$,
  '23514', null, 'a conflicting claim must be contested'
);
select throws_ok(
  $$ insert into public.claims (workspace_id, run_id, subject_company_id, attribute, value, raw_value, statement, fingerprint,
       proposed_by_agent, proposed_by_execution_id, newest_retrieved_at)
     values (current_setting('test.a')::uuid, 'a0000000-0000-0000-0000-0000000ff001', 'c0000000-0000-0000-0000-00000000f001',
       'person.current_role', '{}', 'CEO', 'Someone is the CEO.', repeat('3', 64), 'research', 'e0000000-0000-0000-0000-00000000f001', now()) $$,
  '23514', null, 'a company subject cannot carry a person attribute'
);
select throws_ok(
  $$ insert into public.claims (workspace_id, run_id, subject_company_id, attribute, value, raw_value, statement, fingerprint,
       proposed_by_agent, proposed_by_execution_id, newest_retrieved_at)
     values (current_setting('test.a')::uuid, 'a0000000-0000-0000-0000-0000000ff001', 'c0000000-0000-0000-0000-00000000f001',
       'company.hq_country', '{"country":"SE"}', 'Sweden', 'Northwind Climate is headquartered in Sweden.', repeat('1', 64),
       'research', 'e0000000-0000-0000-0000-00000000f001', now()) $$,
  '23505', null, 'the same claim (fingerprint) is written once per run'
);

-- ---- companies ----
select throws_ok(
  $$ insert into public.companies (workspace_id, name, normalized_name, primary_domain) values
     (current_setting('test.a')::uuid, 'Northwind', 'northwind', 'northwind.example') $$,
  '23505', null, 'one company per registrable domain in a workspace'
);
select lives_ok(
  $$ insert into public.companies (workspace_id, name, normalized_name, primary_domain) values
     (current_setting('test.b')::uuid, 'Northwind', 'northwind', 'northwind.example') $$,
  'another workspace keeps its own company for the same domain'
);

-- ---- evidence ----
select throws_ok(
  $$ insert into public.evidence (workspace_id, claim_id, source_id, quote, quote_sha256, grounding, spans, source_retrieved_at, extracted_by_execution_id)
     values (current_setting('test.a')::uuid, 'ca000000-0000-0000-0000-00000000f001', '50000000-0000-0000-0000-00000000f001',
       'A quote that is nowhere in the page', repeat('4', 64), 'not_found', '[{"start":0,"end":5}]', now(), 'e0000000-0000-0000-0000-00000000f001') $$,
  '23514', null, 'an ungrounded quote has no spans'
);
select throws_ok(
  $$ insert into public.evidence (workspace_id, claim_id, source_id, quote, quote_sha256, grounding, spans, judge_verdict, judge_reason,
       source_retrieved_at, extracted_by_execution_id)
     values (current_setting('test.a')::uuid, 'ca000000-0000-0000-0000-00000000f001', '50000000-0000-0000-0000-00000000f001',
       'A quote that is nowhere in the page', repeat('5', 64), 'not_found', '[]', 'supports', 'looks fine', now(),
       'e0000000-0000-0000-0000-00000000f001') $$,
  '23514', null, 'an ungrounded quote never reaches the judge'
);
select throws_ok(
  $$ update public.evidence set judge_verdict = 'supports' where id = 'ee000000-0000-0000-0000-00000000f001' $$,
  '23514', null, 'a judge verdict comes with its reason'
);

-- ---- findings ----
select throws_ok(
  $$ insert into public.findings (workspace_id, run_id, subject_kind, subject_company_id, kind, label, statement, author_kind, author_execution_id)
     values (current_setting('test.a')::uuid, 'a0000000-0000-0000-0000-0000000ff001', 'company', 'c0000000-0000-0000-0000-00000000f001',
       'analysis', 'fact_derived', 'The model says this is a fact.', 'model', 'e0000000-0000-0000-0000-00000000f001') $$,
  '23514', null, 'a model cannot author a fact_derived finding'
);
select throws_ok(
  $$ insert into public.findings (workspace_id, run_id, subject_kind, subject_company_id, kind, label, statement, score, author_kind, author_execution_id)
     values (current_setting('test.a')::uuid, 'a0000000-0000-0000-0000-0000000ff001', 'company', 'c0000000-0000-0000-0000-00000000f001',
       'score', 'analysis', 'Score 0.8', '{"total":0.8}', 'model', 'e0000000-0000-0000-0000-00000000f001') $$,
  '23514', null, 'scores are computed by code'
);
select lives_ok(
  $$ insert into public.findings (id, workspace_id, run_id, subject_kind, subject_company_id, kind, label, statement, score, author_kind, author_module, author_version)
     values ('f0000000-0000-0000-0000-00000000f001', current_setting('test.a')::uuid, 'a0000000-0000-0000-0000-0000000ff001', 'company',
       'c0000000-0000-0000-0000-00000000f001', 'score', 'fact_derived', 'Score 0.80 of 1.', '{"total":0.8}', 'code', 'score', 'score@1') $$,
  'code writes score findings'
);

-- ---- artifacts ----
insert into public.artifacts (id, workspace_id, run_id, kind, version, status, content, content_hash, author_kind, author_module, author_version)
values ('af000000-0000-0000-0000-00000000f001', current_setting('test.a')::uuid, 'a0000000-0000-0000-0000-0000000ff001',
        'prospect_report', 1, 'final', '{"kind":"prospect_report"}', repeat('6', 64), 'code', 'report', 'report@1');
select throws_ok(
  $$ insert into public.artifacts (workspace_id, run_id, kind, version, status, content, content_hash, author_kind, author_module, author_version)
     values (current_setting('test.a')::uuid, 'a0000000-0000-0000-0000-0000000ff001', 'prospect_report', 2, 'final',
       '{"kind":"prospect_report"}', repeat('7', 64), 'code', 'report', 'report@1') $$,
  '23514', null, 'a later version names the version it replaces'
);
select throws_ok(
  $$ insert into public.artifact_references (artifact_id, workspace_id, claim_id, finding_id)
     values ('af000000-0000-0000-0000-00000000f001', current_setting('test.a')::uuid,
       'ca000000-0000-0000-0000-00000000f001', 'f0000000-0000-0000-0000-00000000f001') $$,
  '23514', null, 'a reference points at exactly one claim or finding'
);

-- ---- the backend role: immutability through column privileges ----
set local role app_backend;
select set_config('app.workspace_id', current_setting('test.a'), true);
select throws_ok($$ update public.evidence set quote = 'Something else entirely, rewritten' $$, '42501', null, 'evidence quotes are immutable');
select throws_ok($$ update public.evidence set grounding = 'exact', spans = '[]' $$, '42501', null, 'grounding results are immutable');
select lives_ok(
  $$ update public.evidence set judge_verdict = 'supports', judge_reason = 'The quote states the country.' where id = 'ee000000-0000-0000-0000-00000000f001' $$,
  'the judge verdict can be added'
);
select throws_ok($$ update public.artifacts set content = '{"kind":"prospect_report","edited":true}' $$, '42501', null, 'artifact content is immutable');
select lives_ok($$ update public.artifacts set status = 'superseded' $$, 'an artifact''s status can change');
select throws_ok($$ delete from public.claims $$, '42501', null, 'claims cannot be deleted by services');
select set_config('app.workspace_id', current_setting('test.b'), true);
select is((select count(*)::int from public.claims) + (select count(*)::int from public.evidence), 0, 'the backend scoped to bob sees no alice claims or evidence');
reset role;

-- ---- signed-in users ----
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-00000000f002","role":"authenticated"}', true);
select is((select count(*)::int from public.companies), 1, 'bob sees only his own company');
select throws_ok($$ update public.claims set status = 'rejected' $$, '42501', null, 'users cannot change claims directly');
reset role;

select * from finish();
rollback;

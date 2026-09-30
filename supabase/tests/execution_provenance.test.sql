-- Executions, telemetry and provenance: isolation, append-only rules, constraints, rate limits.
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000e001', 'authenticated', 'authenticated', 'alice-ex@example.test'),
  ('bbbbbbbb-0000-0000-0000-00000000e002', 'authenticated', 'authenticated', 'bob-ex@example.test');
select set_config('test.alice_ws', (select workspace_id::text from public.workspace_members where user_id = 'aaaaaaaa-0000-0000-0000-00000000e001'), true);
select set_config('test.bob_ws', (select workspace_id::text from public.workspace_members where user_id = 'bbbbbbbb-0000-0000-0000-00000000e002'), true);

insert into public.runs (id, workspace_id, project_id, workflow, workflow_version, objective, brief, status, budget, created_by, started_at)
select 'a0000000-0000-0000-0000-0000000ee001', current_setting('test.alice_ws')::uuid, p.id, 'prospect_research', 1,
       'Alice objective for the telemetry tests', '{}'::jsonb, 'running', '{}'::jsonb, 'aaaaaaaa-0000-0000-0000-00000000e001', now()
from public.projects p where p.workspace_id = current_setting('test.alice_ws')::uuid;
insert into public.runs (id, workspace_id, project_id, workflow, workflow_version, objective, brief, status, budget, created_by, started_at)
select 'b0000000-0000-0000-0000-0000000ee002', current_setting('test.bob_ws')::uuid, p.id, 'prospect_research', 1,
       'Bob objective for the telemetry tests', '{}'::jsonb, 'running', '{}'::jsonb, 'bbbbbbbb-0000-0000-0000-00000000e002', now()
from public.projects p where p.workspace_id = current_setting('test.bob_ws')::uuid;
insert into public.tasks (id, run_id, workspace_id, type, kind, status, input, idempotency_key, max_attempts,
                          attempt, lease_owner, lease_token, lease_expires_at) values
  ('a1000000-0000-0000-0000-00000000e001', 'a0000000-0000-0000-0000-0000000ee001', current_setting('test.alice_ws')::uuid,
   'discover_companies', 'agent_loop', 'running', '{"type":"discover_companies"}', 'discover', 2,
   1, 'w1', 'c0000000-0000-0000-0000-00000000e001', now() + interval '1 minute'),
  ('b1000000-0000-0000-0000-00000000e002', 'b0000000-0000-0000-0000-0000000ee002', current_setting('test.bob_ws')::uuid,
   'discover_companies', 'agent_loop', 'ready', '{"type":"discover_companies"}', 'discover', 2, 0, null, null, null);

insert into public.agent_executions (id, workspace_id, run_id, task_id, agent, agent_version, prompt_hash, attempt,
                                     lease_token, input, limits) values
  ('e0000000-0000-0000-0000-00000000e001', current_setting('test.alice_ws')::uuid, 'a0000000-0000-0000-0000-0000000ee001',
   'a1000000-0000-0000-0000-00000000e001', 'research', 'research@1', repeat('a', 64), 1,
   'c0000000-0000-0000-0000-00000000e001', '{}', '{}');
insert into public.tool_calls (id, workspace_id, run_id, task_id, execution_id, tool, arguments_hash, arguments,
                               status, latency_ms, started_at) values
  ('70000000-0000-0000-0000-00000000e001', current_setting('test.alice_ws')::uuid, 'a0000000-0000-0000-0000-0000000ee001',
   'a1000000-0000-0000-0000-00000000e001', 'e0000000-0000-0000-0000-00000000e001', 'web_search', repeat('b', 64),
   '{"query":"climate software seed"}', 'ok', 120, now());
insert into public.discovered_urls (id, workspace_id, run_id, url, normalized_url, normalized_url_hash, origin_kind, origin) values
  ('d0000000-0000-0000-0000-00000000e001', current_setting('test.alice_ws')::uuid, 'a0000000-0000-0000-0000-0000000ee001',
   'https://news.example/a?utm_source=x', 'https://news.example/a', repeat('c', 64), 'search_result',
   '{"kind":"search_result","toolCallId":"70000000-0000-0000-0000-00000000e001","provider":"tavily","query":"q","rank":0}');
insert into public.sources (id, workspace_id, requested_url, final_url, final_url_hash, host, registrable_domain,
                            source_type, tier, origin, discovered_url_id, retrieved_at, http, published_at_method,
                            raw_sha256, content_sha256, text, text_length, truncated, extraction_method,
                            extractor_version, fetched_by_tool_call_id) values
  ('50000000-0000-0000-0000-00000000e001', current_setting('test.alice_ws')::uuid, 'https://news.example/a',
   'https://news.example/a', repeat('d', 64), 'news.example', 'news.example', 'news_article', 'B',
   '{"kind":"search_result"}', 'd0000000-0000-0000-0000-00000000e001', now(),
   '{"status":200}', 'none', repeat('e', 64), repeat('f', 64), 'Saved page text', 15, false, 'readability_html',
   'extract@1', '70000000-0000-0000-0000-00000000e001');

-- ---- constraints ----
select throws_ok(
  $$ update public.agent_executions set status = 'succeeded', ended_at = now() where id = 'e0000000-0000-0000-0000-00000000e001' $$,
  '23514', null, 'a succeeded execution needs an output'
);
select throws_ok(
  $$ update public.agent_executions set status = 'failed', ended_at = now() where id = 'e0000000-0000-0000-0000-00000000e001' $$,
  '23514', null, 'a failed execution needs a failure'
);
select throws_ok(
  $$ insert into public.agent_executions (workspace_id, run_id, task_id, agent, agent_version, prompt_hash, attempt, lease_token, input, limits)
     values (current_setting('test.alice_ws')::uuid, 'a0000000-0000-0000-0000-0000000ee001', 'a1000000-0000-0000-0000-00000000e001',
             'research', 'research@1', repeat('a', 64), 1, 'c0000000-0000-0000-0000-00000000e001', '{}', '{}') $$,
  '23505', null, 'one execution per task lease'
);
select throws_ok(
  $$ insert into public.agent_executions (workspace_id, run_id, task_id, agent, agent_version, prompt_hash, attempt, lease_token, input, limits)
     values (current_setting('test.alice_ws')::uuid, 'a0000000-0000-0000-0000-0000000ee001', 'b1000000-0000-0000-0000-00000000e002',
             'research', 'research@1', repeat('a', 64), 1, gen_random_uuid(), '{}', '{}') $$,
  '23503', null, 'an execution cannot point at another run''s task'
);
select throws_ok(
  $$ insert into public.tool_calls (id, workspace_id, run_id, task_id, execution_id, tool, arguments_hash, arguments, status, latency_ms, started_at)
     values (gen_random_uuid(), current_setting('test.alice_ws')::uuid, 'a0000000-0000-0000-0000-0000000ee001',
             'a1000000-0000-0000-0000-00000000e001', 'e0000000-0000-0000-0000-00000000e001', 'fetch_page', repeat('b', 64),
             '{}', 'error', 5, now()) $$,
  '23514', null, 'a failed tool call needs an error code'
);
select throws_ok(
  $$ insert into public.llm_calls (id, workspace_id, run_id, task_id, execution_id, seq, provider, provider_account, model, route,
       routing_config_version, prompt_version, request_hash, input_tokens, output_tokens, cache_status, cost_usd_micros,
       latency_ms, retry_count, stop_reason, started_at)
     values (gen_random_uuid(), current_setting('test.alice_ws')::uuid, 'a0000000-0000-0000-0000-0000000ee001',
             'a1000000-0000-0000-0000-00000000e001', 'e0000000-0000-0000-0000-00000000e001', 0, 'openai_compatible',
             'earthruntime', 'gpt-oss-120b', 'agent_loop', 'routes@1', 'research@1', repeat('9', 64), 10, 5,
             'not_supported', 1, 100, 0, 'error', now()) $$,
  '23514', null, 'an errored model call needs a failure'
);
select throws_ok(
  $$ insert into public.discovered_urls (workspace_id, run_id, url, normalized_url, normalized_url_hash, origin_kind, origin)
     values (current_setting('test.alice_ws')::uuid, 'a0000000-0000-0000-0000-0000000ee001', 'https://news.example/a',
             'https://news.example/a', repeat('c', 64), 'page_link', '{"kind":"page_link"}') $$,
  '23505', null, 'a URL is discovered once per run (the first origin wins)'
);
select throws_ok(
  $$ insert into public.discovered_urls (workspace_id, run_id, url, normalized_url, normalized_url_hash, origin_kind, origin)
     values (current_setting('test.alice_ws')::uuid, 'a0000000-0000-0000-0000-0000000ee001', 'https://x.example/',
             'https://x.example/', repeat('1', 64), 'page_link', '{"kind":"search_result"}') $$,
  '23514', null, 'the origin document matches its kind'
);
select throws_ok(
  $$ insert into public.sources (workspace_id, requested_url, final_url, final_url_hash, host, registrable_domain, source_type,
       tier, origin, retrieved_at, http, published_at_method, raw_sha256, content_sha256, text, text_length, truncated,
       extraction_method, extractor_version, fetched_by_tool_call_id)
     values (current_setting('test.alice_ws')::uuid, 'https://news.example/a', 'https://news.example/a', repeat('d', 64),
             'news.example', 'news.example', 'news_article', 'B', '{}', now(), '{"status":200}', 'none', repeat('e', 64),
             repeat('f', 64), 'Saved page text', 15, false, 'readability_html', 'extract@1', gen_random_uuid()) $$,
  '23505', null, 'identical content at the same final URL is saved once per workspace'
);
select throws_ok(
  $$ insert into public.sources (workspace_id, requested_url, final_url, final_url_hash, host, registrable_domain, source_type,
       tier, origin, retrieved_at, http, published_at_method, raw_sha256, content_sha256, text, text_length, truncated,
       extraction_method, extractor_version, fetched_by_tool_call_id)
     values (current_setting('test.alice_ws')::uuid, 'https://r.example/1', 'https://r.example/1', repeat('2', 64),
             'r.example', 'r.example', 'registry_record', 'A', '{}', now(), '{"status":200}', 'provider_field',
             repeat('e', 64), repeat('3', 64), 'Record', 6, false, 'provider_api', 'provider@1', gen_random_uuid()) $$,
  '23514', null, 'provider records carry no HTTP metadata'
);
select throws_ok(
  $$ insert into public.sources (workspace_id, requested_url, final_url, final_url_hash, host, registrable_domain, source_type,
       tier, origin, retrieved_at, http, published_at_method, raw_sha256, content_sha256, text, text_length, truncated,
       extraction_method, extractor_version, fetched_by_tool_call_id)
     values (current_setting('test.alice_ws')::uuid, 'https://news.example/b', 'https://news.example/b', repeat('4', 64),
             'news.example', 'news.example', 'news_article', 'B', '{}', now(), '{"status":200}', 'none', repeat('e', 64),
             repeat('5', 64), 'Wrong length', 3, false, 'readability_html', 'extract@1', gen_random_uuid()) $$,
  '23514', null, 'text_length matches the stored text'
);

-- ---- signed-in users ----
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000e001","role":"authenticated"}', true);
select is((select count(*)::int from public.agent_executions), 1, 'alice sees her execution');
select is((select count(*)::int from public.sources), 1, 'alice sees her workspace''s sources');
select throws_ok($$ update public.sources set text = 'x' $$, '42501', null, 'users cannot modify sources');
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-00000000e002","role":"authenticated"}', true);
select is((select count(*)::int from public.tool_calls) + (select count(*)::int from public.sources)
          + (select count(*)::int from public.discovered_urls), 0, 'bob sees none of alice''s telemetry or provenance');
reset role;

-- ---- backend role ----
set local role app_backend;
select set_config('app.workspace_id', current_setting('test.bob_ws'), true);
select is((select count(*)::int from public.agent_executions), 0, 'the backend scoped to bob sees no alice executions');
select throws_ok(
  $$ insert into public.tool_calls (id, workspace_id, run_id, task_id, execution_id, tool, arguments_hash, arguments, status, latency_ms, started_at)
     values (gen_random_uuid(), current_setting('test.alice_ws')::uuid, 'a0000000-0000-0000-0000-0000000ee001',
             'a1000000-0000-0000-0000-00000000e001', 'e0000000-0000-0000-0000-00000000e001', 'web_search', repeat('b', 64),
             '{}', 'ok', 5, now()) $$,
  '42501', null, 'the backend cannot write telemetry into another workspace'
);
select set_config('app.workspace_id', current_setting('test.alice_ws'), true);
select throws_ok($$ update public.sources set tier = 'A' $$, '42501', null, 'sources are immutable for services');
select throws_ok($$ update public.tool_calls set status = 'ok' $$, '42501', null, 'tool calls are append-only');
select throws_ok($$ delete from public.llm_calls $$, '42501', null, 'model calls cannot be deleted');
select lives_ok(
  $$ update public.agent_executions set status = 'succeeded', output = '{"candidates":[]}', ended_at = now(), turns = 3
     where id = 'e0000000-0000-0000-0000-00000000e001' $$,
  'the backend closes its own execution'
);
select throws_ok($$ select * from private.rate_limit_counters $$, '42501', null, 'rate-limit counters are not readable');

-- ---- rate limits ----
select is(
  (select array_agg(private.take_rate_limit('test:host', 2, 60) > 0) from generate_series(1, 4)),
  array[false, false, true, true],
  'two calls pass in the window, the rest are told to wait'
);
select ok(private.take_rate_limit('test:host', 2, 60) <= 60000, 'retry-after is within the window');
select is(private.take_rate_limit('test:other', 1, 60), 0, 'counters are per key');
reset role;

select * from finish();
rollback;

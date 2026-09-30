-- Phase 3: agent executions and their telemetry, and the first two links of the provenance chain.
--   * agent_executions / agent_messages / llm_calls / tool_calls: every model and tool call, as it happens
--     (docs/observability.md). Append-only except for an execution's own status and usage.
--   * discovered_urls: why a URL may be fetched in a run (docs/provenance.md#url-origins).
--   * sources: what was fetched, immutable, deduplicated per workspace by final URL and content hash.
--   * private.take_rate_limit(): fixed-window counters shared by every MCP server instance.
-- External MCP sessions and API keys come later; until then every tool call belongs to an execution.

-- ---------------------------------------------------------------------------
-- Executions
-- ---------------------------------------------------------------------------
create table public.agent_executions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id uuid not null,
  task_id uuid not null,
  agent text not null check (
    agent in ('planner', 'research', 'company_intelligence', 'people_discovery', 'verifier', 'analyst', 'outreach_writer')
  ),
  agent_version text not null check (char_length(agent_version) between 1 and 40),
  prompt_hash text not null check (prompt_hash ~ '^[a-f0-9]{64}$'),
  attempt integer not null check (attempt > 0),
  -- The lease the execution ran under. A task handed back at shutdown keeps its attempt number, so the
  -- attempt alone does not identify an execution; the lease does.
  lease_token uuid not null,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'abandoned')),
  input jsonb not null,
  output jsonb,
  limits jsonb not null,
  turns integer not null default 0 check (turns >= 0),
  llm_calls integer not null default 0 check (llm_calls >= 0),
  tool_calls integer not null default 0 check (tool_calls >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cost_usd_micros bigint not null default 0 check (cost_usd_micros >= 0),
  failure jsonb,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (task_id, lease_token),
  unique (id, workspace_id),
  foreign key (task_id, run_id) references public.tasks (id, run_id) on delete cascade,
  foreign key (run_id, workspace_id) references public.runs (id, workspace_id) on delete cascade,
  check ((status = 'running') = (ended_at is null)),
  check ((status = 'succeeded') = (output is not null)),
  check ((status in ('failed', 'abandoned')) = (failure is not null))
);
create index agent_executions_task_idx on public.agent_executions (task_id, started_at);
create index agent_executions_run_idx on public.agent_executions (run_id, started_at);

-- The conversation, append-only. Tool results that carry page text store a reference to the snapshot.
create table public.agent_messages (
  execution_id uuid not null,
  seq integer not null check (seq > 0),
  workspace_id uuid not null,
  role text not null check (role in ('system', 'user', 'assistant', 'tool')),
  content jsonb not null,
  created_at timestamptz not null default now(),
  primary key (execution_id, seq),
  foreign key (execution_id, workspace_id) references public.agent_executions (id, workspace_id) on delete cascade
);

create table public.llm_calls (
  id uuid primary key,
  workspace_id uuid not null,
  run_id uuid not null,
  task_id uuid not null,
  execution_id uuid not null,
  seq integer not null check (seq >= 0),
  provider text not null check (provider in ('anthropic', 'openai_compatible')),
  provider_account text not null check (char_length(provider_account) between 1 and 60),
  model text not null check (char_length(model) between 1 and 100),
  route text not null check (route in ('planning', 'agent_loop', 'extraction', 'judge', 'analysis', 'writing')),
  routing_config_version text not null check (char_length(routing_config_version) between 1 and 40),
  prompt_version text not null check (char_length(prompt_version) between 1 and 40),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  input_tokens bigint not null check (input_tokens >= 0),
  output_tokens bigint not null check (output_tokens >= 0),
  reasoning_tokens bigint check (reasoning_tokens >= 0),
  cache_read_tokens bigint check (cache_read_tokens >= 0),
  cache_write_tokens bigint check (cache_write_tokens >= 0),
  cache_status text not null check (cache_status in ('hit', 'partial', 'miss', 'not_supported')),
  cost_usd_micros bigint not null check (cost_usd_micros >= 0),
  latency_ms integer not null check (latency_ms >= 0),
  retry_count integer not null check (retry_count >= 0),
  stop_reason text not null check (
    stop_reason in ('end_turn', 'tool_use', 'max_tokens', 'refusal', 'stop_sequence', 'error')
  ),
  failure jsonb,
  started_at timestamptz not null,
  unique (execution_id, seq),
  foreign key (execution_id, workspace_id) references public.agent_executions (id, workspace_id) on delete cascade,
  foreign key (run_id, workspace_id) references public.runs (id, workspace_id) on delete cascade,
  check ((stop_reason = 'error') = (failure is not null))
);
create index llm_calls_run_idx on public.llm_calls (run_id, started_at);

create table public.tool_calls (
  id uuid primary key,
  workspace_id uuid not null,
  run_id uuid not null,
  task_id uuid not null,
  execution_id uuid not null,
  tool text not null check (
    tool in ('web_search', 'fetch_page', 'lookup_company', 'find_company_people', 'search_knowledge', 'get_source')
  ),
  model_tool_call_id text check (char_length(model_tool_call_id) <= 200),
  arguments_hash text not null check (arguments_hash ~ '^[a-f0-9]{64}$'),
  arguments jsonb not null,
  status text not null check (status in ('ok', 'error')),
  error_code text check (
    error_code in (
      'INVALID_ARGUMENT', 'UNAUTHENTICATED', 'TOOL_NOT_PERMITTED', 'URL_NOT_PERMITTED', 'URL_BLOCKED',
      'ROBOTS_DISALLOWED', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'BUDGET_EXCEEDED', 'PROVIDER_UNAVAILABLE',
      'UPSTREAM_ERROR', 'TIMEOUT', 'CONTENT_TOO_LARGE', 'UNSUPPORTED_CONTENT_TYPE', 'NOT_FOUND',
      'UNSUPPORTED_JURISDICTION', 'INTERNAL'
    )
  ),
  provider text check (char_length(provider) <= 60),
  cache_hit boolean not null default false,
  latency_ms integer not null check (latency_ms >= 0),
  upstream_latency_ms integer check (upstream_latency_ms >= 0),
  cost_usd_micros bigint not null default 0 check (cost_usd_micros >= 0),
  created_source_ids uuid[] not null default '{}' check (cardinality(created_source_ids) <= 20),
  started_at timestamptz not null,
  foreign key (execution_id, workspace_id) references public.agent_executions (id, workspace_id) on delete cascade,
  foreign key (run_id, workspace_id) references public.runs (id, workspace_id) on delete cascade,
  check ((status = 'error') = (error_code is not null))
);
create index tool_calls_execution_idx on public.tool_calls (execution_id, started_at);
create index tool_calls_run_idx on public.tool_calls (run_id, started_at);

-- ---------------------------------------------------------------------------
-- Provenance
-- ---------------------------------------------------------------------------
create table public.discovered_urls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id uuid not null,
  url text not null check (char_length(url) between 1 and 2048),
  normalized_url text not null check (char_length(normalized_url) between 1 and 2048),
  normalized_url_hash text not null check (normalized_url_hash ~ '^[a-f0-9]{64}$'),
  origin_kind text not null check (origin_kind in ('user_provided', 'search_result', 'page_link', 'provider_record')),
  origin jsonb not null check (origin ->> 'kind' = origin_kind),
  discovered_at timestamptz not null default now(),
  -- The first origin wins: rediscovering a URL in the same run keeps the original reason.
  unique (run_id, normalized_url_hash),
  foreign key (run_id, workspace_id) references public.runs (id, workspace_id) on delete cascade
);

-- Snapshots belong to the workspace, not to one run: identical content at the same final URL is saved once.
-- Nothing may update them (no UPDATE privilege), so a quote checked against one stays checkable.
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  requested_url text not null check (char_length(requested_url) between 1 and 2048),
  final_url text not null check (char_length(final_url) between 1 and 2048),
  final_url_hash text not null check (final_url_hash ~ '^[a-f0-9]{64}$'),
  canonical_url text check (char_length(canonical_url) <= 2048),
  host text not null check (char_length(host) between 1 and 253),
  registrable_domain text not null check (char_length(registrable_domain) between 1 and 253),
  publisher text check (char_length(publisher) <= 200),
  source_type text not null check (
    source_type in ('company_website', 'press_release', 'news_article', 'registry_record', 'knowledge_base', 'blog', 'other')
  ),
  tier text not null check (tier in ('A', 'B', 'C', 'D')),
  -- A copy of the authorising origin, kept even if the run (and its discovered URL) is deleted.
  origin jsonb not null,
  discovered_url_id uuid references public.discovered_urls (id) on delete set null,
  retrieved_at timestamptz not null,
  http jsonb,
  published_at timestamptz,
  published_at_method text not null check (
    published_at_method in ('html_meta', 'json_ld', 'time_element', 'url_path', 'provider_field', 'none')
  ),
  raw_sha256 text not null check (raw_sha256 ~ '^[a-f0-9]{64}$'),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  text text not null check (char_length(text) <= 400000),
  text_length integer not null check (text_length >= 0),
  truncated boolean not null,
  extraction_method text not null check (extraction_method in ('readability_html', 'plain_text', 'provider_api')),
  extractor_version text not null check (char_length(extractor_version) between 1 and 40),
  title text check (char_length(title) <= 500),
  language text check (char_length(language) <= 10),
  flags text[] not null default '{}' check (
    flags <@ array['suspected_prompt_injection', 'paywall_suspected', 'thin_content', 'machine_translated']
    and cardinality(flags) <= 4
  ),
  -- Informational: the tool call that first saved it (tool calls are deleted with their run, sources are not).
  fetched_by_tool_call_id uuid not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, final_url_hash, content_sha256),
  unique (id, workspace_id),
  check ((extraction_method = 'provider_api') = (http is null)),
  check (extraction_method <> 'provider_api' or discovered_url_id is null),
  check (text_length = char_length(text))
);
create index sources_domain_idx on public.sources (workspace_id, registrable_domain);

-- ---------------------------------------------------------------------------
-- Rate limits: fixed windows in Postgres, so limits hold across MCP server instances.
-- Returns 0 when the call is allowed (and counted), otherwise the milliseconds until the window resets.
-- ---------------------------------------------------------------------------
create table private.rate_limit_counters (
  key text not null check (char_length(key) between 1 and 300),
  window_start timestamptz not null,
  count integer not null check (count > 0),
  primary key (key, window_start)
);

create function private.take_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_count integer;
begin
  if p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception 'invalid rate limit' using errcode = '22023';
  end if;
  v_window := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);
  delete from private.rate_limit_counters where key = p_key and window_start < v_window;
  insert into private.rate_limit_counters as c (key, window_start, count)
  values (p_key, v_window, 1)
  on conflict (key, window_start) do update set count = c.count + 1
  returning c.count into v_count;
  if v_count <= p_limit then
    return 0;
  end if;
  -- Over the limit: undo this attempt so rejected calls do not extend the lockout.
  update private.rate_limit_counters set count = count - 1 where key = p_key and window_start = v_window;
  return greatest(1, ceil(extract(epoch from (v_window + make_interval(secs => p_window_seconds) - clock_timestamp())) * 1000))::integer;
end;
$$;
revoke execute on function private.take_rate_limit(text, integer, integer) from public;

-- ---------------------------------------------------------------------------
-- Row-level security and privileges
-- ---------------------------------------------------------------------------
alter table public.agent_executions enable row level security;
alter table public.agent_messages enable row level security;
alter table public.llm_calls enable row level security;
alter table public.tool_calls enable row level security;
alter table public.discovered_urls enable row level security;
alter table public.sources enable row level security;
alter table private.rate_limit_counters enable row level security;

create policy agent_executions_member_read on public.agent_executions
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy agent_messages_member_read on public.agent_messages
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy llm_calls_member_read on public.llm_calls
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy tool_calls_member_read on public.tool_calls
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy discovered_urls_member_read on public.discovered_urls
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy sources_member_read on public.sources
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));

create policy agent_executions_backend on public.agent_executions for all to app_backend
  using (workspace_id = (select private.current_workspace()))
  with check (workspace_id = (select private.current_workspace()));
create policy agent_messages_backend on public.agent_messages for all to app_backend
  using (workspace_id = (select private.current_workspace()))
  with check (workspace_id = (select private.current_workspace()));
create policy llm_calls_backend on public.llm_calls for all to app_backend
  using (workspace_id = (select private.current_workspace()))
  with check (workspace_id = (select private.current_workspace()));
create policy tool_calls_backend on public.tool_calls for all to app_backend
  using (workspace_id = (select private.current_workspace()))
  with check (workspace_id = (select private.current_workspace()));
create policy discovered_urls_backend on public.discovered_urls for all to app_backend
  using (workspace_id = (select private.current_workspace()))
  with check (workspace_id = (select private.current_workspace()));
create policy sources_backend on public.sources for all to app_backend
  using (workspace_id = (select private.current_workspace()))
  with check (workspace_id = (select private.current_workspace()));

revoke all on public.agent_executions, public.agent_messages, public.llm_calls, public.tool_calls,
  public.discovered_urls, public.sources from anon, authenticated;
revoke all on private.rate_limit_counters from public, anon, authenticated;
grant select on public.agent_executions, public.agent_messages, public.llm_calls, public.tool_calls,
  public.discovered_urls, public.sources to authenticated;

-- Only an execution's own status and usage change; everything else is append-only.
grant select, insert, update on public.agent_executions to app_backend;
grant select, insert on public.agent_messages, public.llm_calls, public.tool_calls, public.discovered_urls,
  public.sources to app_backend;
grant execute on function private.take_rate_limit(text, integer, integer) to app_backend;

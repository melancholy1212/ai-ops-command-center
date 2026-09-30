-- Phase 4: knowledge and evidence (docs/database.md#knowledge-and-evidence, docs/domain-model.md).
--   * companies: workspace knowledge that persists across runs; one row per registrable domain.
--   * claims: one typed assertion each, with the verification verdict and why.
--   * evidence: the exact quote a claim rests on, where it sits in the saved snapshot, and the judge's verdict.
--     Quote, spans and grounding are immutable (only the judge columns may be updated).
--   * research_gaps: required attributes the run could not establish ("not found" is a recorded result).
--   * findings (+ finding_claims): what the report says, with the claims it rests on. Scores are code.
--   * artifacts (+ artifact_references): immutable report versions; only the status changes.
-- People, entity identifiers and outreach arrive with the agents that produce them (Phase 5).

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Companies
-- ---------------------------------------------------------------------------
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  normalized_name text not null check (char_length(normalized_name) between 1 and 200),
  primary_domain text check (char_length(primary_domain) between 3 and 253),
  country text check (country ~ '^[A-Z]{2}$'),
  first_seen_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create unique index companies_domain_key on public.companies (workspace_id, primary_domain) where primary_domain is not null;
create index companies_name_trgm_idx on public.companies using gin (normalized_name extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Claims
-- ---------------------------------------------------------------------------
create table public.claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id uuid not null,
  subject_company_id uuid not null,
  attribute text not null check (
    attribute in (
      'company.website', 'company.hq_country', 'company.hq_city', 'company.founded_year', 'company.description',
      'company.sector', 'company.funding_round', 'company.employee_count', 'company.hiring_signal',
      'company.registry_id', 'person.current_role', 'person.public_profile'
    )
  ),
  value jsonb not null,
  raw_value text not null check (char_length(raw_value) between 1 and 300),
  -- Rendered by code from the typed value. Reports show this, never model prose.
  statement text not null check (char_length(statement) between 5 and 400),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  status text not null default 'proposed' check (
    status in ('proposed', 'grounded', 'verified', 'probable', 'contested', 'stale', 'rejected')
  ),
  confidence text check (confidence in ('high', 'medium', 'low')),
  confidence_score numeric(4, 3) check (confidence_score between 0 and 1),
  -- Reasons, policy id and version, when and by which task it was evaluated.
  verification jsonb not null default '{"reasons": [], "policy": null, "evaluatedAt": null, "evaluatedByTaskId": null}',
  conflict_state text not null default 'none' check (conflict_state in ('none', 'conflicting', 'superseded')),
  conflicting_claim_ids uuid[] not null default '{}' check (cardinality(conflicting_claim_ids) <= 20),
  superseded_by uuid references public.claims (id) on delete set null,
  proposed_by_agent text not null check (
    proposed_by_agent in ('planner', 'research', 'company_intelligence', 'people_discovery', 'verifier', 'analyst', 'outreach_writer')
  ),
  proposed_by_execution_id uuid not null,
  newest_published_at timestamptz,
  oldest_published_at timestamptz,
  newest_retrieved_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, fingerprint),
  unique (id, workspace_id),
  foreign key (run_id, workspace_id) references public.runs (id, workspace_id) on delete cascade,
  foreign key (subject_company_id, workspace_id) references public.companies (id, workspace_id) on delete cascade,
  -- Company subjects only until people exist (Phase 5).
  check (attribute like 'company.%'),
  check ((status in ('verified', 'probable', 'contested')) = (confidence is not null)),
  check ((confidence is null) = (confidence_score is null)),
  check (conflict_state <> 'conflicting' or status = 'contested'),
  check ((conflict_state = 'superseded') = (superseded_by is not null))
);
create index claims_run_subject_idx on public.claims (run_id, subject_company_id, attribute);
create index claims_run_status_idx on public.claims (run_id, status);

-- ---------------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------------
create table public.evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  claim_id uuid not null,
  source_id uuid not null,
  quote text not null check (char_length(quote) between 20 and 1200),
  quote_sha256 text not null check (quote_sha256 ~ '^[a-f0-9]{64}$'),
  grounding text not null check (grounding in ('exact', 'normalized', 'elided_segments', 'not_found')),
  -- [{start, end}] in characters of the snapshot text; empty exactly when the quote was not found.
  spans jsonb not null default '[]' check (jsonb_typeof(spans) = 'array' and jsonb_array_length(spans) <= 5),
  value_in_quote boolean,
  stance text not null default 'supports' check (stance in ('supports', 'contradicts')),
  judge_verdict text check (judge_verdict in ('supports', 'partially_supports', 'does_not_support', 'contradicts')),
  judge_reason text check (char_length(judge_reason) between 1 and 500),
  judge_llm_call_id uuid references public.llm_calls (id) on delete set null,
  source_published_at timestamptz,
  source_retrieved_at timestamptz not null,
  extracted_by_execution_id uuid not null,
  created_at timestamptz not null default now(),
  unique (claim_id, source_id, quote_sha256),
  foreign key (claim_id, workspace_id) references public.claims (id, workspace_id) on delete cascade,
  foreign key (source_id, workspace_id) references public.sources (id, workspace_id) on delete cascade,
  check ((grounding = 'not_found') = (jsonb_array_length(spans) = 0)),
  -- Ungrounded quotes never reach the judge.
  check (grounding <> 'not_found' or judge_verdict is null),
  check ((judge_verdict is null) = (judge_reason is null))
);
create index evidence_claim_idx on public.evidence (claim_id);
create index evidence_source_idx on public.evidence (source_id);

-- ---------------------------------------------------------------------------
-- Research gaps
-- ---------------------------------------------------------------------------
create table public.research_gaps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id uuid not null,
  company_id uuid not null,
  attribute text not null check (attribute like 'company.%'),
  status text not null default 'open' check (status in ('open', 'filled', 'unavailable')),
  reason text not null check (reason in ('no_claim', 'only_rejected_claims', 'only_stale_claims', 'conflict_unresolved')),
  attempts integer not null default 0 check (attempts >= 0),
  note text check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (run_id, company_id, attribute),
  foreign key (run_id, workspace_id) references public.runs (id, workspace_id) on delete cascade,
  foreign key (company_id, workspace_id) references public.companies (id, workspace_id) on delete cascade,
  check ((status = 'open') = (resolved_at is null))
);

-- ---------------------------------------------------------------------------
-- Findings
-- ---------------------------------------------------------------------------
create table public.findings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id uuid not null,
  subject_kind text not null check (subject_kind in ('company', 'run')),
  subject_company_id uuid,
  kind text not null check (kind in ('score', 'analysis', 'inference', 'recommendation', 'risk')),
  label text not null check (label in ('fact_derived', 'analysis', 'inference')),
  statement text not null check (char_length(statement) between 5 and 1200),
  score jsonb,
  author_kind text not null check (author_kind in ('code', 'model')),
  author_module text check (char_length(author_module) between 1 and 100),
  author_version text check (char_length(author_version) between 1 and 40),
  author_execution_id uuid,
  created_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (run_id, workspace_id) references public.runs (id, workspace_id) on delete cascade,
  foreign key (subject_company_id, workspace_id) references public.companies (id, workspace_id) on delete cascade,
  check ((subject_kind = 'company') = (subject_company_id is not null)),
  check ((kind = 'score') = (score is not null)),
  check (kind <> 'score' or author_kind = 'code'),
  -- No AI-generated facts: code writes fact_derived findings, models only labelled analysis or inference.
  check ((label = 'fact_derived') = (author_kind = 'code')),
  check ((author_kind = 'code') = (author_module is not null and author_version is not null and author_execution_id is null)),
  check ((author_kind = 'model') = (author_execution_id is not null))
);

create table public.finding_claims (
  finding_id uuid not null,
  claim_id uuid not null,
  workspace_id uuid not null,
  role text not null check (role in ('basis', 'context')),
  primary key (finding_id, claim_id),
  foreign key (finding_id, workspace_id) references public.findings (id, workspace_id) on delete cascade,
  foreign key (claim_id, workspace_id) references public.claims (id, workspace_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Artifacts
-- ---------------------------------------------------------------------------
create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id uuid not null,
  kind text not null check (kind in ('prospect_report', 'outreach_draft')),
  version integer not null check (version > 0),
  previous_version_id uuid references public.artifacts (id) on delete set null,
  status text not null check (status in ('draft', 'pending_approval', 'approved', 'rejected', 'superseded', 'final')),
  content jsonb not null check (content ->> 'kind' = kind),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  author_kind text not null check (author_kind in ('code', 'model')),
  author_module text,
  author_version text,
  author_execution_id uuid,
  created_at timestamptz not null default now(),
  unique (run_id, kind, version),
  unique (id, workspace_id),
  foreign key (run_id, workspace_id) references public.runs (id, workspace_id) on delete cascade,
  check ((version = 1) = (previous_version_id is null)),
  check ((author_kind = 'code') = (author_module is not null and author_version is not null))
);

create table public.artifact_references (
  artifact_id uuid not null,
  workspace_id uuid not null,
  claim_id uuid,
  finding_id uuid,
  foreign key (artifact_id, workspace_id) references public.artifacts (id, workspace_id) on delete cascade,
  foreign key (claim_id, workspace_id) references public.claims (id, workspace_id) on delete cascade,
  foreign key (finding_id, workspace_id) references public.findings (id, workspace_id) on delete cascade,
  check (num_nonnulls(claim_id, finding_id) = 1)
);
create unique index artifact_references_claim_key on public.artifact_references (artifact_id, claim_id) where claim_id is not null;
create unique index artifact_references_finding_key on public.artifact_references (artifact_id, finding_id) where finding_id is not null;

-- ---------------------------------------------------------------------------
-- Row-level security and privileges
-- ---------------------------------------------------------------------------
alter table public.companies enable row level security;
alter table public.claims enable row level security;
alter table public.evidence enable row level security;
alter table public.research_gaps enable row level security;
alter table public.findings enable row level security;
alter table public.finding_claims enable row level security;
alter table public.artifacts enable row level security;
alter table public.artifact_references enable row level security;

create policy companies_member_read on public.companies
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy claims_member_read on public.claims
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy evidence_member_read on public.evidence
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy research_gaps_member_read on public.research_gaps
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy findings_member_read on public.findings
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy finding_claims_member_read on public.finding_claims
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy artifacts_member_read on public.artifacts
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy artifact_references_member_read on public.artifact_references
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));

create policy companies_backend on public.companies for all to app_backend
  using (workspace_id = (select private.current_workspace())) with check (workspace_id = (select private.current_workspace()));
create policy claims_backend on public.claims for all to app_backend
  using (workspace_id = (select private.current_workspace())) with check (workspace_id = (select private.current_workspace()));
create policy evidence_backend on public.evidence for all to app_backend
  using (workspace_id = (select private.current_workspace())) with check (workspace_id = (select private.current_workspace()));
create policy research_gaps_backend on public.research_gaps for all to app_backend
  using (workspace_id = (select private.current_workspace())) with check (workspace_id = (select private.current_workspace()));
create policy findings_backend on public.findings for all to app_backend
  using (workspace_id = (select private.current_workspace())) with check (workspace_id = (select private.current_workspace()));
create policy finding_claims_backend on public.finding_claims for all to app_backend
  using (workspace_id = (select private.current_workspace())) with check (workspace_id = (select private.current_workspace()));
create policy artifacts_backend on public.artifacts for all to app_backend
  using (workspace_id = (select private.current_workspace())) with check (workspace_id = (select private.current_workspace()));
create policy artifact_references_backend on public.artifact_references for all to app_backend
  using (workspace_id = (select private.current_workspace())) with check (workspace_id = (select private.current_workspace()));

revoke all on public.companies, public.claims, public.evidence, public.research_gaps, public.findings,
  public.finding_claims, public.artifacts, public.artifact_references from anon, authenticated;
grant select on public.companies, public.claims, public.evidence, public.research_gaps, public.findings,
  public.finding_claims, public.artifacts, public.artifact_references to authenticated;

grant select, insert, update on public.companies, public.claims, public.research_gaps to app_backend;
-- Evidence: quotes, spans and grounding are immutable; only the judge's verdict is added later.
grant select, insert on public.evidence to app_backend;
grant update (judge_verdict, judge_reason, judge_llm_call_id) on public.evidence to app_backend;
-- Findings and references are append-only; an artifact version's content never changes, only its status.
grant select, insert on public.findings, public.finding_claims, public.artifact_references to app_backend;
grant select, insert on public.artifacts to app_backend;
grant update (status) on public.artifacts to app_backend;

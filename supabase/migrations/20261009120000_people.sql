-- People (Phase 5; docs/database.md#knowledge-and-evidence, docs/domain-model.md). A person is workspace knowledge,
-- like a company. A claim stays anchored to the company it was gathered for (subject_company_id); a claim about a
-- person also names the person. Contact details are never stored: no attribute carries them.

create table public.people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  full_name text not null check (char_length(full_name) between 3 and 120),
  normalized_name text not null check (char_length(normalized_name) between 3 and 120),
  first_seen_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create index people_workspace_name_idx on public.people (workspace_id, normalized_name);
create index people_name_trgm_idx on public.people using gin (normalized_name extensions.gin_trgm_ops);

alter table public.claims add column subject_person_id uuid;
alter table public.claims add constraint claims_subject_person_fkey
  foreign key (subject_person_id, workspace_id) references public.people (id, workspace_id) on delete cascade;
-- Was: company attributes only, until people existed.
alter table public.claims drop constraint claims_attribute_check1;
-- person.* claims name a person; company.* claims do not.
alter table public.claims add constraint claims_person_subject_check
  check ((attribute like 'person.%') = (subject_person_id is not null));
-- A role is held at the company the claim is anchored to.
alter table public.claims add constraint claims_role_company_check
  check (attribute <> 'person.current_role' or value ->> 'companyId' = subject_company_id::text);
create index claims_person_idx on public.claims (subject_person_id) where subject_person_id is not null;

alter table public.people enable row level security;
create policy people_member_read on public.people
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy people_backend on public.people for all to app_backend
  using (workspace_id = (select private.current_workspace())) with check (workspace_id = (select private.current_workspace()));

revoke all on public.people from anon, authenticated;
grant select on public.people to authenticated;
grant select, insert, update on public.people to app_backend;

-- Tenancy foundation (docs/database.md, docs/security.md, ADR-0005):
--   * workspaces, workspace_members, projects
--   * app_backend: the role backend services act as; it does NOT bypass row-level security
--   * aoc_service: the login role services connect with; it has no privileges until it
--     runs `SET LOCAL ROLE app_backend` inside a transaction
--   * row-level security for signed-in users (membership) and for the backend (the
--     workspace set on the transaction with `app.workspace_id`)
--   * a personal workspace, owner membership and default project for every new user

-- ---------------------------------------------------------------------------
-- Helpers live in a schema the Data API does not expose.
-- ---------------------------------------------------------------------------
create schema private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------
-- Roles. Passwords are never set in migrations: locally a setup script sets a
-- throwaway one; in production it is set once, out of band (docs/deployment.md).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_backend') then
    create role app_backend nologin nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'aoc_service') then
    create role aoc_service login noinherit nobypassrls;
  end if;
end
$$;
grant app_backend to aoc_service with inherit false, set true;
-- Postgres 16+ does not let a role's creator assume it automatically. The admin role may
-- switch into app_backend (tests, admin tooling) but does not inherit anything from it.
grant app_backend to postgres with inherit false, set true;

-- New tables start with nothing granted to API roles; each migration grants exactly what it needs.
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'),
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_id_idx on public.workspace_members (user_id);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  description text check (description is null or char_length(description) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name),
  -- target for composite foreign keys from child tables (keeps workspace_id consistent)
  unique (id, workspace_id)
);

-- ---------------------------------------------------------------------------
-- RLS helpers
-- ---------------------------------------------------------------------------
-- The signed-in user's workspaces. Used as `workspace_id in (select ...)`, so it runs once per query.
create function private.my_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid());
$$;

-- The workspace a backend transaction is scoped to. Null (matches nothing) when unset.
create function private.current_workspace()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('app.workspace_id', true), '')::uuid;
$$;

revoke execute on function private.my_workspace_ids() from public;
revoke execute on function private.current_workspace() from public;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.projects enable row level security;

-- Signed-in users read what belongs to their workspaces. They write nothing directly:
-- changes go through domain commands, which act as app_backend.
create policy workspaces_member_read on public.workspaces
  for select to authenticated using (id in (select private.my_workspace_ids()));
create policy workspace_members_member_read on public.workspace_members
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));
create policy projects_member_read on public.projects
  for select to authenticated using (workspace_id in (select private.my_workspace_ids()));

-- The backend sees and changes only the workspace set on its transaction.
create policy workspaces_backend on public.workspaces
  for all to app_backend
  using (id = (select private.current_workspace()))
  with check (id = (select private.current_workspace()));
create policy workspace_members_backend on public.workspace_members
  for all to app_backend
  using (workspace_id = (select private.current_workspace()))
  with check (workspace_id = (select private.current_workspace()));
create policy projects_backend on public.projects
  for all to app_backend
  using (workspace_id = (select private.current_workspace()))
  with check (workspace_id = (select private.current_workspace()));

-- ---------------------------------------------------------------------------
-- Privileges: exactly what each role needs (RLS is not a substitute for grants)
-- ---------------------------------------------------------------------------
revoke all on public.workspaces, public.workspace_members, public.projects from anon, authenticated;
grant select on public.workspaces, public.workspace_members, public.projects to authenticated;

grant usage on schema public to app_backend;
-- Supabase installs extensions (pg_trgm for entity resolution, pgcrypto, ...) in `extensions`.
grant usage on schema extensions to app_backend;
grant select, insert, update, delete on public.workspaces, public.workspace_members, public.projects to app_backend;

grant usage on schema private to authenticated, app_backend;
grant execute on function private.my_workspace_ids() to authenticated;
grant execute on function private.current_workspace() to app_backend;

-- ---------------------------------------------------------------------------
-- Personal workspace on signup: created in the same transaction as the user, so a
-- user can never exist without one.
-- ---------------------------------------------------------------------------
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_workspace_id uuid;
begin
  insert into public.workspaces (name, slug)
  values ('Personal workspace', 'ws-' || replace(new.id::text, '-', ''))
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, new.id, 'owner');

  insert into public.projects (workspace_id, name)
  values (new_workspace_id, 'Default project');

  return new;
end;
$$;
revoke execute on function private.handle_new_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const metadata: Metadata = { title: 'Dashboard' };

// Sections from docs/ui.md. Unbuilt ones are shown as unavailable, with the phase that delivers them.
const NAV: readonly { label: string; phase: number | null }[] = [
  { label: 'Dashboard', phase: null },
  { label: 'Runs', phase: 2 },
  { label: 'Projects', phase: 2 },
  { label: 'Agents', phase: 3 },
  { label: 'MCP', phase: 3 },
  { label: 'Evidence', phase: 4 },
  { label: 'Approvals', phase: 5 },
  { label: 'Settings', phase: 6 },
];

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getClaims();
  const userId = auth?.claims.sub;
  // The authoritative check: the proxy only redirects for convenience.
  if (!userId) redirect('/sign-in');

  // Row-level security limits this to the signed-in user's workspaces.
  const { data: memberships, error } = await supabase
    .from('workspace_members')
    .select('role, workspace:workspaces(id, name, slug, created_at, projects(id, name, created_at))')
    .eq('user_id', userId);

  const membership = memberships?.[0];
  const workspace = membership?.workspace;

  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-56 shrink-0 border-r border-line bg-panel px-3 py-4 md:block">
        <p className="px-2 font-mono text-[11px] tracking-[0.18em] text-accent-cyan uppercase">AOC</p>
        <nav aria-label="Main" className="mt-6 space-y-0.5 text-sm">
          {NAV.map((item) =>
            item.phase === null ? (
              <span key={item.label} aria-current="page" className="block rounded-md bg-raised px-2 py-1.5 text-ink">
                {item.label}
              </span>
            ) : (
              <span
                key={item.label}
                aria-disabled="true"
                className="flex items-center justify-between rounded-md px-2 py-1.5 text-ink-subtle"
              >
                {item.label}
                <span className="font-mono text-[10px]">Phase {item.phase}</span>
              </span>
            ),
          )}
        </nav>
      </aside>

      <div className="flex-1">
        <header className="flex items-center justify-between border-b border-line px-6 py-3">
          <div className="text-sm">
            <span className="text-ink">{workspace?.name ?? 'No workspace'}</span>
            {membership ? (
              <span className="ml-2 rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
                {membership.role}
              </span>
            ) : null}
          </div>
          <form action="/auth/sign-out" method="post" className="flex items-center gap-3 text-sm">
            <span className="text-ink-muted">{auth.claims.email}</span>
            <button type="submit" className="rounded-md border border-line px-3 py-1 text-ink-muted hover:text-ink">
              Sign out
            </button>
          </form>
        </header>

        <main className="space-y-6 p-6">
          {error ? (
            <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              Could not load your workspace. Try again in a moment.
            </p>
          ) : null}

          <section className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-lg border border-line bg-panel p-4">
              <h2 className="text-xs font-medium tracking-wide text-ink-subtle uppercase">Workspace</h2>
              {workspace ? (
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-muted">Name</dt>
                    <dd>{workspace.name}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-muted">Slug</dt>
                    <dd className="truncate font-mono text-xs">{workspace.slug}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-muted">Created</dt>
                    <dd>{dateFormat.format(new Date(workspace.created_at))}</dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-3 text-sm text-ink-muted">No workspace found for this account.</p>
              )}
            </div>

            <div className="rounded-lg border border-line bg-panel p-4">
              <h2 className="text-xs font-medium tracking-wide text-ink-subtle uppercase">Projects</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {(workspace?.projects ?? []).map((project) => (
                  <li key={project.id} className="flex justify-between gap-4">
                    <span>{project.name}</span>
                    <span className="text-ink-muted">{dateFormat.format(new Date(project.created_at))}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-lg border border-line bg-panel p-4">
              <h2 className="text-xs font-medium tracking-wide text-ink-subtle uppercase">Runs</h2>
              <p className="mt-3 text-sm text-ink-muted">
                No runs yet. The workflow engine that executes them arrives in Phase 2.
              </p>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

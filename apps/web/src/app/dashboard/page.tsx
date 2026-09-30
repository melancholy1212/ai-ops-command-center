import type { Metadata } from 'next';
import Link from 'next/link';
import { ConsoleShell } from '@/components/console-shell';
import { StatusBadge } from '@/components/status-badge';
import { formatUtc } from '@/lib/run-view';
import { requireUser } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Dashboard' };

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });

export default async function DashboardPage() {
  const session = await requireUser();

  // Row-level security limits these to the signed-in user's workspaces.
  const [{ data: memberships, error }, { data: runs }, { data: pending }] = await Promise.all([
    session.supabase
      .from('workspace_members')
      .select('role, workspace:workspaces(id, name, slug, created_at, projects(id, name, created_at))')
      .eq('user_id', session.userId),
    session.supabase
      .from('runs')
      .select('id, objective, status, created_at')
      .order('created_at', { ascending: false })
      .limit(5),
    session.supabase.from('approvals').select('id, run_id, type').eq('status', 'pending').limit(10),
  ]);
  const workspace = memberships?.[0]?.workspace;

  return (
    <ConsoleShell active="Dashboard" session={session}>
      {error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          Could not load your workspace. Try again in a moment.
        </p>
      ) : null}

      {(pending ?? []).length > 0 ? (
        <section className="rounded-lg border border-warn/40 bg-panel p-4">
          <h2 className="text-xs font-medium tracking-wide text-warn uppercase">Waiting for you</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {(pending ?? []).map((a) => (
              <li key={a.id}>
                <Link href={`/runs/${a.run_id}`} className="text-ink hover:text-accent">
                  <span aria-hidden="true" className="text-warn">
                    ◆{' '}
                  </span>
                  {a.type.replaceAll('_', ' ')} approval
                </Link>
              </li>
            ))}
          </ul>
        </section>
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
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium tracking-wide text-ink-subtle uppercase">Recent runs</h2>
            <Link href="/runs/new" className="text-xs text-accent hover:underline">
              New run
            </Link>
          </div>
          {(runs ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-ink-muted">No runs yet: create one to start researching.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {(runs ?? []).map((run) => (
                <li key={run.id} className="space-y-1">
                  <Link href={`/runs/${run.id}`} className="line-clamp-1 text-ink hover:text-accent">
                    {run.objective}
                  </Link>
                  <div className="flex items-center gap-2">
                    <StatusBadge kind="run" status={run.status} />
                    <span className="font-mono text-[11px] text-ink-subtle">{formatUtc(run.created_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Link href="/runs" className="mt-3 block text-xs text-ink-muted hover:text-ink">
            All runs →
          </Link>
        </div>
      </section>
    </ConsoleShell>
  );
}

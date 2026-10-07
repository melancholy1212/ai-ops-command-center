import type { Metadata } from 'next';
import Link from 'next/link';
import { ConsoleShell } from '@/components/console-shell';
import { StatusBadge } from '@/components/status-badge';
import { buttonClass } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { formatUsd, formatUtc, taskProgress } from '@/lib/run-view';
import { requireUser } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Runs' };

export default async function RunsPage() {
  const session = await requireUser();
  const { data: runs, error } = await session.supabase
    .from('runs')
    .select('id, objective, status, created_at, spend_cost_usd_micros, project:projects(name), tasks(status)')
    .order('created_at', { ascending: false })
    .limit(50);

  return (
    <ConsoleShell section="runs" session={session}>
      <PageHeader
        title="Runs"
        actions={
          <Link href="/runs/new" className={buttonClass({ variant: 'primary' })}>
            New run
          </Link>
        }
      />
      {error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          Could not load runs. Try again in a moment.
        </p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-ink-muted">No runs yet: create one to start researching.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-subtle">
              <tr className="border-b border-line">
                <th className="px-3 py-2 font-medium">Objective</th>
                <th className="px-3 py-2 font-medium">Project</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Tasks done</th>
                <th className="px-3 py-2 font-medium">Cost</th>
                <th className="px-3 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const progress = taskProgress(run.tasks);
                return (
                  <tr key={run.id} className="border-b border-line last:border-0 hover:bg-raised">
                    <td className="max-w-md px-3 py-2">
                      <Link href={`/runs/${run.id}`} className="line-clamp-2 text-ink hover:text-accent">
                        {run.objective}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-ink-muted">{run.project.name}</td>
                    <td className="px-3 py-2">
                      <StatusBadge kind="run" status={run.status} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-ink-muted">
                      {progress.done} of {progress.total}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-ink-muted">
                      {formatUsd(run.spend_cost_usd_micros)}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap text-ink-subtle">
                      {formatUtc(run.created_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleShell>
  );
}

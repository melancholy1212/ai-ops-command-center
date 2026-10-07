import { DEFAULT_RUN_BUDGET } from '@aoc/core';
import type { Metadata } from 'next';
import { ConsoleShell } from '@/components/console-shell';
import { PageHeader } from '@/components/ui/page-header';
import { formatCount, formatUsd } from '@/lib/run-view';
import { requireUser } from '@/lib/server/session';
import { NewRunForm } from './new-run-form';

export const metadata: Metadata = { title: 'New run' };

export default async function NewRunPage() {
  const session = await requireUser();
  const { data: projects } = await session.supabase.from('projects').select('id, name').order('created_at');

  return (
    <ConsoleShell section="runs" crumbs={[{ label: 'New run' }]} session={session}>
      <PageHeader
        title="New research run"
        description={
          <>
            Default budget: {formatUsd(DEFAULT_RUN_BUDGET.maxCostUsdMicros)},{' '}
            {formatCount(DEFAULT_RUN_BUDGET.maxLlmTokens)} model tokens, {formatCount(DEFAULT_RUN_BUDGET.maxToolCalls)}{' '}
            tool calls. When it runs out, the run pauses and asks for an extension.
          </>
        }
      />
      {(projects ?? []).length === 0 ? (
        <p className="text-sm text-ink-muted">No project found in your workspace, so a run cannot be created.</p>
      ) : (
        <NewRunForm projects={projects ?? []} />
      )}
    </ConsoleShell>
  );
}

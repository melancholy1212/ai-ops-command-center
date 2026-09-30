import { DEFAULT_RUN_BUDGET } from '@aoc/core';
import type { Metadata } from 'next';
import { ConsoleShell } from '@/components/console-shell';
import { formatCount, formatUsd } from '@/lib/run-view';
import { requireUser } from '@/lib/server/session';
import { NewRunForm } from './new-run-form';

export const metadata: Metadata = { title: 'New run' };

export default async function NewRunPage() {
  const session = await requireUser();
  const { data: projects } = await session.supabase.from('projects').select('id, name').order('created_at');

  return (
    <ConsoleShell active="Runs" session={session}>
      <div>
        <h1 className="text-lg font-medium">New research run</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Default budget: {formatUsd(DEFAULT_RUN_BUDGET.maxCostUsdMicros)},{' '}
          {formatCount(DEFAULT_RUN_BUDGET.maxLlmTokens)} model tokens, {formatCount(DEFAULT_RUN_BUDGET.maxToolCalls)}{' '}
          tool calls. When it runs out, the run pauses and asks for an extension.
        </p>
      </div>
      {(projects ?? []).length === 0 ? (
        <p className="text-sm text-ink-muted">No project found in your workspace, so a run cannot be created.</p>
      ) : (
        <NewRunForm projects={projects ?? []} />
      )}
    </ConsoleShell>
  );
}

import {
  Budget,
  Failure,
  TERMINAL_RUN_STATUSES,
  type Actor,
  type RunId,
  type RunStatus,
  type Spend,
  type TaskStatus,
  type TaskType,
} from '@aoc/contracts';
import { toJson, type DB, type WorkspaceTransaction } from '@aoc/db';
import type { Selectable } from 'kysely';
import { DomainError } from '../errors';
import { deriveRunStatus } from '../run-status';
import { appendEvent } from './events';

export type RunRow = Selectable<DB['runs']>;

/**
 * Every transition starts here: locking the run row serialises all changes within one run, so two
 * tasks finishing at the same moment can never both miss promoting their shared dependent.
 */
export async function lockRun(tx: WorkspaceTransaction, runId: RunId | string): Promise<RunRow> {
  const run = await tx.selectFrom('runs').selectAll().where('id', '=', runId).forUpdate().executeTakeFirst();
  if (!run) throw new DomainError('NOT_FOUND', 'Run not found.');
  return run;
}

export function isTerminal(status: string): boolean {
  return TERMINAL_RUN_STATUSES.includes(status as RunStatus);
}

export function runSpend(run: RunRow): Spend {
  return {
    costUsdMicros: Number(run.spend_cost_usd_micros),
    llmInputTokens: Number(run.spend_llm_input_tokens),
    llmOutputTokens: Number(run.spend_llm_output_tokens),
    toolCalls: run.spend_tool_calls,
  };
}

export function runBudget(run: RunRow): Budget {
  return Budget.parse(run.budget);
}

/**
 * Re-derives the run status from its tasks and flags and records the change. Terminal statuses are
 * final: nothing moves a completed, failed or cancelled run back.
 */
export async function recomputeRunStatus(
  tx: WorkspaceTransaction,
  run: RunRow,
  actor: Actor,
  reason?: string,
): Promise<RunRow> {
  if (isTerminal(run.status)) return run;
  const tasks = await tx
    .selectFrom('tasks')
    .select(['type', 'status', 'last_failure'])
    .where('run_id', '=', run.id)
    .execute();
  const derived = deriveRunStatus(
    {
      cancelRequested: run.cancel_requested,
      pauseRequested: run.pause_requested,
      budgetBlocked: run.budget_blocked,
      tasks: tasks.map((t) => ({
        type: t.type as TaskType,
        status: t.status as TaskStatus,
        lastFailure: t.last_failure ? Failure.parse(t.last_failure) : null,
      })),
    },
    new Date(),
  );
  if (derived.status === run.status && derived.pauseReason === run.pause_reason) return run;

  const now = new Date();
  const updated = await tx
    .updateTable('runs')
    .set({
      status: derived.status,
      pause_reason: derived.pauseReason,
      failure: derived.failure ? toJson(derived.failure) : null,
      started_at: run.started_at ?? (derived.status === 'draft' ? null : now),
      finished_at: isTerminal(derived.status) ? now : null,
      updated_at: now,
    })
    .where('id', '=', run.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  const why = reason ?? derived.failure?.message ?? derived.pauseReason ?? null;
  await appendEvent(tx, run, actor, {
    type: 'run.status_changed',
    data: { from: run.status as RunStatus, to: derived.status, reason: why ? why.slice(0, 300) : null },
  });
  return updated;
}

import type { Actor, ApprovalId, ApprovalType, TaskId, TaskType } from '@aoc/contracts';
import { toJson, type WorkspaceTransaction } from '@aoc/db';
import { appendEvent } from './events';
import { recomputeRunStatus, type RunRow } from './runs';

/**
 * Cancels a run inside an existing transaction (the run row is already locked): everything not yet
 * running is cancelled now, pending approvals are invalidated, and running tasks stop at their next
 * heartbeat or completion.
 */
export async function cancelRunInTx(
  tx: WorkspaceTransaction,
  run: RunRow,
  actor: Actor,
  reason: string,
): Promise<RunRow> {
  const now = new Date();
  await tx.updateTable('runs').set({ cancel_requested: true, updated_at: now }).where('id', '=', run.id).execute();

  const pending = await tx
    .selectFrom('tasks')
    .select(['id', 'type', 'status', 'attempt'])
    .where('run_id', '=', run.id)
    .where('status', 'in', ['blocked', 'ready', 'waiting_approval'])
    .forUpdate()
    .execute();
  if (pending.length > 0) {
    await tx
      .updateTable('tasks')
      .set({
        status: 'cancelled',
        finished_at: now,
        updated_at: now,
        last_failure: toJson({
          code: 'CANCELLED',
          class: 'policy',
          message: reason.slice(0, 2000),
          retryable: false,
          occurredAt: now.toISOString(),
        }),
      })
      .where(
        'id',
        'in',
        pending.map((t) => t.id),
      )
      .execute();
  }
  for (const task of pending) {
    await appendEvent(tx, run, actor, {
      type: 'task.status_changed',
      refs: { taskId: task.id as TaskId },
      data: {
        taskType: task.type as TaskType,
        from: task.status as 'blocked' | 'ready' | 'waiting_approval',
        to: 'cancelled',
        attempt: task.attempt,
      },
    });
  }

  const approvals = await tx
    .updateTable('approvals')
    .set({
      status: 'invalidated',
      invalidated_at: now,
      invalidation_reason: 'run_cancelled',
      invalidation_detail: reason.slice(0, 500),
    })
    .where('run_id', '=', run.id)
    .where('status', '=', 'pending')
    .returning(['id', 'type'])
    .execute();
  for (const approval of approvals) {
    await appendEvent(tx, run, actor, {
      type: 'approval.invalidated',
      refs: { approvalId: approval.id as ApprovalId },
      data: { approvalType: approval.type as ApprovalType, reason: 'Run cancelled.' },
    });
  }
  return recomputeRunStatus(tx, { ...run, cancel_requested: true }, actor, reason);
}

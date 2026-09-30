import type { Failure } from '@aoc/contracts';
import { toJson, type WorkspaceTransaction } from '@aoc/db';

/**
 * Safety net for every way an attempt can end without its runtime closing the execution (crash, lease
 * lost, timeout, cancellation, shutdown): an execution still marked running for the task is closed as
 * abandoned with the reason. A zombie runtime that finishes later cannot reopen it, because it only
 * closes executions that are still running.
 */
export async function abandonOpenExecutions(tx: WorkspaceTransaction, taskId: string, failure: Failure): Promise<void> {
  await tx
    .updateTable('agent_executions')
    .set({ status: 'abandoned', failure: toJson(failure), ended_at: new Date() })
    .where('task_id', '=', taskId)
    .where('status', '=', 'running')
    .execute();
}

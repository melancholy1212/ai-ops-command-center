import { WORKFLOW_LIMITS, type Actor, type RunId, type TaskId, type TaskType, type WorkspaceId } from '@aoc/contracts';
import { withBackend, type Database } from '@aoc/db';
import { sql } from 'kysely';
import { LeaseLostError } from '../errors';
import { failTaskAttempt, makeFailure } from './transitions';
import type { ClaimedTask, EngineOptions } from './types';

interface ClaimRow {
  task_id: string;
  workspace_id: string;
  run_id: string;
  task_type: string;
  attempt: number;
  lease_token: string;
}

export interface ClaimOptions {
  workerId: string;
  leaseSeconds: number;
  /** Only task types this worker has handlers for are claimed. */
  taskTypes: readonly TaskType[];
  maxParallelPerRun?: number;
}

/** Leases the next ready task across all workspaces, or returns null when there is nothing to do. */
export async function claimNextTask(db: Database, options: ClaimOptions): Promise<ClaimedTask | null> {
  if (options.taskTypes.length === 0) return null;
  const types = [...options.taskTypes];
  const maxParallel = options.maxParallelPerRun ?? WORKFLOW_LIMITS.maxParallelTasksPerRun;
  const row = await withBackend(db, async (tx) => {
    const result = await sql<ClaimRow>`
      select * from private.claim_next_task(${options.workerId}, ${options.leaseSeconds}, ${types}::text[], ${maxParallel})
    `.execute(tx);
    return result.rows[0];
  });
  if (!row) return null;
  return {
    taskId: row.task_id as TaskId,
    workspaceId: row.workspace_id as WorkspaceId,
    runId: row.run_id as RunId,
    taskType: row.task_type as TaskType,
    attempt: row.attempt,
    leaseToken: row.lease_token,
  };
}

/**
 * Finds tasks whose worker stopped heartbeating, takes over their lease (fencing the old worker out)
 * and records the lost attempt through the normal transition, which retries or fails the task.
 */
export async function recoverExpiredLeases(
  db: Database,
  workerId: string,
  actor: Actor,
  options: EngineOptions,
  maxRows = 20,
): Promise<number> {
  const reaped = await withBackend(db, async (tx) => {
    const result = await sql<ClaimRow & { previous_owner: string | null }>`
      select task_id, workspace_id, run_id, lease_token, previous_owner, attempt, null::text as task_type
      from private.reap_expired_leases(${workerId}, ${maxRows})
    `.execute(tx);
    return result.rows;
  });
  let recovered = 0;
  for (const row of reaped) {
    const claim: ClaimedTask = {
      taskId: row.task_id as TaskId,
      workspaceId: row.workspace_id as WorkspaceId,
      runId: row.run_id as RunId,
      taskType: row.task_type as TaskType,
      attempt: row.attempt,
      leaseToken: row.lease_token,
    };
    try {
      await failTaskAttempt(
        db,
        claim,
        makeFailure('LEASE_EXPIRED', 'The worker running this task stopped responding.', true),
        actor,
        options,
        { previousOwner: row.previous_owner ?? 'unknown' },
      );
      recovered += 1;
    } catch (error) {
      if (!(error instanceof LeaseLostError)) throw error;
    }
  }
  return recovered;
}

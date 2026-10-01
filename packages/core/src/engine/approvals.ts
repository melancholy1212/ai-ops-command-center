import {
  ApprovalSnapshot,
  ApprovalTarget,
  type Actor,
  type ApprovalId,
  type ApprovalType,
  type RunId,
  type TaskId,
} from '@aoc/contracts';
import { toJson, type WorkspaceTransaction } from '@aoc/db';
import { proposeExtension, type BudgetDimension } from '../budget';
import { snapshotHash } from '../canonical-json';
import { DomainError } from '../errors';
import { appendEvent } from './events';
import { lockRun, runBudget, runSpend, type RunRow } from './runs';
import type { ApprovalRequest } from './types';

export const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Freezes each snapshot, hashes it (RFC 8785) and stores it as a pending approval. What the user is
 * shown later is this stored snapshot, never live data.
 */
export async function insertApprovals(
  tx: WorkspaceTransaction,
  run: RunRow,
  taskId: string | null,
  requests: readonly ApprovalRequest[],
  actor: Actor,
): Promise<ApprovalId[]> {
  const ids: ApprovalId[] = [];
  for (const request of requests) {
    const snapshot = ApprovalSnapshot.parse(request.snapshot);
    const target = ApprovalTarget.parse(request.target);
    if (snapshot.kind !== request.type || target.type !== request.type) {
      throw new DomainError('VALIDATION', 'Approval type, target and snapshot kind must agree.');
    }
    const hash = snapshotHash(snapshot);
    const row = await tx
      .insertInto('approvals')
      .values({
        workspace_id: run.workspace_id,
        run_id: run.id,
        task_id: taskId,
        type: request.type,
        target: toJson(target),
        target_key: request.targetKey,
        snapshot: toJson(snapshot),
        snapshot_hash: hash,
        snapshot_schema_version: SNAPSHOT_SCHEMA_VERSION,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ids.push(row.id as ApprovalId);
    await appendEvent(tx, run, actor, {
      type: 'approval.requested',
      refs: { approvalId: row.id as ApprovalId, ...(taskId ? { taskId: taskId as TaskId } : {}) },
      data: { approvalType: request.type, snapshotHash: hash },
    });
  }
  return ids;
}

/** Asks the user for more budget, once: a pending request is not duplicated. */
export async function requestBudgetExtension(
  tx: WorkspaceTransaction,
  run: RunRow,
  exhausted: readonly BudgetDimension[],
  actor: Actor,
): Promise<void> {
  const pending = await tx
    .selectFrom('approvals')
    .select('id')
    .where('run_id', '=', run.id)
    .where('type', '=', 'budget_extension')
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (pending) return;
  const budget = runBudget(run);
  await insertApprovals(
    tx,
    run,
    null,
    [
      {
        type: 'budget_extension',
        target: { type: 'budget_extension', runId: run.id as RunId },
        targetKey: `budget:${run.id}`,
        snapshot: {
          kind: 'budget_extension',
          current: budget,
          spent: runSpend(run),
          requested: proposeExtension(budget, exhausted),
          reason: `Exhausted: ${exhausted.join(', ')}.`,
        },
      },
    ],
    actor,
  );
}

/**
 * Before an approved item is used, rebuild its snapshot from current data and compare hashes. If the
 * item or anything it cites changed, the approval is invalidated and the caller must ask again.
 */
export async function assertApprovalCurrent(
  tx: WorkspaceTransaction,
  approvalId: string,
  currentSnapshot: unknown,
  reason: 'target_changed' | 'cited_claims_changed',
  actor: Actor,
): Promise<boolean> {
  const found = await tx.selectFrom('approvals').select('run_id').where('id', '=', approvalId).executeTakeFirst();
  if (!found) throw new DomainError('NOT_FOUND', 'Approval not found.');
  // Same lock order as every other transition: run first, then the approval.
  const run = await lockRun(tx, found.run_id);
  const approval = await tx
    .selectFrom('approvals')
    .selectAll()
    .where('id', '=', approvalId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  if (snapshotHash(ApprovalSnapshot.parse(currentSnapshot)) === approval.snapshot_hash) return true;
  if (approval.status === 'pending' || approval.status === 'approved') {
    const detail = reason === 'target_changed' ? 'The approved item changed.' : 'A cited claim changed.';
    await tx
      .updateTable('approvals')
      .set({
        status: 'invalidated',
        invalidated_at: new Date(),
        invalidation_reason: reason,
        invalidation_detail: detail,
      })
      .where('id', '=', approval.id)
      .execute();
    await appendEvent(tx, run, actor, {
      type: 'approval.invalidated',
      refs: { approvalId: approval.id as ApprovalId },
      data: { approvalType: approval.type as ApprovalType, reason: detail },
    });
  }
  return false;
}

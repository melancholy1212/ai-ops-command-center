import {
  ApprovalSnapshot,
  DecideApprovalCommand,
  TaskOutputRef,
  type Actor,
  type ApprovalId,
  type ApprovalType,
  type TaskId,
  type WorkspaceId,
} from '@aoc/contracts';
import { toJson, withWorkspace, type Database, type WorkspaceTransaction } from '@aoc/db';
import { appendEvent } from '../engine/events';
import { settleRun } from '../engine/graph';
import { lockRun, recomputeRunStatus, type RunRow } from '../engine/runs';
import { EMPTY_REFS, makeFailure, setTaskStatus } from '../engine/transitions';
import { DomainError } from '../errors';
import { replanAfterRejection } from '../workflow/prospect';
import { actorOf, audit, authorize, parseCommand, type UserActor } from './common';

/**
 * A human decision on a pending approval. The decision must quote the hash of the snapshot the user
 * was shown; a mismatch means the item changed and the decision is refused.
 */
export async function decideApproval(
  db: Database,
  user: UserActor,
  workspaceId: WorkspaceId,
  input: unknown,
): Promise<{ decision: 'approved' | 'rejected' }> {
  const command = parseCommand(DecideApprovalCommand, input);
  return withWorkspace(db, workspaceId, async (tx) => {
    await authorize(tx, user, workspaceId, 'decideApproval');
    const found = await tx
      .selectFrom('approvals')
      .select('run_id')
      .where('id', '=', command.approvalId)
      .executeTakeFirst();
    if (!found) throw new DomainError('NOT_FOUND', 'Approval not found.');
    let run = await lockRun(tx, found.run_id);
    const approval = await tx
      .selectFrom('approvals')
      .selectAll()
      .where('id', '=', command.approvalId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (approval.status !== 'pending')
      throw new DomainError('INVALID_STATE', `This approval is already ${approval.status}.`);
    if (command.snapshotHashSeen !== approval.snapshot_hash) {
      throw new DomainError('STALE_SNAPSHOT', 'This item changed since you opened it. Review the current version.');
    }

    const actor = actorOf(user);
    await tx
      .updateTable('approvals')
      .set({
        status: command.decision,
        decision: command.decision,
        decided_by: user.userId,
        decided_at: new Date(),
        decision_reason: command.reason,
        snapshot_hash_seen: command.snapshotHashSeen,
      })
      .where('id', '=', approval.id)
      .execute();
    await appendEvent(tx, run, actor, {
      type: 'approval.decided',
      refs: {
        approvalId: approval.id as ApprovalId,
        ...(approval.task_id ? { taskId: approval.task_id as TaskId } : {}),
      },
      data: {
        approvalType: approval.type as ApprovalType,
        decision: command.decision,
        snapshotHash: approval.snapshot_hash,
      },
    });
    await audit(
      tx,
      workspaceId,
      actor,
      'approval.decided',
      { type: 'approval', id: approval.id },
      { decision: command.decision },
    );

    if (approval.type === 'budget_extension' && command.decision === 'approved') {
      const snapshot = ApprovalSnapshot.parse(approval.snapshot);
      if (snapshot.kind !== 'budget_extension') throw new DomainError('INVALID_STATE', 'Malformed budget snapshot.');
      await tx
        .updateTable('runs')
        .set({ budget: toJson(snapshot.requested), budget_blocked: false, updated_at: new Date() })
        .where('id', '=', run.id)
        .execute();
    }
    if (approval.task_id) await resolveGate(tx, run, approval.task_id, actor);

    // Re-read: the decision may have changed the budget, or a rejected plan may have cancelled the run.
    run = await tx.selectFrom('runs').selectAll().where('id', '=', run.id).executeTakeFirstOrThrow();
    await settleRun(tx, run, actor);
    await recomputeRunStatus(tx, run, actor);
    return { decision: command.decision };
  });
}

/**
 * A gate completes once none of its approvals is pending. A plan gate succeeds only if the plan was
 * approved; a rejection fails it and starts the next plan revision. An outreach gate always
 * succeeds: rejected drafts are simply left out of the report.
 */
async function resolveGate(tx: WorkspaceTransaction, run: RunRow, gateId: string, actor: Actor) {
  const gate = await tx.selectFrom('tasks').selectAll().where('id', '=', gateId).forUpdate().executeTakeFirstOrThrow();
  if (gate.status !== 'waiting_approval') return;
  const approvals = await tx
    .selectFrom('approvals')
    .select(['id', 'type', 'status', 'decision_reason', 'requested_at'])
    .where('task_id', '=', gate.id)
    .orderBy('requested_at')
    .execute();
  if (approvals.some((a) => a.status === 'pending')) return;
  const approved = approvals.filter((a) => a.status === 'approved').length;
  const rejected = approvals.filter((a) => a.status === 'rejected').length;
  const succeed = async () => {
    const output = TaskOutputRef.parse({
      executionId: null,
      created: { ...EMPTY_REFS, approvalIds: approvals.map((a) => a.id) },
      summary: { approved, rejected },
    });
    await setTaskStatus(tx, run, gate, actor, 'succeeded', { output: toJson(output) }, { approved, rejected });
  };

  if (gate.type === 'approve_plan') {
    const plan = approvals.at(-1);
    if (plan?.status === 'approved') {
      await succeed();
      return;
    }
    const reason = plan?.decision_reason ?? 'The plan was not approved.';
    await setTaskStatus(tx, run, gate, actor, 'failed', {
      last_failure: toJson(makeFailure('APPROVAL_REJECTED', `Plan rejected: ${reason}`, false)),
    });
    await replanAfterRejection(tx, run, gate, reason, actor);
    return;
  }
  if (gate.type === 'approve_outreach') {
    await succeed();
    return;
  }
  throw new DomainError('INVALID_STATE', `Task type ${gate.type} is not an approval gate.`);
}

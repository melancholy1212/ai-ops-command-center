import {
  FAILURE_CLASS,
  TASK_DEFINITIONS,
  TaskOutputRef,
  type Actor,
  type Failure,
  type FailureCode,
  type TaskId,
  type TaskType,
} from '@aoc/contracts';
import { toJson, withWorkspace, type Database, type WorkspaceTransaction } from '@aoc/db';
import { sql } from 'kysely';
import { retryDelayMs } from '../backoff';
import { evaluateBudget, TASK_COST_ESTIMATES, type BudgetDimension } from '../budget';
import { DomainError, TaskFailure } from '../errors';
import { insertApprovals, requestBudgetExtension } from './approvals';
import { appendEvent } from './events';
import { abandonOpenExecutions } from './executions';
import { CLEARED_LEASE, createTasks, lockLeasedTask, settleRun, type TaskRow } from './graph';
import { isTerminal, lockRun, recomputeRunStatus, runBudget, runSpend, type RunRow } from './runs';
import type { ClaimedTask, CreatedRefs, EngineOptions, TaskOutcome } from './types';

export const EMPTY_REFS: CreatedRefs = {
  companyIds: [],
  personIds: [],
  claimIds: [],
  sourceIds: [],
  gapIds: [],
  findingIds: [],
  artifactIds: [],
  approvalIds: [],
  taskIds: [],
};

export function makeFailure(
  code: FailureCode,
  message: string,
  retryable: boolean,
  detail?: Readonly<Record<string, unknown>>,
): Failure {
  return {
    code,
    class: FAILURE_CLASS[code],
    message: message.slice(0, 2000),
    retryable,
    occurredAt: new Date().toISOString(),
    ...(detail ? { detail: toJson(detail) as Failure['detail'] } : {}),
  };
}

/** Handler errors become typed failures. Unknown errors are bugs: retried a limited number of times. */
export function toFailure(error: unknown): Failure {
  if (error instanceof TaskFailure) return makeFailure(error.code, error.message, false, error.detail);
  const message = error instanceof Error ? error.message : String(error);
  return makeFailure('INTERNAL_ERROR', 'Unexpected error in task handler.', false, { error: message.slice(0, 300) });
}

type NewTaskStatus = 'ready' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled';

export async function setTaskStatus(
  tx: WorkspaceTransaction,
  run: RunRow,
  task: TaskRow,
  actor: Actor,
  to: NewTaskStatus,
  fields: Record<string, unknown>,
  summary?: Record<string, string | number | boolean>,
  attempt = task.attempt,
) {
  const now = new Date();
  const terminal = to === 'succeeded' || to === 'failed' || to === 'cancelled';
  await tx
    .updateTable('tasks')
    .set({ status: to, updated_at: now, ...(terminal ? { finished_at: now } : {}), ...fields })
    .where('id', '=', task.id)
    .execute();
  await appendEvent(tx, run, actor, {
    type: 'task.status_changed',
    refs: { taskId: task.id as TaskId },
    data: {
      taskType: task.type as TaskType,
      from: task.status as 'running' | 'waiting_approval',
      to,
      attempt,
      ...(summary ? { summary } : {}),
    },
  });
}

/** Puts a leased task back in the queue without counting the attempt (shutdown, pause, budget). */
export async function releaseLeasedTask(
  tx: WorkspaceTransaction,
  run: RunRow,
  task: TaskRow,
  actor: Actor,
  reason: string,
  code: 'WORKER_SHUTDOWN' | 'BUDGET_EXHAUSTED' = 'WORKER_SHUTDOWN',
) {
  const attempt = Math.max(0, task.attempt - 1);
  await abandonOpenExecutions(tx, task.id, makeFailure(code, `Handed back: ${reason}.`, code === 'WORKER_SHUTDOWN'));
  await setTaskStatus(
    tx,
    run,
    task,
    actor,
    'ready',
    { attempt, run_after: new Date(), ...CLEARED_LEASE },
    { released: reason },
    attempt,
  );
}

export async function cancelLeasedTask(tx: WorkspaceTransaction, run: RunRow, task: TaskRow, actor: Actor) {
  const failure = makeFailure('CANCELLED', 'The run was cancelled.', false);
  await abandonOpenExecutions(tx, task.id, failure);
  await setTaskStatus(tx, run, task, actor, 'cancelled', { ...CLEARED_LEASE, last_failure: toJson(failure) });
  await recomputeRunStatus(tx, run, actor);
}

async function pauseForBudget(
  tx: WorkspaceTransaction,
  run: RunRow,
  task: TaskRow,
  exhausted: readonly BudgetDimension[],
  actor: Actor,
) {
  await releaseLeasedTask(tx, run, task, actor, 'budget exhausted', 'BUDGET_EXHAUSTED');
  await tx.updateTable('runs').set({ budget_blocked: true, updated_at: new Date() }).where('id', '=', run.id).execute();
  await requestBudgetExtension(tx, run, exhausted, actor);
  await recomputeRunStatus(tx, { ...run, budget_blocked: true }, actor, `Budget exhausted: ${exhausted.join(', ')}`);
}

/** A running attempt ran out of budget: hand the task back and pause the run for a budget extension. */
export async function releaseForBudget(
  db: Database,
  claim: ClaimedTask,
  exhausted: readonly BudgetDimension[],
  actor: Actor,
): Promise<void> {
  await withWorkspace(db, claim.workspaceId, async (tx) => {
    const run = await lockRun(tx, claim.runId);
    const task = await lockLeasedTask(tx, claim.taskId, claim.leaseToken);
    if (run.cancel_requested || isTerminal(run.status)) {
      await cancelLeasedTask(tx, run, task, actor);
      return;
    }
    await pauseForBudget(tx, run, task, exhausted, actor);
  });
}

export type StartResult =
  { started: true; task: TaskRow; run: RunRow } | { started: false; reason: 'cancelled' | 'paused' | 'budget' };

/**
 * First step after a claim: the run lock makes cancel, pause and budget checks authoritative. Work that
 * would not fit in the remaining budget is never started; the run pauses and asks for an extension.
 */
export async function startAttempt(db: Database, claim: ClaimedTask, actor: Actor): Promise<StartResult> {
  return withWorkspace(db, claim.workspaceId, async (tx): Promise<StartResult> => {
    const run = await lockRun(tx, claim.runId);
    const task = await lockLeasedTask(tx, claim.taskId, claim.leaseToken);
    if (run.cancel_requested || isTerminal(run.status)) {
      await cancelLeasedTask(tx, run, task, actor);
      return { started: false, reason: 'cancelled' };
    }
    if (run.pause_requested || run.budget_blocked) {
      await releaseLeasedTask(tx, run, task, actor, 'run paused');
      return { started: false, reason: 'paused' };
    }
    const estimate = TASK_COST_ESTIMATES[TASK_DEFINITIONS[task.type as TaskType].kind];
    const budget = evaluateBudget(
      { budget: runBudget(run), spend: runSpend(run), startedAt: run.started_at },
      estimate,
      new Date(),
    );
    if (!budget.ok) {
      await pauseForBudget(tx, run, task, budget.exhausted, actor);
      return { started: false, reason: 'budget' };
    }
    await appendEvent(tx, run, actor, {
      type: 'task.status_changed',
      refs: { taskId: claim.taskId },
      data: { taskType: task.type as TaskType, from: 'ready', to: 'running', attempt: task.attempt },
    });
    return { started: true, task, run };
  });
}

/** Extends the lease. Reports whether the worker still owns the task and whether the run was cancelled. */
export async function heartbeat(
  db: Database,
  claim: ClaimedTask,
  leaseSeconds: number,
): Promise<'ok' | 'lost' | 'cancelled'> {
  return withWorkspace(db, claim.workspaceId, async (tx) => {
    const extended = await tx
      .updateTable('tasks')
      .set({ lease_expires_at: sql`now() + make_interval(secs => ${leaseSeconds})`, heartbeat_at: sql`now()` })
      .where('id', '=', claim.taskId)
      .where('lease_token', '=', claim.leaseToken)
      .where('status', '=', 'running')
      .returning('run_id')
      .executeTakeFirst();
    if (!extended) return 'lost';
    const run = await tx
      .selectFrom('runs')
      .select('cancel_requested')
      .where('id', '=', extended.run_id)
      .executeTakeFirst();
    return run?.cancel_requested ? 'cancelled' : 'ok';
  });
}

/**
 * Records a handler's outcome in one fenced transaction: domain writes, expansion, the task's new
 * status, promotion of dependents and the run status. If the lease was lost, nothing is written.
 */
export async function completeTask(
  db: Database,
  claim: ClaimedTask,
  outcome: TaskOutcome,
  actor: Actor,
): Promise<void> {
  await withWorkspace(db, claim.workspaceId, async (tx) => {
    const run = await lockRun(tx, claim.runId);
    const task = await lockLeasedTask(tx, claim.taskId, claim.leaseToken);
    if (run.cancel_requested || isTerminal(run.status)) {
      await cancelLeasedTask(tx, run, task, actor);
      return;
    }

    if (outcome.kind === 'awaiting_approval') {
      if (outcome.approvals.length === 0) {
        throw new DomainError('VALIDATION', 'A gate must request at least one approval.');
      }
      await insertApprovals(tx, run, task.id, outcome.approvals, actor);
      await setTaskStatus(tx, run, task, actor, 'waiting_approval', { ...CLEARED_LEASE });
      await recomputeRunStatus(tx, run, actor);
      return;
    }

    const written = outcome.write ? await outcome.write(tx) : {};
    const plan = typeof outcome.expand === 'function' ? outcome.expand(written) : outcome.expand;
    const summary = typeof outcome.summary === 'function' ? outcome.summary() : outcome.summary;
    const taskIds = plan ? await createTasks(tx, run, plan, task.id, 'expansion', actor) : [];
    const output = TaskOutputRef.parse({
      executionId: null,
      created: { ...EMPTY_REFS, ...written, taskIds: [...(written.taskIds ?? []), ...taskIds] },
      summary: summary ?? {},
    });
    await setTaskStatus(tx, run, task, actor, 'succeeded', { output: toJson(output), ...CLEARED_LEASE }, summary);
    await settleRun(tx, run, actor);
    await recomputeRunStatus(tx, run, actor);
  });
}

/**
 * Records a failed attempt. Transient failures with attempts left go back to the queue after a
 * backoff; everything else fails the task, skips its hard dependents and may fail the run.
 */
export async function failTaskAttempt(
  db: Database,
  claim: ClaimedTask,
  failure: Failure,
  actor: Actor,
  options: EngineOptions,
  leaseExpired?: { previousOwner: string },
): Promise<'retry_scheduled' | 'failed' | 'cancelled'> {
  return withWorkspace(db, claim.workspaceId, async (tx) => {
    const run = await lockRun(tx, claim.runId);
    const task = await lockLeasedTask(tx, claim.taskId, claim.leaseToken);
    await abandonOpenExecutions(tx, task.id, failure);
    if (leaseExpired) {
      await appendEvent(tx, run, actor, {
        type: 'task.lease_expired',
        refs: { taskId: claim.taskId },
        data: {
          taskType: task.type as TaskType,
          workerId: leaseExpired.previousOwner.slice(0, 100),
          attempt: Math.max(1, task.attempt),
        },
      });
    }
    if (run.cancel_requested || isTerminal(run.status)) {
      await cancelLeasedTask(tx, run, task, actor);
      return 'cancelled';
    }

    const willRetry = failure.class === 'transient' && task.attempt < task.max_attempts;
    const stored: Failure = { ...failure, retryable: willRetry };
    if (willRetry) {
      const nextAttemptAt = new Date(Date.now() + retryDelayMs(task.attempt, options.retryPolicy));
      await appendEvent(tx, run, actor, {
        type: 'task.retry_scheduled',
        refs: { taskId: claim.taskId },
        data: {
          taskType: task.type as TaskType,
          attempt: Math.max(1, task.attempt),
          nextAttemptAt: nextAttemptAt.toISOString(),
          failure: stored,
        },
      });
      await setTaskStatus(tx, run, task, actor, 'ready', {
        run_after: nextAttemptAt,
        last_failure: toJson(stored),
        ...CLEARED_LEASE,
      });
      return 'retry_scheduled';
    }
    await setTaskStatus(tx, run, task, actor, 'failed', { last_failure: toJson(stored), ...CLEARED_LEASE });
    await settleRun(tx, run, actor);
    await recomputeRunStatus(tx, run, actor);
    return 'failed';
  });
}

/** Graceful shutdown: hand the task back without counting the attempt. */
export async function releaseTask(db: Database, claim: ClaimedTask, reason: string, actor: Actor): Promise<void> {
  await withWorkspace(db, claim.workspaceId, async (tx) => {
    const run = await lockRun(tx, claim.runId);
    const task = await lockLeasedTask(tx, claim.taskId, claim.leaseToken);
    await releaseLeasedTask(tx, run, task, actor, reason);
  });
}

/** The run was cancelled while this task ran: record it as cancelled and discard its results. */
export async function cancelTask(db: Database, claim: ClaimedTask, actor: Actor): Promise<void> {
  await withWorkspace(db, claim.workspaceId, async (tx) => {
    const run = await lockRun(tx, claim.runId);
    const task = await lockLeasedTask(tx, claim.taskId, claim.leaseToken);
    await cancelLeasedTask(tx, run, task, actor);
  });
}

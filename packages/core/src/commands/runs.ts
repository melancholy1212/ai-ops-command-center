import {
  Budget,
  CancelRunCommand,
  CreateRunCommand,
  PauseRunCommand,
  ResumeRunCommand,
  StartRunCommand,
  type RunId,
  type WorkspaceId,
} from '@aoc/contracts';
import { toJson, withWorkspace, type Database } from '@aoc/db';
import { DEFAULT_RUN_BUDGET } from '../budget';
import { cancelRunInTx } from '../engine/cancel';
import { appendEvent } from '../engine/events';
import { createTasks, settleRun } from '../engine/graph';
import { isTerminal, lockRun, recomputeRunStatus } from '../engine/runs';
import { DomainError } from '../errors';
import { initialPlan } from '../workflow/prospect';
import { actorOf, audit, authorize, parseCommand, type UserActor } from './common';

export async function createRun(
  db: Database,
  user: UserActor,
  workspaceId: WorkspaceId,
  input: unknown,
): Promise<RunId> {
  const command = parseCommand(CreateRunCommand, input);
  return withWorkspace(db, workspaceId, async (tx) => {
    await authorize(tx, user, workspaceId, 'createRun');
    const project = await tx.selectFrom('projects').select('id').where('id', '=', command.projectId).executeTakeFirst();
    if (!project) throw new DomainError('NOT_FOUND', 'Project not found.');
    const budget = Budget.parse(command.budget ?? DEFAULT_RUN_BUDGET);
    const run = await tx
      .insertInto('runs')
      .values({
        workspace_id: workspaceId,
        project_id: project.id,
        workflow: 'prospect_research',
        workflow_version: 1,
        objective: command.objective,
        budget: toJson(budget),
        created_by: user.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const actor = actorOf(user);
    await appendEvent(tx, run, actor, { type: 'run.created', data: { objective: command.objective } });
    await audit(tx, workspaceId, actor, 'run.created', { type: 'run', id: run.id });
    return run.id as RunId;
  });
}

/** draft -> planning: creates the initial tasks; the plan task is immediately ready. */
export async function startRun(db: Database, user: UserActor, workspaceId: WorkspaceId, input: unknown) {
  const { runId } = parseCommand(StartRunCommand, input);
  await withWorkspace(db, workspaceId, async (tx) => {
    await authorize(tx, user, workspaceId, 'startRun');
    const run = await lockRun(tx, runId);
    if (run.status !== 'draft') throw new DomainError('INVALID_STATE', `The run is already ${run.status}.`);
    const actor = actorOf(user);
    await createTasks(tx, run, initialPlan(), null, 'run_start', actor);
    await settleRun(tx, run, actor);
    await recomputeRunStatus(tx, run, actor, 'Started by a user.');
    await audit(tx, workspaceId, actor, 'run.started', { type: 'run', id: run.id });
  });
}

export async function cancelRun(db: Database, user: UserActor, workspaceId: WorkspaceId, input: unknown) {
  const command = parseCommand(CancelRunCommand, input);
  await withWorkspace(db, workspaceId, async (tx) => {
    await authorize(tx, user, workspaceId, 'cancelRun');
    const run = await lockRun(tx, command.runId);
    if (isTerminal(run.status)) throw new DomainError('INVALID_STATE', `The run is already ${run.status}.`);
    const actor = actorOf(user);
    await cancelRunInTx(tx, run, actor, command.reason ?? 'Cancelled by a user.');
    await audit(tx, workspaceId, actor, 'run.cancelled', { type: 'run', id: run.id }, { reason: command.reason });
  });
}

/** Stops new tasks from being claimed; tasks already running finish. */
export async function pauseRun(db: Database, user: UserActor, workspaceId: WorkspaceId, input: unknown) {
  const { runId } = parseCommand(PauseRunCommand, input);
  await withWorkspace(db, workspaceId, async (tx) => {
    await authorize(tx, user, workspaceId, 'pauseRun');
    const run = await lockRun(tx, runId);
    if (isTerminal(run.status) || run.status === 'draft') {
      throw new DomainError('INVALID_STATE', `A ${run.status} run cannot be paused.`);
    }
    if (run.pause_requested) return;
    await tx
      .updateTable('runs')
      .set({ pause_requested: true, updated_at: new Date() })
      .where('id', '=', run.id)
      .execute();
    const actor = actorOf(user);
    await recomputeRunStatus(tx, { ...run, pause_requested: true }, actor, 'Paused by a user.');
    await audit(tx, workspaceId, actor, 'run.paused', { type: 'run', id: run.id });
  });
}

/**
 * Clears a user pause. On a run paused for budget it also lets the scheduler try again: the next
 * claim re-checks the budget and, if it is still exhausted, pauses the run and asks for an extension
 * again. That is the way forward after an extension was rejected.
 */
export async function resumeRun(db: Database, user: UserActor, workspaceId: WorkspaceId, input: unknown) {
  const { runId } = parseCommand(ResumeRunCommand, input);
  await withWorkspace(db, workspaceId, async (tx) => {
    await authorize(tx, user, workspaceId, 'resumeRun');
    const run = await lockRun(tx, runId);
    if (isTerminal(run.status)) throw new DomainError('INVALID_STATE', `The run is already ${run.status}.`);
    if (!run.pause_requested && !run.budget_blocked) return;
    await tx
      .updateTable('runs')
      .set({ pause_requested: false, budget_blocked: false, updated_at: new Date() })
      .where('id', '=', run.id)
      .execute();
    const actor = actorOf(user);
    await recomputeRunStatus(
      tx,
      { ...run, pause_requested: false, budget_blocked: false },
      actor,
      'Resumed by a user.',
    );
    await audit(tx, workspaceId, actor, 'run.resumed', { type: 'run', id: run.id });
  });
}

import {
  TASK_DEFINITIONS,
  TaskInput,
  type Actor,
  type DependencyMode,
  type TaskId,
  type TaskStatus,
  type TaskType,
} from '@aoc/contracts';
import { toJson, type DB, type WorkspaceTransaction } from '@aoc/db';
import type { Selectable } from 'kysely';
import { DomainError, LeaseLostError } from '../errors';
import { findCycle } from '../graph';
import { appendEvent } from './events';
import type { RunRow } from './runs';
import type { DependencySpec, ExpansionPlan } from './types';

export type TaskRow = Selectable<DB['tasks']>;

export const CLEARED_LEASE = { lease_owner: null, lease_token: null, lease_expires_at: null } as const;

const TERMINAL: readonly TaskStatus[] = ['succeeded', 'failed', 'skipped', 'cancelled'];
const HARD_BLOCKERS: readonly TaskStatus[] = ['failed', 'skipped', 'cancelled'];

/** Fencing: the task must still be running under exactly this lease, or the caller has lost it. */
export async function lockLeasedTask(tx: WorkspaceTransaction, taskId: string, leaseToken: string): Promise<TaskRow> {
  const task = await tx
    .selectFrom('tasks')
    .selectAll()
    .where('id', '=', taskId)
    .where('lease_token', '=', leaseToken)
    .where('status', '=', 'running')
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!task) throw new LeaseLostError(taskId);
  return task;
}

/**
 * Inserts the plan's tasks (idempotently, by key) and dependency edges, then rejects the whole
 * transaction if the run's graph would contain a cycle. New tasks start blocked; `settleRun`
 * promotes the ones with nothing to wait for.
 */
export async function createTasks(
  tx: WorkspaceTransaction,
  run: RunRow,
  plan: ExpansionPlan,
  parentTaskId: string | null,
  cause: 'run_start' | 'expansion' | 'gap_fill' | 'replan',
  actor: Actor,
): Promise<TaskId[]> {
  const idsByRef = new Map<string, string>();
  const created: TaskId[] = [];

  for (const spec of plan.tasks) {
    const input = TaskInput.parse(spec.input);
    if (input.type !== spec.type) {
      throw new DomainError('VALIDATION', `Task ${spec.ref} has input for ${input.type}, not ${spec.type}.`);
    }
    if (idsByRef.has(spec.ref)) throw new DomainError('VALIDATION', `Duplicate task ref ${spec.ref}.`);
    const definition = TASK_DEFINITIONS[spec.type];
    const inserted = await tx
      .insertInto('tasks')
      .values({
        run_id: run.id,
        workspace_id: run.workspace_id,
        type: spec.type,
        kind: definition.kind,
        status: 'blocked',
        subject_company_id: 'companyId' in input ? input.companyId : null,
        input: toJson(input),
        idempotency_key: spec.idempotencyKey,
        parent_task_id: parentTaskId,
        max_attempts: definition.maxAttempts,
        priority: spec.priority ?? 50,
      })
      .onConflict((oc) => oc.columns(['run_id', 'idempotency_key']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) {
      created.push(inserted.id as TaskId);
      idsByRef.set(spec.ref, inserted.id);
      await appendEvent(tx, run, actor, {
        type: 'task.created',
        refs: { taskId: inserted.id as TaskId },
        data: { taskType: spec.type, cause },
      });
    } else {
      const existing = await tx
        .selectFrom('tasks')
        .select('id')
        .where('run_id', '=', run.id)
        .where('idempotency_key', '=', spec.idempotencyKey)
        .executeTakeFirstOrThrow();
      idsByRef.set(spec.ref, existing.id);
    }
  }

  const resolve = (dep: DependencySpec): string => {
    if ('taskId' in dep) return dep.taskId;
    const id = idsByRef.get(dep.ref);
    if (!id) throw new DomainError('VALIDATION', `Unknown task ref ${dep.ref}.`);
    return id;
  };
  const addEdge = async (taskId: string, dependsOnTaskId: string, mode: DependencyMode) => {
    await tx
      .insertInto('task_dependencies')
      .values({
        task_id: taskId,
        depends_on_task_id: dependsOnTaskId,
        run_id: run.id,
        workspace_id: run.workspace_id,
        mode,
      })
      .onConflict((oc) => oc.columns(['task_id', 'depends_on_task_id']).doNothing())
      .execute();
  };

  for (const spec of plan.tasks) {
    const taskId = idsByRef.get(spec.ref);
    if (!taskId) continue;
    for (const dep of spec.dependsOn ?? []) await addEdge(taskId, resolve(dep), dep.mode);
  }

  // A task may gain dependencies only while blocked (docs/state-machines.md#dependencies).
  for (const { taskId, dependsOn } of plan.addDependencies ?? []) {
    const target = await tx
      .selectFrom('tasks')
      .select('status')
      .where('id', '=', taskId)
      .where('run_id', '=', run.id)
      .executeTakeFirst();
    if (!target) throw new DomainError('NOT_FOUND', `Task ${taskId} is not in this run.`);
    if (target.status !== 'blocked') {
      throw new DomainError(
        'INVALID_STATE',
        `Task ${taskId} is ${target.status}; only blocked tasks can gain dependencies.`,
      );
    }
    for (const dep of dependsOn) await addEdge(taskId, resolve(dep), dep.mode);
  }

  const edges = await tx
    .selectFrom('task_dependencies')
    .select(['task_id as taskId', 'depends_on_task_id as dependsOnTaskId'])
    .where('run_id', '=', run.id)
    .execute();
  const cycle = findCycle(edges);
  if (cycle) throw new DomainError('INVALID_STATE', `The task graph would contain a cycle: ${cycle.join(' -> ')}.`);
  return created;
}

/**
 * Promotes blocked tasks whose dependencies are satisfied and skips those whose hard dependency can
 * no longer succeed, repeating until nothing changes (skips cascade).
 *   hard: the dependency must succeed.  soft: it only has to reach a terminal status.
 */
export async function settleRun(tx: WorkspaceTransaction, run: RunRow, actor: Actor): Promise<void> {
  for (;;) {
    const rows = await tx
      .selectFrom('tasks as t')
      .leftJoin('task_dependencies as d', 'd.task_id', 't.id')
      .leftJoin('tasks as dep', 'dep.id', 'd.depends_on_task_id')
      .select(['t.id as id', 't.type as type', 't.attempt as attempt', 'd.mode as mode', 'dep.status as depStatus'])
      .where('t.run_id', '=', run.id)
      .where('t.status', '=', 'blocked')
      .execute();
    if (rows.length === 0) return;

    const byTask = new Map<string, { type: string; attempt: number; deps: { mode: string; status: string }[] }>();
    for (const row of rows) {
      const entry = byTask.get(row.id) ?? { type: row.type, attempt: row.attempt, deps: [] };
      if (row.mode && row.depStatus) entry.deps.push({ mode: row.mode, status: row.depStatus });
      byTask.set(row.id, entry);
    }

    const ready: string[] = [];
    const skip: string[] = [];
    for (const [id, { deps }] of byTask) {
      if (deps.some((d) => d.mode === 'hard' && HARD_BLOCKERS.includes(d.status as TaskStatus))) skip.push(id);
      else if (
        deps.every((d) => (d.mode === 'hard' ? d.status === 'succeeded' : TERMINAL.includes(d.status as TaskStatus)))
      ) {
        ready.push(id);
      }
    }
    if (ready.length === 0 && skip.length === 0) return;

    const now = new Date();
    if (ready.length > 0) {
      await tx
        .updateTable('tasks')
        .set({ status: 'ready', run_after: now, updated_at: now })
        .where('id', 'in', ready)
        .execute();
    }
    if (skip.length > 0) {
      await tx
        .updateTable('tasks')
        .set({
          status: 'skipped',
          finished_at: now,
          updated_at: now,
          last_failure: toJson({
            code: 'DEPENDENCY_FAILED',
            class: 'policy',
            message: 'A required dependency did not succeed.',
            retryable: false,
            occurredAt: now.toISOString(),
          }),
        })
        .where('id', 'in', skip)
        .execute();
    }
    for (const [ids, to] of [
      [ready, 'ready'],
      [skip, 'skipped'],
    ] as const) {
      for (const id of ids) {
        const task = byTask.get(id);
        if (!task) continue;
        await appendEvent(tx, run, actor, {
          type: 'task.status_changed',
          refs: { taskId: id as TaskId },
          data: { taskType: task.type as TaskType, from: 'blocked', to, attempt: task.attempt },
        });
      }
    }
  }
}

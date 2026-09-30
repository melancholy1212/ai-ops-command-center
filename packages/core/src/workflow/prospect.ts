import { ResearchBrief, TaskInput, WORKFLOW_LIMITS, type Actor, type RunId, type TaskId } from '@aoc/contracts';
import { toJson, type WorkspaceTransaction } from '@aoc/db';
import { cancelRunInTx } from '../engine/cancel';
import { appendEvent } from '../engine/events';
import { createTasks, type TaskRow } from '../engine/graph';
import type { RunRow } from '../engine/runs';
import type { ExpansionPlan } from '../engine/types';
import { DomainError } from '../errors';

/** The tasks a prospect-research run starts with (docs/workflow.md). Everything else comes from expansion. */
export function initialPlan(): ExpansionPlan {
  return {
    tasks: [
      {
        ref: 'plan',
        type: 'plan_run',
        input: { type: 'plan_run', revision: 1, rejectionFeedback: null },
        idempotencyKey: 'plan_run:r1',
        priority: 90,
      },
      {
        ref: 'approve',
        type: 'approve_plan',
        input: { type: 'approve_plan', revision: 1 },
        idempotencyKey: 'approve_plan:r1',
        priority: 90,
        dependsOn: [{ ref: 'plan', mode: 'hard' }],
      },
      {
        ref: 'discover',
        type: 'discover_companies',
        input: { type: 'discover_companies' },
        idempotencyKey: 'discover_companies',
        priority: 80,
        dependsOn: [{ ref: 'approve', mode: 'hard' }],
      },
    ],
  };
}

/**
 * A rejected plan (docs/state-machines.md): create the next plan revision with the reviewer's feedback
 * and re-point the still-blocked discovery task at the new gate. After the maximum number of
 * revisions, the run is cancelled instead.
 */
export async function replanAfterRejection(
  tx: WorkspaceTransaction,
  run: RunRow,
  rejectedGate: TaskRow,
  feedback: string,
  actor: Actor,
): Promise<void> {
  const input = TaskInput.parse(rejectedGate.input);
  if (input.type !== 'approve_plan') throw new DomainError('VALIDATION', 'Only a plan gate can be replanned.');
  if (input.revision >= WORKFLOW_LIMITS.maxPlanRevisions) {
    await cancelRunInTx(tx, run, actor, `The plan was rejected ${String(input.revision)} times.`);
    return;
  }
  const discover = await tx
    .selectFrom('tasks')
    .select('id')
    .where('run_id', '=', run.id)
    .where('type', '=', 'discover_companies')
    .where('status', '=', 'blocked')
    .executeTakeFirst();
  if (!discover) throw new DomainError('INVALID_STATE', 'No blocked discovery task to re-point.');

  await tx
    .deleteFrom('task_dependencies')
    .where('task_id', '=', discover.id)
    .where('depends_on_task_id', '=', rejectedGate.id)
    .execute();
  const next = input.revision + 1;
  await createTasks(
    tx,
    run,
    {
      tasks: [
        {
          ref: 'plan',
          type: 'plan_run',
          input: { type: 'plan_run', revision: next, rejectionFeedback: feedback.slice(0, 2000) },
          idempotencyKey: `plan_run:r${String(next)}`,
          priority: 90,
        },
        {
          ref: 'approve',
          type: 'approve_plan',
          input: { type: 'approve_plan', revision: next },
          idempotencyKey: `approve_plan:r${String(next)}`,
          priority: 90,
          dependsOn: [{ ref: 'plan', mode: 'hard' }],
        },
      ],
      addDependencies: [{ taskId: discover.id as TaskId, dependsOn: [{ ref: 'approve', mode: 'hard' }] }],
    },
    null,
    'replan',
    actor,
  );
}

/**
 * The planner's domain write, run inside plan_run's completion transaction. A run cannot leave
 * planning without a brief (enforced by a CHECK constraint), and a newer revision replaces the old.
 */
export async function saveBrief(
  tx: WorkspaceTransaction,
  run: { id: RunId | string; workspace_id: string },
  brief: ResearchBrief,
  actor: Actor,
): Promise<void> {
  const parsed = ResearchBrief.parse(brief);
  const updated = await tx
    .updateTable('runs')
    .set({ brief: toJson(parsed), updated_at: new Date() })
    .where('id', '=', run.id)
    .returning('id')
    .executeTakeFirst();
  if (!updated) throw new DomainError('NOT_FOUND', 'Run not found.');
  await appendEvent(tx, run, actor, {
    type: 'plan.proposed',
    data: {
      revision: parsed.revision,
      assumptions: parsed.assumptions.length,
      openQuestions: parsed.openQuestions.length,
    },
  });
}

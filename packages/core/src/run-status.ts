import {
  FINAL_TASK_TYPE,
  PLAN_TASK_TYPES,
  TASK_DEFINITIONS,
  TERMINAL_TASK_STATUSES,
  type Failure,
  type PauseReason,
  type RunStatus,
  type TaskStatus,
  type TaskType,
} from '@aoc/contracts';

export interface RunStatusInput {
  cancelRequested: boolean;
  pauseRequested: boolean;
  budgetBlocked: boolean;
  tasks: readonly { type: TaskType; status: TaskStatus; lastFailure: Failure | null }[];
}

export interface DerivedRunStatus {
  status: RunStatus;
  pauseReason: PauseReason | null;
  failure: Failure | null;
}

const ACTIVE_GATE: readonly TaskStatus[] = ['ready', 'running', 'waiting_approval'];
const ACTIVE_WORK: readonly TaskStatus[] = ['ready', 'running'];

/**
 * The run's status is derived, never set by hand: one pure function over the task states and the
 * run's flags, evaluated inside every transaction that changes a task (docs/state-machines.md).
 * The first matching rule wins.
 */
export function deriveRunStatus(input: RunStatusInput, now: Date): DerivedRunStatus {
  const { tasks } = input;
  const is = (status: RunStatus, pauseReason: PauseReason | null = null, failure: Failure | null = null) => ({
    status,
    pauseReason,
    failure,
  });

  if (input.cancelRequested) return is('cancelled');
  if (tasks.length === 0) return is('draft');

  const fatal = tasks.find((t) => t.status === 'failed' && TASK_DEFINITIONS[t.type].fatalOnFailure);
  if (fatal) {
    return is(
      'failed',
      null,
      fatal.lastFailure ?? {
        code: 'INTERNAL_ERROR',
        class: 'transient',
        message: `Task ${fatal.type} failed without a recorded reason.`,
        retryable: false,
        occurredAt: now.toISOString(),
      },
    );
  }
  if (tasks.some((t) => t.type === FINAL_TASK_TYPE && t.status === 'succeeded')) return is('completed');
  if (tasks.every((t) => TERMINAL_TASK_STATUSES.includes(t.status))) {
    return is('failed', null, {
      code: 'DEPENDENCY_FAILED',
      class: 'policy',
      message: 'The workflow ended before its final task could run.',
      retryable: false,
      occurredAt: now.toISOString(),
    });
  }

  if (input.pauseRequested) return is('paused', 'user_requested');
  if (input.budgetBlocked) return is('paused', 'budget_exhausted');
  if (tasks.some((t) => t.type === PLAN_TASK_TYPES.gate && ACTIVE_GATE.includes(t.status))) {
    return is('awaiting_plan_approval');
  }
  if (tasks.some((t) => t.type === PLAN_TASK_TYPES.plan && ACTIVE_WORK.includes(t.status))) return is('planning');
  if (!tasks.some((t) => ACTIVE_WORK.includes(t.status)) && tasks.some((t) => t.status === 'waiting_approval')) {
    return is('paused', 'awaiting_approval');
  }
  return is('running');
}

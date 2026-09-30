import { FAILURE_CLASS, type FailureClass, type FailureCode } from '@aoc/contracts';
import type { BudgetDimension } from './budget';

export type DomainErrorCode =
  'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_STATE' | 'LEASE_LOST' | 'STALE_SNAPSHOT' | 'VALIDATION';

/** A refused command or transition. Messages are safe to show to the user; they contain no secrets. */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Raised when a worker no longer holds the lease it presents (it was reaped, or the task moved on). */
export class LeaseLostError extends DomainError {
  constructor(taskId: string) {
    super('LEASE_LOST', `The lease on task ${taskId} is no longer held by this worker.`);
    this.name = 'LeaseLostError';
  }
}

/** Thrown by task handlers. The code decides whether the scheduler retries. */
export class TaskFailure extends Error {
  readonly failureClass: FailureClass;

  constructor(
    readonly code: FailureCode,
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'TaskFailure';
    this.failureClass = FAILURE_CLASS[code];
  }
}

/**
 * Thrown by a handler whose running attempt found the run budget exhausted. Not a failure: the scheduler
 * hands the task back (attempt not counted) and the run pauses for a budget extension, as when a task
 * would not fit before it started.
 */
export class BudgetExhaustedError extends Error {
  constructor(readonly exhausted: readonly BudgetDimension[]) {
    super(`Budget exhausted: ${exhausted.join(', ')}`);
    this.name = 'BudgetExhaustedError';
  }
}

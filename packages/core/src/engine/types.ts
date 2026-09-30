import type {
  ApprovalSnapshot,
  ApprovalTarget,
  ApprovalType,
  DependencyMode,
  RunId,
  SmallSummary,
  TaskId,
  TaskInput,
  TaskOutputRef,
  TaskType,
  WorkspaceId,
} from '@aoc/contracts';
import type { WorkspaceTransaction } from '@aoc/db';
import type { z } from 'zod';
import type { RetryPolicy } from '../backoff';

/** What `claimNextTask` hands a worker: enough to act on the task, fenced by the lease token. */
export interface ClaimedTask {
  taskId: TaskId;
  workspaceId: WorkspaceId;
  runId: RunId;
  taskType: TaskType;
  attempt: number;
  leaseToken: string;
}

/** A dependency on an existing task, or on a task created in the same expansion (by its local ref). */
export type DependencySpec = { mode: DependencyMode } & ({ taskId: TaskId } | { ref: string });

export interface NewTaskSpec {
  /** Local name, so other specs in the same expansion can depend on it. */
  ref: string;
  type: TaskType;
  input: TaskInput;
  /** Unique per run: re-running the same expansion never duplicates tasks. */
  idempotencyKey: string;
  priority?: number;
  dependsOn?: readonly DependencySpec[];
}

/** New tasks, plus dependencies added to existing blocked tasks (docs/state-machines.md#dependencies). */
export interface ExpansionPlan {
  tasks: readonly NewTaskSpec[];
  addDependencies?: readonly { taskId: TaskId; dependsOn: readonly DependencySpec[] }[];
}

export interface ApprovalRequest {
  type: ApprovalType;
  target: ApprovalTarget;
  /** Identity of what is approved; at most one pending approval per key and run. */
  targetKey: string;
  snapshot: ApprovalSnapshot;
}

export type CreatedRefs = TaskOutputRef['created'];

/**
 * What a task handler returns. Handlers never change workflow state themselves: `write` runs inside
 * the completion transaction (after the lease is verified), and `expand` is applied by the engine.
 */
export type TaskOutcome =
  | {
      kind: 'succeeded';
      summary?: z.infer<typeof SmallSummary>;
      write?: (tx: WorkspaceTransaction) => Promise<Partial<CreatedRefs>>;
      expand?: ExpansionPlan;
    }
  | { kind: 'awaiting_approval'; approvals: readonly ApprovalRequest[] };

export interface EngineOptions {
  retryPolicy: RetryPolicy;
}

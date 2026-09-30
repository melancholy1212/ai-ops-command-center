/**
 * Task: one unit of work in a run's task graph. The tasks table is also the queue:
 * workers claim ready tasks with a lease and complete them in one transaction.
 */
import { z } from 'zod';
import {
  ApprovalId,
  ArtifactId,
  ClaimId,
  CompanyId,
  Count,
  ExecutionId,
  Failure,
  FindingId,
  GapId,
  PersonId,
  RunId,
  SmallSummary,
  SourceId,
  TaskId,
  Timestamp,
  WorkspaceId,
} from './common';

export const TaskType = z.enum([
  'plan_run',
  'approve_plan',
  'discover_companies',
  'profile_company',
  'find_people',
  'verify_entity',
  'gap_fill',
  'rank_and_analyze',
  'draft_outreach',
  'approve_outreach',
  'compile_report',
]);
export type TaskType = z.infer<typeof TaskType>;

export const TaskStatus = z.enum([
  'blocked',
  'ready',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['succeeded', 'failed', 'skipped', 'cancelled'];

/** How a task runs: plain code, one structured model call, a tool-using agent loop, or a human gate. */
export const TaskExecutionKind = z.enum(['code', 'structured_llm', 'agent_loop', 'human_gate']);
export type TaskExecutionKind = z.infer<typeof TaskExecutionKind>;

/** hard: the dependency must succeed. soft: it only has to reach a terminal status. */
export const DependencyMode = z.enum(['hard', 'soft']);
export type DependencyMode = z.infer<typeof DependencyMode>;

export const TaskDependency = z.object({ dependsOnTaskId: TaskId, mode: DependencyMode });
export type TaskDependency = z.infer<typeof TaskDependency>;

/** The token fences completion: a worker whose lease expired cannot commit results. */
export const Lease = z.object({
  owner: z.string().min(1).max(100),
  token: z.uuid(),
  acquiredAt: Timestamp,
  heartbeatAt: Timestamp,
  expiresAt: Timestamp,
});
export type Lease = z.infer<typeof Lease>;

export const TaskSubject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run') }),
  z.object({ kind: z.literal('company'), companyId: CompanyId }),
]);
export type TaskSubject = z.infer<typeof TaskSubject>;

/** Per-type input. Small, validated, and made of references to persisted records, never blobs. */
export const TaskInput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('plan_run'),
    revision: z.int().positive(),
    rejectionFeedback: z.string().max(2000).nullable(),
  }),
  z.object({ type: z.literal('approve_plan'), revision: z.int().positive() }),
  z.object({ type: z.literal('discover_companies') }),
  z.object({ type: z.literal('profile_company'), companyId: CompanyId }),
  z.object({ type: z.literal('find_people'), companyId: CompanyId }),
  z.object({ type: z.literal('verify_entity'), companyId: CompanyId, round: z.union([z.literal(1), z.literal(2)]) }),
  z.object({ type: z.literal('gap_fill'), companyId: CompanyId, gapIds: z.array(GapId).min(1).max(20) }),
  z.object({ type: z.literal('rank_and_analyze') }),
  z.object({
    type: z.literal('draft_outreach'),
    companyId: CompanyId,
    personIds: z.array(PersonId).min(1).max(3),
  }),
  z.object({ type: z.literal('approve_outreach') }),
  z.object({ type: z.literal('compile_report') }),
]);
export type TaskInput = z.infer<typeof TaskInput>;

/** What a task produced: references to persisted records, plus small counters for the UI. */
export const TaskOutputRef = z.object({
  executionId: ExecutionId.nullable(),
  created: z.object({
    companyIds: z.array(CompanyId),
    personIds: z.array(PersonId),
    claimIds: z.array(ClaimId),
    sourceIds: z.array(SourceId),
    gapIds: z.array(GapId),
    findingIds: z.array(FindingId),
    artifactIds: z.array(ArtifactId),
    approvalIds: z.array(ApprovalId),
    taskIds: z.array(TaskId),
  }),
  summary: SmallSummary,
});
export type TaskOutputRef = z.infer<typeof TaskOutputRef>;

const COMPANY_TASKS: readonly TaskType[] = [
  'profile_company',
  'find_people',
  'verify_entity',
  'gap_fill',
  'draft_outreach',
];

export const Task = z
  .object({
    id: TaskId,
    runId: RunId,
    workspaceId: WorkspaceId,
    type: TaskType,
    kind: TaskExecutionKind,
    status: TaskStatus,
    subject: TaskSubject,
    input: TaskInput,
    output: TaskOutputRef.nullable(),
    idempotencyKey: z.string().min(1).max(200),
    parentTaskId: TaskId.nullable(),
    dependsOn: z.array(TaskDependency).max(50),
    attempt: Count,
    maxAttempts: z.int().positive().max(10),
    runAfter: Timestamp,
    lease: Lease.nullable(),
    lastFailure: Failure.nullable(),
    priority: z.int().min(0).max(100),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    startedAt: Timestamp.nullable(),
    finishedAt: Timestamp.nullable(),
  })
  .superRefine((task, ctx) => {
    if (task.input.type !== task.type) {
      ctx.addIssue({ code: 'custom', path: ['input', 'type'], message: 'input.type must equal type' });
    }
    if ((task.status === 'running') !== (task.lease !== null)) {
      ctx.addIssue({ code: 'custom', path: ['lease'], message: 'a lease is held exactly while running' });
    }
    if ((task.status === 'succeeded') !== (task.output !== null)) {
      ctx.addIssue({ code: 'custom', path: ['output'], message: 'output is set exactly when succeeded' });
    }
    if (TERMINAL_TASK_STATUSES.includes(task.status) !== (task.finishedAt !== null)) {
      ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: 'finishedAt is set exactly for terminal tasks' });
    }
    if (task.attempt > task.maxAttempts) {
      ctx.addIssue({ code: 'custom', path: ['attempt'], message: 'attempt cannot exceed maxAttempts' });
    }
    const isCompanyTask = COMPANY_TASKS.includes(task.type);
    if (isCompanyTask !== (task.subject.kind === 'company')) {
      ctx.addIssue({
        code: 'custom',
        path: ['subject'],
        message: 'company tasks have a company subject; run tasks a run subject',
      });
    }
    if (
      task.subject.kind === 'company' &&
      'companyId' in task.input &&
      task.input.companyId !== task.subject.companyId
    ) {
      ctx.addIssue({ code: 'custom', path: ['input', 'companyId'], message: 'input.companyId must match the subject' });
    }
  });
export type Task = z.infer<typeof Task>;

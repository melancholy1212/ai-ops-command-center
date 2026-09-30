/**
 * Run events: the append-only timeline of a run. Each event gets a per-run sequence number in the
 * same transaction as the change it describes, so a reconnecting UI can fetch exactly what it missed.
 * Events narrate; the detail lives in the referenced rows (tasks, executions, calls, claims, approvals).
 */
import { z } from 'zod';
import {
  Actor,
  AgentType,
  ApprovalId,
  ArtifactId,
  ClaimId,
  Count,
  ExecutionId,
  Failure,
  LlmCallId,
  RouteClass,
  RunId,
  Sha256Hex,
  SmallSummary,
  SourceId,
  TaskId,
  Timestamp,
  ToolCallId,
  UsdMicros,
  WorkspaceId,
} from './common';
import { ApprovalType } from './approval';
import { ClaimAttribute, ClaimStatus, VerificationReasonCode } from './claim';
import { ExecutionStatus, LlmStopReason } from './execution';
import { ArtifactKind } from './output';
import { SourceTier } from './provenance';
import { RunStatus } from './run';
import { TaskStatus, TaskType } from './task';
import { ToolErrorCode, ToolName } from './tools';

const EventBase = z.object({
  runId: RunId,
  workspaceId: WorkspaceId,
  seq: z.int().positive(),
  occurredAt: Timestamp,
  actor: Actor,
  refs: z
    .object({
      taskId: TaskId,
      executionId: ExecutionId,
      llmCallId: LlmCallId,
      toolCallId: ToolCallId,
      sourceId: SourceId,
      claimId: ClaimId,
      approvalId: ApprovalId,
      artifactId: ArtifactId,
    })
    .partial(),
});

const event = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  EventBase.extend({ type: z.literal(type), data });

export const RunEvent = z.discriminatedUnion('type', [
  event('run.created', z.object({ objective: z.string().max(4000) })),
  event('run.status_changed', z.object({ from: RunStatus, to: RunStatus, reason: z.string().max(300).nullable() })),
  event('plan.proposed', z.object({ revision: z.int().positive(), assumptions: Count, openQuestions: Count })),
  event(
    'task.created',
    z.object({ taskType: TaskType, cause: z.enum(['run_start', 'expansion', 'gap_fill', 'replan']) }),
  ),
  event(
    'task.status_changed',
    z.object({
      taskType: TaskType,
      from: TaskStatus,
      to: TaskStatus,
      attempt: Count,
      summary: SmallSummary.optional(),
    }),
  ),
  event(
    'task.lease_expired',
    z.object({ taskType: TaskType, workerId: z.string().max(100), attempt: z.int().positive() }),
  ),
  event(
    'task.retry_scheduled',
    z.object({ taskType: TaskType, attempt: z.int().positive(), nextAttemptAt: Timestamp, failure: Failure }),
  ),
  event('execution.started', z.object({ agent: AgentType, attempt: z.int().positive() })),
  event(
    'execution.finished',
    z.object({ agent: AgentType, status: ExecutionStatus, turns: Count, costUsdMicros: UsdMicros }),
  ),
  event(
    'llm.call_completed',
    z.object({
      model: z.string().max(100),
      route: RouteClass,
      inputTokens: Count,
      outputTokens: Count,
      costUsdMicros: UsdMicros,
      latencyMs: Count,
      retryCount: Count,
      stopReason: LlmStopReason,
    }),
  ),
  event(
    'tool.call_completed',
    z.object({
      tool: ToolName,
      ok: z.boolean(),
      errorCode: ToolErrorCode.nullable(),
      latencyMs: Count,
      resultCount: Count.nullable(),
    }),
  ),
  event('source.saved', z.object({ host: z.string().max(253), tier: SourceTier, newSnapshot: z.boolean() })),
  event(
    'claim.status_changed',
    z.object({
      attribute: ClaimAttribute,
      from: ClaimStatus.nullable(),
      to: ClaimStatus,
      reasonCodes: z.array(VerificationReasonCode).max(20),
    }),
  ),
  event('gap.opened', z.object({ attribute: ClaimAttribute })),
  event('gap.resolved', z.object({ attribute: ClaimAttribute, outcome: z.enum(['filled', 'unavailable']) })),
  event('approval.requested', z.object({ approvalType: ApprovalType, snapshotHash: Sha256Hex })),
  event(
    'approval.decided',
    z.object({ approvalType: ApprovalType, decision: z.enum(['approved', 'rejected']), snapshotHash: Sha256Hex }),
  ),
  event('approval.invalidated', z.object({ approvalType: ApprovalType, reason: z.string().max(300) })),
  event(
    'budget.threshold_crossed',
    z.object({
      percent: z.union([z.literal(50), z.literal(80), z.literal(100)]),
      spentUsdMicros: UsdMicros,
      limitUsdMicros: UsdMicros,
    }),
  ),
  event('artifact.created', z.object({ kind: ArtifactKind, version: z.int().positive() })),
]);
export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventType = RunEvent['type'];

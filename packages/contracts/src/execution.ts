/**
 * Agent execution: one attempt of one task by one agent role, with every model call and tool call
 * recorded as it happens. Run -> Task -> AgentExecution -> LlmCall / ToolCall is the trace hierarchy.
 */
import { z } from 'zod';
import {
  AgentType,
  ApiKeyId,
  Count,
  ExecutionId,
  Failure,
  JsonValue,
  LlmCallId,
  McpSessionId,
  RouteClass,
  RunId,
  Sha256Hex,
  SourceId,
  TaskId,
  Timestamp,
  ToolCallId,
  UsdMicros,
  WorkspaceId,
} from './common';
import { ToolErrorCode, ToolName } from './tools';

export const ExecutionStatus = z.enum(['running', 'succeeded', 'failed', 'abandoned']);
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;

export const LlmProviderKind = z.enum(['anthropic', 'openai_compatible']);
export type LlmProviderKind = z.infer<typeof LlmProviderKind>;

export const LlmStopReason = z.enum(['end_turn', 'tool_use', 'max_tokens', 'refusal', 'stop_sequence', 'error']);
export type LlmStopReason = z.infer<typeof LlmStopReason>;

/** not_supported: the provider has no prompt caching or does not report it. */
export const CacheStatus = z.enum(['hit', 'partial', 'miss', 'not_supported']);
export type CacheStatus = z.infer<typeof CacheStatus>;

export const TokenUsage = z.object({
  inputTokens: Count,
  outputTokens: Count,
  /** Null when the provider does not report it reliably. */
  reasoningTokens: Count.nullable(),
  cacheReadTokens: Count.nullable(),
  cacheWriteTokens: Count.nullable(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/** One logical model call. HTTP-level retries inside the call are counted in retryCount, not as extra rows. */
export const LlmCall = z.object({
  id: LlmCallId,
  workspaceId: WorkspaceId,
  runId: RunId,
  taskId: TaskId,
  executionId: ExecutionId,
  seq: Count,
  provider: LlmProviderKind,
  /** The configured provider account, e.g. "anthropic" or "earthruntime". */
  providerAccount: z.string().min(1).max(60),
  model: z.string().min(1).max(100),
  route: RouteClass,
  routingConfigVersion: z.string().min(1).max(40),
  promptVersion: z.string().min(1).max(40),
  requestHash: Sha256Hex,
  usage: TokenUsage,
  cacheStatus: CacheStatus,
  costUsdMicros: UsdMicros,
  latencyMs: Count,
  retryCount: Count,
  stopReason: LlmStopReason,
  failure: Failure.nullable(),
  startedAt: Timestamp,
});
export type LlmCall = z.infer<typeof LlmCall>;

/** A tool call made inside an agent execution, or by an external MCP client inside a session. */
export const ToolCallScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('execution'), runId: RunId, taskId: TaskId, executionId: ExecutionId }),
  z.object({ kind: z.literal('mcp_session'), sessionId: McpSessionId, apiKeyId: ApiKeyId }),
]);
export type ToolCallScope = z.infer<typeof ToolCallScope>;

export const ToolCall = z
  .object({
    id: ToolCallId,
    workspaceId: WorkspaceId,
    scope: ToolCallScope,
    tool: ToolName,
    /** The model's own id for the call (e.g. a tool_use id), used to join with the conversation. */
    modelToolCallId: z.string().max(200).nullable(),
    argumentsHash: Sha256Hex,
    arguments: JsonValue,
    status: z.enum(['ok', 'error']),
    errorCode: ToolErrorCode.nullable(),
    provider: z.string().max(60).nullable(),
    cacheHit: z.boolean(),
    latencyMs: Count,
    upstreamLatencyMs: Count.nullable(),
    costUsdMicros: UsdMicros,
    createdSourceIds: z.array(SourceId).max(20),
    startedAt: Timestamp,
  })
  .superRefine((t, ctx) => {
    if ((t.status === 'error') !== (t.errorCode !== null)) {
      ctx.addIssue({ code: 'custom', path: ['errorCode'], message: 'errorCode is set exactly for failed calls' });
    }
  });
export type ToolCall = z.infer<typeof ToolCall>;

export const ExecutionLimits = z.object({
  maxTurns: z.int().positive().max(50),
  maxToolCalls: Count.max(200),
  maxOutputTokensPerCall: z.int().positive().max(128_000),
  timeoutMs: z.int().positive().max(1_800_000),
});
export type ExecutionLimits = z.infer<typeof ExecutionLimits>;

export const AgentExecution = z
  .object({
    id: ExecutionId,
    workspaceId: WorkspaceId,
    runId: RunId,
    taskId: TaskId,
    agent: AgentType,
    agentVersion: z.string().min(1).max(40),
    promptHash: Sha256Hex,
    attempt: z.int().positive(),
    status: ExecutionStatus,
    /** Validated against the agent's input schema before the execution starts. */
    input: JsonValue,
    /** Validated against the agent's output schema; null until it succeeds. */
    output: JsonValue.nullable(),
    limits: ExecutionLimits,
    usage: z.object({
      turns: Count,
      llmCalls: Count,
      toolCalls: Count,
      inputTokens: Count,
      outputTokens: Count,
      costUsdMicros: UsdMicros,
    }),
    retryOf: ExecutionId.nullable(),
    failure: Failure.nullable(),
    startedAt: Timestamp,
    endedAt: Timestamp.nullable(),
  })
  .superRefine((e, ctx) => {
    if ((e.status === 'running') !== (e.endedAt === null)) {
      ctx.addIssue({ code: 'custom', path: ['endedAt'], message: 'endedAt is set exactly for finished executions' });
    }
    if ((e.status === 'succeeded') !== (e.output !== null)) {
      ctx.addIssue({ code: 'custom', path: ['output'], message: 'output is set exactly when succeeded' });
    }
    if ((e.status === 'failed' || e.status === 'abandoned') !== (e.failure !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'failure is set exactly for failed or abandoned executions',
      });
    }
  });
export type AgentExecution = z.infer<typeof AgentExecution>;

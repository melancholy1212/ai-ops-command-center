/**
 * Persists an agent execution as it happens (docs/observability.md): the execution row, every conversation
 * message, every model call with its tokens, cost and latency, and the run's spend in the same transaction
 * as the call. Tool calls are recorded by the MCP server.
 */
import type { AgentType, ExecutionLimits, Failure, LlmCallId, RouteClass } from '@aoc/contracts';
import { recordSpendInTx, type ClaimedTask } from '@aoc/core';
import { toJson, withWorkspace, type Database, type WorkspaceTransaction } from '@aoc/db';
import { costUsdMicros, type LlmResponse, type ModelBinding } from '@aoc/llm';
import type { LoopRecorder } from './loop';

export interface ExecutionStart {
  agent: AgentType;
  agentVersion: string;
  promptHash: string;
  input: unknown;
  limits: ExecutionLimits;
}

export interface LlmCallRecord {
  callId: LlmCallId;
  binding: ModelBinding;
  route: RouteClass;
  routingConfigVersion: string;
  promptVersion: string;
  requestHash: string;
  startedAt: Date;
  response: LlmResponse | null;
  failure: Failure | null;
  latencyMs: number;
  retryCount: number;
}

export class ExecutionRecorder implements LoopRecorder {
  private messageSeq = 0;
  private llmSeq = 0;
  private readonly usage = { turns: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, costUsdMicros: 0 };

  private constructor(
    private readonly db: Database,
    readonly claim: ClaimedTask,
    readonly executionId: string,
  ) {}

  static async start(db: Database, claim: ClaimedTask, start: ExecutionStart): Promise<ExecutionRecorder> {
    const row = await withWorkspace(db, claim.workspaceId, (tx) =>
      tx
        .insertInto('agent_executions')
        .values({
          workspace_id: claim.workspaceId,
          run_id: claim.runId,
          task_id: claim.taskId,
          agent: start.agent,
          agent_version: start.agentVersion,
          prompt_hash: start.promptHash,
          attempt: claim.attempt,
          lease_token: claim.leaseToken,
          input: toJson(start.input),
          limits: toJson(start.limits),
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    return new ExecutionRecorder(db, claim, row.id);
  }

  get costUsdMicros(): number {
    return this.usage.costUsdMicros;
  }

  async message(role: 'system' | 'user' | 'assistant' | 'tool', content: unknown): Promise<void> {
    this.messageSeq += 1;
    const seq = this.messageSeq;
    await withWorkspace(this.db, this.claim.workspaceId, (tx) =>
      tx
        .insertInto('agent_messages')
        .values({
          execution_id: this.executionId,
          seq,
          workspace_id: this.claim.workspaceId,
          role,
          content: toJson(content),
        })
        .execute(),
    );
  }

  async llmCall(call: LlmCallRecord, countsAsTurn: boolean): Promise<void> {
    const seq = this.llmSeq;
    this.llmSeq += 1;
    const usage = call.response?.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    };
    const cost = call.response ? costUsdMicros(call.binding.model, usage) : 0;
    this.usage.llmCalls += 1;
    if (countsAsTurn) this.usage.turns += 1;
    this.usage.inputTokens += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    this.usage.outputTokens += usage.outputTokens;
    this.usage.costUsdMicros += cost;
    await withWorkspace(this.db, this.claim.workspaceId, async (tx) => {
      await tx
        .insertInto('llm_calls')
        .values({
          id: call.callId,
          workspace_id: this.claim.workspaceId,
          run_id: this.claim.runId,
          task_id: this.claim.taskId,
          execution_id: this.executionId,
          seq,
          provider: call.binding.providerKind,
          provider_account: call.binding.providerAccount,
          model: call.binding.model,
          route: call.route,
          routing_config_version: call.routingConfigVersion,
          prompt_version: call.promptVersion,
          request_hash: call.requestHash,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          reasoning_tokens: usage.reasoningTokens,
          cache_read_tokens: usage.cacheReadTokens,
          cache_write_tokens: usage.cacheWriteTokens,
          cache_status: call.response?.cacheStatus ?? 'not_supported',
          cost_usd_micros: cost,
          latency_ms: call.latencyMs,
          retry_count: call.retryCount,
          stop_reason: call.response?.stopReason ?? 'error',
          failure: call.failure ? toJson(call.failure) : null,
          started_at: call.startedAt,
        })
        .execute();
      await this.writeUsage(tx);
      // Spend includes failed and repaired calls: it is what the provider bills.
      await recordSpendInTx(
        tx,
        this.claim.runId,
        {
          llmInputTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
          llmOutputTokens: usage.outputTokens,
          costUsdMicros: cost,
        },
        { kind: 'worker', workerId: 'agent-runtime' },
      );
    });
  }

  async toolCalls(count: number): Promise<void> {
    await withWorkspace(this.db, this.claim.workspaceId, (tx) =>
      tx.updateTable('agent_executions').set({ tool_calls: count }).where('id', '=', this.executionId).execute(),
    );
  }

  /** Called inside the task's completion transaction, so the execution succeeds exactly when the task does. */
  async succeedInTx(tx: WorkspaceTransaction, output: unknown): Promise<void> {
    await tx
      .updateTable('agent_executions')
      .set({ status: 'succeeded', output: toJson(output), ended_at: new Date() })
      .where('id', '=', this.executionId)
      .where('status', '=', 'running')
      .execute();
    await this.writeUsage(tx);
  }

  async fail(failure: Failure): Promise<void> {
    await withWorkspace(this.db, this.claim.workspaceId, async (tx) => {
      await tx
        .updateTable('agent_executions')
        .set({ status: 'failed', failure: toJson(failure), ended_at: new Date() })
        .where('id', '=', this.executionId)
        .where('status', '=', 'running')
        .execute();
      await this.writeUsage(tx);
    });
  }

  private async writeUsage(tx: WorkspaceTransaction) {
    await tx
      .updateTable('agent_executions')
      .set({
        turns: this.usage.turns,
        llm_calls: this.usage.llmCalls,
        input_tokens: this.usage.inputTokens,
        output_tokens: this.usage.outputTokens,
        cost_usd_micros: this.usage.costUsdMicros,
      })
      .where('id', '=', this.executionId)
      .execute();
  }
}

/**
 * The bounded tool loop (docs/agents.md#the-tool-loop). Code owns control flow: the model chooses tool calls
 * and eventually a result; the loop enforces the tool allowlist, turn, tool-call, time and budget limits,
 * gets a result out of a model that stops without one, and validates it (with up to 2 repair turns).
 * Every turn is persisted as it happens; history is append-only.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AgentType, ExecutionLimits, LlmCallId, RouteClass, ToolName } from '@aoc/contracts';
import { BudgetExhaustedError, makeFailure, TaskFailure, type BudgetDimension } from '@aoc/core';
import {
  capabilitiesOf,
  LlmCallError,
  requestHash,
  toJsonSchema,
  type ConversationMessage,
  type LlmRequest,
  type LlmResponse,
  type LlmRouter,
  type ModelBinding,
  type ToolChoice,
  type ToolResult,
  type ToolSpec,
} from '@aoc/llm';
import type { z } from 'zod';
import type { ClaimedTask } from '@aoc/core';
import type { LlmCallRecord } from './recorder';
import type { ToolClient, ToolOutcome } from './tool-client';

export const SUBMIT_TOOL = 'submit_result';
export const MAX_REPAIRS = 2;

/** What the loop learned while running, for validators that check the result against what was seen. */
export interface LoopObservations {
  /** Sources the model actually read through fetch_page or get_source in this execution. */
  sourceIds: ReadonlySet<string>;
}

/** An agent role is code: purpose, schemas, tools, route, limits, prompt (docs/agents.md). */
export interface AgentRole<I, O> {
  agent: AgentType;
  /** Also the prompt version recorded on every model call. */
  version: string;
  route: RouteClass;
  tools: readonly ToolName[];
  limits: ExecutionLimits;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  system: string;
  taskMessage(input: I): string;
  /** Checks beyond the schema; each message becomes part of a repair turn. */
  validate?(output: O, seen: LoopObservations): string[];
}

export function promptHash(role: AgentRole<unknown, unknown>): string {
  return createHash('sha256').update(`${role.version}\n${role.system}`).digest('hex');
}

/** What the loop persists through; the database-backed ExecutionRecorder implements it. */
export interface LoopRecorder {
  readonly claim: ClaimedTask;
  readonly executionId: string;
  message(role: 'system' | 'user' | 'assistant' | 'tool', content: unknown): Promise<void>;
  llmCall(call: LlmCallRecord, countsAsTurn: boolean): Promise<void>;
  toolCalls(count: number): Promise<void>;
}

export interface ToolLoopOptions<I, O> {
  role: AgentRole<I, O>;
  input: I;
  router: LlmRouter;
  tools: ToolClient;
  recorder: LoopRecorder;
  /** Called before every model call; returns the exhausted budget dimensions, if any. */
  checkBudget: () => Promise<readonly BudgetDimension[]>;
  signal: AbortSignal;
  now?: () => number;
}

/** Tool results reach the model as JSON data. Page text is kept; bulky metadata is trimmed. */
function forModel(name: string, outcome: ToolOutcome): string {
  if (!outcome.ok)
    return JSON.stringify({
      error: { code: outcome.error.code, message: outcome.error.message, retryable: outcome.error.retryable },
    });
  const rest: Record<string, unknown> = { ...outcome.output };
  delete rest.provenance;
  if (name === 'fetch_page' && Array.isArray(rest.links)) {
    return JSON.stringify({ ...rest, links: (rest.links as unknown[]).slice(0, 40) });
  }
  return JSON.stringify(rest);
}

/** What is stored in agent_messages: page text by reference to the snapshot, not as a copy. */
function forLog(name: string, callId: string, outcome: ToolOutcome): unknown {
  if (!outcome.ok) return { toolCallId: callId, name, ok: false, error: outcome.error };
  const output = outcome.output;
  if (
    (name === 'fetch_page' || name === 'get_source') &&
    typeof output.sourceId === 'string' &&
    typeof output.text === 'string'
  ) {
    return {
      toolCallId: callId,
      name,
      ok: true,
      source: {
        sourceId: output.sourceId,
        offset: output.offset,
        length: output.text.length,
        totalChars: output.totalChars,
      },
      links: Array.isArray(output.links) ? output.links.length : 0,
    };
  }
  return { toolCallId: callId, name, ok: true, output };
}

function describe(issues: readonly { path: PropertyKey[]; message: string }[]): string[] {
  return issues.slice(0, 20).map((i) => `${i.path.map(String).join('.') || 'result'}: ${i.message}`);
}

function toTaskFailure(error: LlmCallError): TaskFailure {
  if (error.kind === 'rate_limited') return new TaskFailure('PROVIDER_RATE_LIMITED', error.message);
  if (error.kind === 'unavailable') return new TaskFailure('PROVIDER_UNAVAILABLE', error.message);
  return new TaskFailure('INTERNAL_ERROR', `Model call refused: ${error.message}`, { kind: error.kind });
}

export async function runToolLoop<I, O>(options: ToolLoopOptions<I, O>): Promise<O> {
  const { role, router, tools, recorder, signal } = options;
  const now = options.now ?? Date.now;
  const input = role.input.parse(options.input);
  const deadline = now() + role.limits.timeoutMs;
  const allowed = tools.tools.filter((t) => role.tools.includes(t.name as ToolName));
  const allowedNames = new Set(allowed.map((t) => t.name));
  const submit: ToolSpec = {
    name: SUBMIT_TOOL,
    description: 'Submit your final result. Call it exactly once, when you are done; the schema is enforced.',
    inputSchema: toJsonSchema(role.output),
  };
  /** Tools that reported they cannot work in this execution (e.g. no provider configured); no longer offered. */
  const unavailable = new Set<string>();
  const modelTools = () => [...allowed.filter((t) => !unavailable.has(t.name)), submit];
  const messages: ConversationMessage[] = [{ role: 'user', content: role.taskMessage(input) }];
  const seenSources = new Set<string>();
  let turns = 0;
  let toolCallsUsed = 0;
  let repairs = 0;
  let nudged = false;
  let forceSubmit = false;

  await recorder.message('system', { text: role.system, tools: modelTools().map((t) => t.name) });
  await recorder.message('user', { text: messages[0]?.role === 'user' ? messages[0].content : '' });

  const call = async (
    toolChoice: ToolChoice,
    responseFormat?: LlmRequest['responseFormat'],
  ): Promise<{ response: LlmResponse; binding: ModelBinding }> => {
    if (signal.aborted) throw signal.reason;
    const exhausted = await options.checkBudget();
    if (exhausted.length > 0) throw new BudgetExhaustedError(exhausted);
    const callId = randomUUID() as LlmCallId;
    const request: Omit<LlmRequest, 'binding'> = {
      system: role.system,
      messages: [...messages],
      tools: responseFormat ? [] : modelTools(),
      toolChoice: responseFormat ? { type: 'none' } : toolChoice,
      ...(responseFormat ? { responseFormat } : {}),
      maxOutputTokens: role.limits.maxOutputTokensPerCall,
      telemetry: {
        runId: recorder.claim.runId,
        taskId: recorder.claim.taskId,
        executionId: recorder.executionId as LlmRequest['telemetry']['executionId'],
        callId,
        route: role.route,
        promptVersion: role.version,
      },
    };
    const startedAt = new Date();
    const clock = performance.now();
    try {
      const { response, binding, routingConfigVersion } = await router.generate(role.route, request, signal);
      await recorder.llmCall(
        {
          callId,
          binding,
          route: role.route,
          routingConfigVersion,
          promptVersion: role.version,
          requestHash: requestHash({ ...request, binding }),
          startedAt,
          response,
          failure: null,
          latencyMs: response.latencyMs,
          retryCount: response.retryCount,
        },
        true,
      );
      return { response, binding };
    } catch (error) {
      if (!(error instanceof LlmCallError) || error.kind === 'aborted') throw error;
      const binding = router.candidates(role.route)[0];
      const failure = toTaskFailure(error);
      if (binding) {
        await recorder.llmCall(
          {
            callId,
            binding,
            route: role.route,
            routingConfigVersion: router.routingConfigVersion,
            promptVersion: role.version,
            requestHash: requestHash({ ...request, binding }),
            startedAt,
            response: null,
            failure: makeFailure(failure.code, failure.message, false),
            latencyMs: Math.round(performance.now() - clock),
            retryCount: error.retryCount,
          },
          false,
        );
      }
      throw failure;
    }
  };

  const validate = (candidate: unknown): { ok: true; value: O } | { ok: false; problems: string[] } => {
    const parsed = role.output.safeParse(candidate);
    if (!parsed.success) return { ok: false, problems: describe(parsed.error.issues) };
    const problems = role.validate?.(parsed.data, { sourceIds: seenSources }) ?? [];
    return problems.length > 0 ? { ok: false, problems } : { ok: true, value: parsed.data };
  };

  /** Last resort for models without forced tool choice: one schema-constrained answer without tools. */
  const finish = async (why: string): Promise<O> => {
    messages.push({
      role: 'user',
      content: [why, 'Reply with your final result as JSON matching the schema.'].filter(Boolean).join(' '),
    });
    await recorder.message('user', { text: 'final structured answer' });
    const { response: final } = await call({ type: 'none' }, { name: 'result', schema: submit.inputSchema });
    let candidate: unknown;
    try {
      candidate = JSON.parse(final.text ?? '');
    } catch {
      throw new TaskFailure('LLM_OUTPUT_INVALID', 'The final answer was not valid JSON.');
    }
    const checked = validate(candidate);
    if (checked.ok) return checked.value;
    throw new TaskFailure(
      'LLM_OUTPUT_INVALID',
      `The final answer failed validation: ${checked.problems.join('; ').slice(0, 500)}`,
    );
  };

  let lastBinding: ModelBinding | undefined = router.candidates(role.route)[0];
  let finalTurn = false;
  for (;;) {
    if (finalTurn) {
      throw new TaskFailure('AGENT_LIMIT_REACHED', `Stopped after ${String(turns)} turns without a valid result.`);
    }
    // The last turn is reserved for the result, so reaching the limit never throws away what was found.
    if (turns >= role.limits.maxTurns - 1 || now() > deadline) {
      finalTurn = true;
      if (lastBinding && !capabilitiesOf(lastBinding.model).forcedToolChoice)
        return finish('You have used all your turns.');
      forceSubmit = true;
      messages.push({
        role: 'user',
        content: `You have used all your turns. Call ${SUBMIT_TOOL} now, including every claim you can support with quotes from the pages you already read.`,
      });
      await recorder.message('user', { text: 'final turn' });
    }
    const { response, binding } = await call(forceSubmit ? { type: 'tool', name: SUBMIT_TOOL } : { type: 'auto' });
    lastBinding = binding;
    turns += 1;
    messages.push({
      role: 'assistant',
      text: response.text,
      toolCalls: response.toolCalls,
      providerContent: response.providerContent,
      providerKind: binding.providerKind,
    });
    await recorder.message('assistant', {
      text: response.text,
      toolCalls: response.toolCalls,
      stopReason: response.stopReason,
    });

    if (response.stopReason === 'refusal') throw new TaskFailure('LLM_REFUSAL', 'The model declined the task.');
    if (response.toolCalls.length === 0) {
      if (response.stopReason === 'max_tokens')
        throw new TaskFailure('LLM_TRUNCATED', 'The model ran out of output tokens.');
      if (!nudged) {
        nudged = true;
        messages.push({
          role: 'user',
          content: `You have not submitted a result. Call ${SUBMIT_TOOL} now with what you have found; an empty list is a valid result.`,
        });
        await recorder.message('user', { text: 'nudge' });
        continue;
      }
      if (!forceSubmit && capabilitiesOf(binding.model).forcedToolChoice) {
        forceSubmit = true;
        messages.push({ role: 'user', content: `Call ${SUBMIT_TOOL} now.` });
        await recorder.message('user', { text: 'force submit' });
        continue;
      }
      return finish('');
    }

    const results: ToolResult[] = [];
    const logged: unknown[] = [];
    let submitted: { ok: true; value: O } | { ok: false; problems: string[] } | null = null;
    const work = response.toolCalls.map(async (toolCall): Promise<void> => {
      const push = (outcome: ToolOutcome) => {
        results.push({
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: forModel(toolCall.name, outcome),
          isError: !outcome.ok,
        });
        logged.push(forLog(toolCall.name, toolCall.id, outcome));
      };
      const refuse = (code: 'TOOL_NOT_PERMITTED' | 'BUDGET_EXCEEDED' | 'INVALID_ARGUMENT', message: string) => {
        push({ ok: false, error: { code, message, retryable: false, retryAfterMs: null } });
      };
      let args: unknown;
      try {
        args = JSON.parse(toolCall.argumentsJson);
      } catch {
        refuse('INVALID_ARGUMENT', 'The arguments were not valid JSON.');
        return;
      }
      if (toolCall.name === SUBMIT_TOOL) {
        submitted ??= validate(args);
        if (!submitted.ok)
          refuse('INVALID_ARGUMENT', `Result rejected: ${submitted.problems.join('; ').slice(0, 1500)}`);
        else push({ ok: true, output: { accepted: true } });
        return;
      }
      if (!allowedNames.has(toolCall.name)) {
        refuse('TOOL_NOT_PERMITTED', `${toolCall.name} is not one of your tools.`);
        return;
      }
      if (unavailable.has(toolCall.name)) {
        refuse('TOOL_NOT_PERMITTED', `${toolCall.name} is unavailable in this task; work with your other tools.`);
        return;
      }
      if (toolCallsUsed >= role.limits.maxToolCalls) {
        refuse('BUDGET_EXCEEDED', `Tool budget used up. Call ${SUBMIT_TOOL} with what you have.`);
        return;
      }
      toolCallsUsed += 1;
      const outcome = await tools.call(toolCall.name, args, toolCall.id, signal);
      if (outcome.ok && typeof outcome.output.sourceId === 'string') seenSources.add(outcome.output.sourceId);
      if (!outcome.ok && outcome.error.code === 'PROVIDER_UNAVAILABLE' && !outcome.error.retryable)
        unavailable.add(toolCall.name);
      push(outcome);
    });
    await Promise.all(work);
    // Results go back in the order the model asked for them.
    const order = new Map(response.toolCalls.map((c, i) => [c.id, i]));
    results.sort((a, b) => (order.get(a.toolCallId) ?? 0) - (order.get(b.toolCallId) ?? 0));
    await recorder.toolCalls(toolCallsUsed);

    const verdict = submitted as { ok: true; value: O } | { ok: false; problems: string[] } | null;
    if (verdict?.ok) {
      await recorder.message('tool', logged);
      return verdict.value;
    }
    if (verdict) {
      repairs += 1;
      if (repairs > MAX_REPAIRS) {
        await recorder.message('tool', logged);
        throw new TaskFailure(
          'LLM_OUTPUT_INVALID',
          `The result failed validation after ${String(MAX_REPAIRS)} repairs: ${verdict.problems.join('; ').slice(0, 400)}`,
        );
      }
    }
    messages.push({ role: 'tool', results });
    await recorder.message('tool', logged);
  }
}

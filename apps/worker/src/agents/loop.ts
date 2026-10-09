/**
 * The bounded tool loop (docs/agents.md#the-tool-loop). Code owns control flow: the model chooses tool calls
 * and eventually a result; the loop enforces the tool allowlist, turn, tool-call, time and budget limits,
 * gets a result out of a model that stops without one, and validates it (with up to 2 repair turns).
 * Every turn is persisted as it happens; history is append-only.
 */
import { createHash } from 'node:crypto';
import type { AgentType, ExecutionLimits, RouteClass, ToolName } from '@aoc/contracts';
import { canonicalJson, TaskFailure, type BudgetDimension, type ClaimedTask } from '@aoc/core';
import {
  capabilitiesOf,
  toJsonSchema,
  type ConversationMessage,
  type LlmRequest,
  type LlmRouter,
  type ModelBinding,
  type ToolChoice,
  type ToolResult,
  type ToolSpec,
} from '@aoc/llm';
import type { z } from 'zod';
import { callModel, type ModelCaller } from './model';
import type { LlmCallRecord } from './recorder';
import type { ToolClient, ToolOutcome } from './tool-client';

export const SUBMIT_TOOL = 'submit_result';
export const MAX_REPAIRS = 2;

/** What the loop learned while running, for validators that check the result against what was seen. */
export interface LoopObservations {
  /** Sources the model actually read through fetch_page or get_source in this execution. */
  sourceIds: ReadonlySet<string>;
  /** Per tool: successful and failed calls, and results returned (the length of an output `results` array). */
  tools: ReadonlyMap<string, ToolStats>;
  /**
   * Whether an advisory check may send the result back: only the first submission, with turns and tool calls
   * left to act on it. Advisory checks never turn an honest result into a failure.
   */
  canSendBack: boolean;
}

/**
 * Code-enforced pacing: after `maxConsecutive` calls of `tool` without a successful call of one of `resetBy`,
 * the tool is withheld (not offered, refused if called) until one succeeds, and the model is told why.
 */
export interface ToolStats {
  calls: number;
  failures: number;
  results: number;
}

export interface ToolPacing {
  tool: ToolName;
  maxConsecutive: number;
  resetBy: readonly ToolName[];
  message: string;
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
  pacing?: ToolPacing;
  /** Checks beyond the schema; each message becomes part of a repair turn. */
  validate?(output: O, seen: LoopObservations, input: I): string[];
  /**
   * When no repair turn is left: the valid part of a schema-valid result that failed `validate`. Invalid items
   * are dropped, never rewritten, and every drop is reported. Null when nothing valid is left, so a failed
   * result is never passed off as an empty one.
   */
  salvage?(output: O, seen: LoopObservations, input: I): { value: O; dropped: string[] } | null;
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

/** Search snippets in the conversation: every later turn resends them, so they are kept short. */
export const SNIPPET_CHARS_FOR_MODEL = 300;

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
  if (name === 'web_search' && Array.isArray(rest.results)) {
    // Snippets only help choose what to open; they are not evidence. The full results stay in the logs.
    const results = (rest.results as Record<string, unknown>[]).map((result) => {
      const shown: Record<string, unknown> = { ...result };
      delete shown.discoveredUrlId;
      if (typeof result.snippet === 'string') {
        const chars = Array.from(result.snippet);
        shown.snippet =
          chars.length > SNIPPET_CHARS_FOR_MODEL
            ? `${chars.slice(0, SNIPPET_CHARS_FOR_MODEL).join('')}…`
            : result.snippet;
      }
      return shown;
    });
    return JSON.stringify({ ...rest, results });
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
  const pacing = role.pacing;
  /** Calls of the paced tool since one of its reset tools last succeeded. */
  let paced = 0;
  const withheld = (name: string) => pacing?.tool === name && paced >= pacing.maxConsecutive;
  const modelTools = () => [...allowed.filter((t) => !unavailable.has(t.name) && !withheld(t.name)), submit];
  const messages: ConversationMessage[] = [{ role: 'user', content: role.taskMessage(input) }];
  const seenSources = new Set<string>();
  /** Calls already made (tool + canonical arguments): an exact repeat returns nothing new. */
  const madeCalls = new Set<string>();
  const seenTools = new Map<string, ToolStats>();
  let turns = 0;
  let toolCallsUsed = 0;
  let repairs = 0;
  let nudged = false;
  let forceSubmit = false;

  await recorder.message('system', { text: role.system, tools: modelTools().map((t) => t.name) });
  await recorder.message('user', { text: messages[0]?.role === 'user' ? messages[0].content : '' });

  const caller: ModelCaller = {
    route: role.route,
    promptVersion: role.version,
    system: role.system,
    maxOutputTokens: role.limits.maxOutputTokensPerCall,
    router,
    recorder,
    checkBudget: options.checkBudget,
    signal,
  };
  const call = (toolChoice: ToolChoice, responseFormat?: LlmRequest['responseFormat']) =>
    responseFormat
      ? callModel(caller, messages, [], { type: 'none' }, responseFormat)
      : callModel(caller, messages, modelTools(), toolChoice);

  type Checked = { ok: true; value: O } | { ok: false; problems: string[]; parsed?: O };
  const validate = (candidate: unknown, canSendBack: boolean): Checked => {
    const parsed = role.output.safeParse(candidate);
    if (!parsed.success) return { ok: false, problems: describe(parsed.error.issues) };
    const problems =
      role.validate?.(parsed.data, { sourceIds: seenSources, tools: seenTools, canSendBack }, input) ?? [];
    return problems.length > 0 ? { ok: false, problems, parsed: parsed.data } : { ok: true, value: parsed.data };
  };

  /** Last chance only: keep what is valid, record what was dropped. */
  const salvage = async (checked: Checked): Promise<O | null> => {
    if (checked.ok || checked.parsed === undefined || !role.salvage) return null;
    const kept = role.salvage(checked.parsed, { sourceIds: seenSources, tools: seenTools, canSendBack: false }, input);
    if (!kept) return null;
    const recheck = validate(kept.value, false);
    if (!recheck.ok) return null;
    await recorder.message('tool', { salvaged: true, dropped: kept.dropped.slice(0, 50) });
    return recheck.value;
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
    const checked = validate(candidate, false);
    if (checked.ok) return checked.value;
    const kept = await salvage(checked);
    if (kept !== null) return kept;
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
          // Early stops are often premature (one failed page, then silence): invite more work, or the result.
          content: `You stopped without calling a tool. If there are promising results you have not opened, open them; if a page failed, try another or search with different words. When you are done, call ${SUBMIT_TOOL}; an empty list is a valid result.`,
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
    const pausedBefore = pacing !== undefined && withheld(pacing.tool);
    let submitted: Checked | null = null;
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
        submitted ??= validate(args, repairs === 0 && !finalTurn && toolCallsUsed < role.limits.maxToolCalls);
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
      const callKey = `${toolCall.name}\n${canonicalJson(args)}`;
      if (madeCalls.has(callKey)) {
        refuse(
          'INVALID_ARGUMENT',
          'You already made this exact call and its result is above. Use it, open a different result, or change the query.',
        );
        return;
      }
      if (withheld(toolCall.name)) {
        refuse('TOOL_NOT_PERMITTED', pacing?.message ?? `${toolCall.name} is paused.`);
        return;
      }
      if (toolCallsUsed >= role.limits.maxToolCalls) {
        refuse('BUDGET_EXCEEDED', `Tool budget used up. Call ${SUBMIT_TOOL} with what you have.`);
        return;
      }
      toolCallsUsed += 1;
      // Counted before the call (these checks run synchronously in request order), so parallel calls in one
      // turn cannot all slip past the limit.
      if (pacing?.tool === toolCall.name) paced += 1;
      madeCalls.add(callKey);
      const outcome = await tools.call(toolCall.name, args, toolCall.id, signal);
      // A paced call that found nothing (failed, or no results) leaves nothing to open: it does not count, or two
      // empty searches would pause search with nothing to read and strand the model (seen live).
      const foundNothing =
        !outcome.ok || (Array.isArray(outcome.output.results) && outcome.output.results.length === 0);
      if (pacing?.tool === toolCall.name && foundNothing) paced = Math.max(0, paced - 1);
      // A failed call may be worth repeating (the error can be transient), so only successes count as made.
      if (!outcome.ok) madeCalls.delete(callKey);
      const newSource =
        outcome.ok && typeof outcome.output.sourceId === 'string' && !seenSources.has(outcome.output.sourceId);
      const stats = seenTools.get(toolCall.name) ?? { calls: 0, failures: 0, results: 0 };
      if (!outcome.ok) seenTools.set(toolCall.name, { ...stats, failures: stats.failures + 1 });
      if (outcome.ok) {
        const found = outcome.output.results;
        seenTools.set(toolCall.name, {
          ...stats,
          calls: stats.calls + 1,
          results: stats.results + (Array.isArray(found) ? found.length : 0),
        });
        // Only a page not read before lifts the pause: re-reading a known source must not reopen search.
        if (newSource && pacing?.resetBy.includes(toolCall.name as ToolName)) paced = 0;
      }
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

    const verdict = submitted as Checked | null;
    if (verdict?.ok) {
      await recorder.message('tool', logged);
      return verdict.value;
    }
    if (verdict) {
      repairs += 1;
      if (finalTurn || repairs > MAX_REPAIRS) {
        await recorder.message('tool', logged);
        const kept = await salvage(verdict);
        if (kept !== null) return kept;
        if (repairs > MAX_REPAIRS)
          throw new TaskFailure(
            'LLM_OUTPUT_INVALID',
            `The result failed validation after ${String(MAX_REPAIRS)} repairs: ${verdict.problems.join('; ').slice(0, 400)}`,
          );
        throw new TaskFailure(
          'AGENT_LIMIT_REACHED',
          `Stopped after ${String(turns)} turns without a valid result: ${verdict.problems.join('; ').slice(0, 400)}`,
        );
      }
    }
    messages.push({ role: 'tool', results });
    await recorder.message('tool', logged);
    if (pacing && !pausedBefore && withheld(pacing.tool)) {
      messages.push({ role: 'user', content: pacing.message });
      await recorder.message('user', { text: 'pacing', tool: pacing.tool });
    }
  }
}

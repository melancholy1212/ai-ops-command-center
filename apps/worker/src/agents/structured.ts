/**
 * The structured call (docs/agents.md#the-structured-call): render the input, one model call with a
 * schema-constrained response, Zod validation, up to 2 repair turns carrying the errors. No tools, no loop.
 */
import type { AgentType, LlmCallId, RouteClass } from '@aoc/contracts';
import { TaskFailure, type BudgetDimension } from '@aoc/core';
import { toJsonSchema, type ConversationMessage, type LlmRouter } from '@aoc/llm';
import type { z } from 'zod';
import type { LoopRecorder } from './loop';
import { callModel } from './model';

export const MAX_STRUCTURED_REPAIRS = 2;

export interface StructuredRole<I, O> {
  agent: AgentType;
  /** Also the prompt version recorded on every model call. */
  version: string;
  route: RouteClass;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  system: string;
  message(input: I): string;
  maxOutputTokens: number;
  /** Checks beyond the schema; each message becomes part of a repair turn. */
  validate?(output: O, input: I): string[];
}

export interface StructuredCallOptions<I, O> {
  role: StructuredRole<I, O>;
  input: I;
  router: LlmRouter;
  recorder: LoopRecorder;
  checkBudget: () => Promise<readonly BudgetDimension[]>;
  signal: AbortSignal;
}

/** Models sometimes wrap JSON in a Markdown fence even when asked for a schema; the fence is not the answer. */
function parseJson(text: string | null): unknown {
  const trimmed = (text ?? '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
}

export async function runStructuredCall<I, O>(
  options: StructuredCallOptions<I, O>,
): Promise<{ output: O; callId: LlmCallId }> {
  const { role, recorder } = options;
  const input = role.input.parse(options.input);
  const schema = toJsonSchema(role.output);
  const messages: ConversationMessage[] = [{ role: 'user', content: role.message(input) }];
  await recorder.message('user', { text: messages[0]?.role === 'user' ? messages[0].content : '' });
  const caller = {
    route: role.route,
    promptVersion: role.version,
    system: role.system,
    maxOutputTokens: role.maxOutputTokens,
    router: options.router,
    recorder,
    checkBudget: options.checkBudget,
    signal: options.signal,
  };

  for (let attempt = 0; ; attempt += 1) {
    const { response, binding, callId } = await callModel(
      caller,
      messages,
      [],
      { type: 'none' },
      { name: 'result', schema },
    );
    await recorder.message('assistant', { text: response.text, stopReason: response.stopReason });
    if (response.stopReason === 'refusal') throw new TaskFailure('LLM_REFUSAL', 'The model declined the request.');
    if (response.stopReason === 'max_tokens')
      throw new TaskFailure('LLM_TRUNCATED', 'The model ran out of output tokens.');

    let problems: string[];
    try {
      const parsed = role.output.safeParse(parseJson(response.text));
      problems = parsed.success
        ? (role.validate?.(parsed.data, input) ?? [])
        : parsed.error.issues.slice(0, 20).map((i) => `${i.path.map(String).join('.') || 'result'}: ${i.message}`);
      if (parsed.success && problems.length === 0) return { output: parsed.data, callId };
    } catch {
      problems = ['The answer was not valid JSON.'];
    }
    if (attempt >= MAX_STRUCTURED_REPAIRS) {
      throw new TaskFailure(
        'LLM_OUTPUT_INVALID',
        `The answer failed validation after ${String(MAX_STRUCTURED_REPAIRS)} repairs: ${problems.join('; ').slice(0, 400)}`,
      );
    }
    messages.push(
      {
        role: 'assistant',
        text: response.text,
        toolCalls: [],
        providerContent: response.providerContent,
        providerKind: binding.providerKind,
      },
      {
        role: 'user',
        content: `Your answer failed validation: ${problems.join('; ').slice(0, 1500)}. Reply with the corrected JSON only.`,
      },
    );
    await recorder.message('user', { text: 'repair', problems });
  }
}

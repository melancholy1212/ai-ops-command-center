/**
 * OpenAI-compatible chat completions adapter (official openai SDK with a base URL): Earthruntime today,
 * any compatible host tomorrow. SDK retries are off; in-call retries are ours.
 */
import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from 'openai';
import type { LlmStopReason } from '@aoc/contracts';
import { capabilitiesOf } from './models';
import { kindForStatus, parseRetryAfter, withInCallRetries, type Sleep } from './retry';
import {
  LlmCallError,
  type ConversationMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type ReasoningLevel,
} from './types';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type AssistantMessage = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;

export interface OpenAiCompatibleOptions {
  apiKey: string;
  baseURL: string;
  account: string;
  fetch?: typeof globalThis.fetch;
  sleep?: Sleep;
  timeoutMs?: number;
}

function toMessages(system: string, messages: readonly ConversationMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
    } else if (message.role === 'tool') {
      for (const r of message.results) out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
    } else if (message.providerKind === 'openai_compatible') {
      // Replay our own turn with exactly the content and tool calls (ids, argument strings) we received.
      const raw = message.providerContent as AssistantMessage;
      out.push({
        role: 'assistant',
        content: raw.content ?? null,
        ...(raw.tool_calls && raw.tool_calls.length > 0 ? { tool_calls: raw.tool_calls } : {}),
      });
    } else {
      out.push({
        role: 'assistant',
        content: message.text,
        ...(message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.argumentsJson },
              })),
            }
          : {}),
      });
    }
  }
  return out;
}

function reasoningParams(model: string, level: ReasoningLevel): Record<string, unknown> {
  const control = capabilitiesOf(model).reasoningControl;
  if (control === 'reasoning_effort') return { reasoning_effort: level === 'off' ? 'low' : level };
  // Qwen: thinking is a chat-template switch; it overthinks when on, so "off" really turns it off.
  if (control === 'enable_thinking') return { chat_template_kwargs: { enable_thinking: level !== 'off' } };
  return {};
}

// instanceof on the SDK's generic error class narrows to APIError<any>; the guard keeps the real types.
function isApiError(error: unknown): error is APIError {
  return error instanceof APIError;
}

function classify(error: unknown): LlmCallError {
  if (error instanceof LlmCallError) return error;
  if (error instanceof APIUserAbortError) return new LlmCallError('aborted', 'The call was aborted.');
  if (error instanceof APIConnectionError) {
    return new LlmCallError('unavailable', `Provider connection failed: ${error.message}`);
  }
  if (isApiError(error)) {
    const apiError = error;
    const retryAfter = parseRetryAfter(apiError.headers?.get('retry-after'));
    return new LlmCallError(
      kindForStatus(apiError.status),
      `Provider ${String(apiError.status)}: ${apiError.message}`,
      retryAfter,
    );
  }
  return new LlmCallError('unavailable', error instanceof Error ? error.message : String(error));
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): LlmProvider {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    maxRetries: 0,
    timeout: options.timeoutMs ?? 300_000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    kind: 'openai_compatible',
    account: options.account,
    async generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      const { binding } = request;
      const capabilities = capabilitiesOf(binding.model);
      if (request.toolChoice.type === 'tool' && !capabilities.forcedToolChoice) {
        throw new LlmCallError('invalid_request', `${binding.model} does not support forced tool choice`);
      }
      const params = {
        model: binding.model,
        messages: toMessages(request.system, request.messages),
        max_tokens: request.maxOutputTokens,
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((t) => ({
                type: 'function' as const,
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              })),
              tool_choice:
                request.toolChoice.type === 'tool'
                  ? { type: 'function' as const, function: { name: request.toolChoice.name } }
                  : request.toolChoice.type,
            }
          : {}),
        ...(request.responseFormat
          ? {
              response_format: {
                type: 'json_schema' as const,
                // Not strict: our schemas use optional fields; Zod validates and repairs afterwards.
                json_schema: {
                  name: request.responseFormat.name,
                  schema: request.responseFormat.schema,
                  strict: false,
                },
              },
            }
          : {}),
        ...reasoningParams(binding.model, binding.reasoning),
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

      const started = performance.now();
      const { value: completion, retryCount } = await withInCallRetries(
        () => client.chat.completions.create(params, { signal }),
        classify,
        signal,
        options.sleep,
      );
      const choice = completion.choices[0];
      if (!choice) throw new LlmCallError('unavailable', 'The provider returned no choices.', null, retryCount);
      const message = choice.message;
      const toolCalls = (message.tool_calls ?? [])
        .filter((c) => c.type === 'function')
        .map((c) => ({ id: c.id, name: c.function.name, argumentsJson: c.function.arguments }));

      let stopReason: LlmStopReason = 'end_turn';
      if (message.refusal || choice.finish_reason === 'content_filter') stopReason = 'refusal';
      else if (choice.finish_reason === 'length') stopReason = 'max_tokens';
      else if (toolCalls.length > 0 || choice.finish_reason === 'tool_calls') stopReason = 'tool_use';

      const usage = completion.usage;
      // An unpriceable call would let spend escape the budget: refuse it instead of recording zero tokens.
      if (!usage) {
        throw new LlmCallError('invalid_request', 'The provider did not report token usage.', null, retryCount);
      }
      return {
        text: message.content ?? null,
        toolCalls,
        stopReason,
        usage: {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          // gpt-oss reports 0 even when it reasons: only trusted where the capability says so.
          reasoningTokens: capabilities.reportsReasoningTokens
            ? (usage.completion_tokens_details?.reasoning_tokens ?? null)
            : null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        },
        cacheStatus: 'not_supported',
        providerContent: { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls ?? [] },
        latencyMs: Math.round(performance.now() - started),
        retryCount,
      };
    },
  };
}

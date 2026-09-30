/**
 * Anthropic Messages API adapter (official SDK). SDK retries are off: in-call retries are ours, so the
 * retry count is exact and both adapters behave the same.
 */
import Anthropic, { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type { CacheStatus, LlmStopReason } from '@aoc/contracts';
import { capabilitiesOf } from './models';
import { kindForStatus, parseRetryAfter, withInCallRetries, type Sleep } from './retry';
import {
  LlmCallError,
  type ConversationMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type ToolCallRequest,
} from './types';

type MessageParam = Anthropic.Messages.MessageParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;

export interface AnthropicAdapterOptions {
  apiKey: string;
  account?: string;
  /** Injected in tests to serve recorded HTTP responses. */
  fetch?: typeof globalThis.fetch;
  sleep?: Sleep;
  timeoutMs?: number;
}

const STOP_REASONS: Record<string, LlmStopReason> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  model_context_window_exceeded: 'max_tokens',
  stop_sequence: 'stop_sequence',
  refusal: 'refusal',
  // Only server-side tools pause a turn, and none are used; treat it as a finished turn.
  pause_turn: 'end_turn',
};

function toMessages(messages: readonly ConversationMessage[]): MessageParam[] {
  return messages.map((message): MessageParam => {
    if (message.role === 'user') return { role: 'user', content: message.content };
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: message.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.toolCallId,
          content: r.content,
          is_error: r.isError,
        })),
      };
    }
    // Our own earlier turns are replayed verbatim (thinking blocks and signatures included). A turn from
    // another provider can only be rebuilt from its normalised text and tool calls.
    if (message.providerKind === 'anthropic') {
      return { role: 'assistant', content: message.providerContent as ContentBlockParam[] };
    }
    const content: ContentBlockParam[] = [];
    if (message.text) content.push({ type: 'text', text: message.text });
    for (const call of message.toolCalls) {
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: JSON.parse(call.argumentsJson) as unknown,
      });
    }
    return { role: 'assistant', content };
  });
}

// instanceof on the SDK's generic error class narrows to APIError<any>; the guard keeps the real types.
function isApiError(error: unknown): error is APIError {
  return error instanceof APIError;
}

function classify(error: unknown): LlmCallError {
  if (error instanceof LlmCallError) return error;
  if (error instanceof APIUserAbortError) return new LlmCallError('aborted', 'The call was aborted.');
  if (error instanceof APIConnectionError) {
    return new LlmCallError('unavailable', `Anthropic connection failed: ${error.message}`);
  }
  if (isApiError(error)) {
    const apiError = error;
    const retryAfter = parseRetryAfter(apiError.headers?.get('retry-after'));
    return new LlmCallError(
      kindForStatus(apiError.status),
      `Anthropic ${String(apiError.status)}: ${apiError.message}`,
      retryAfter,
    );
  }
  return new LlmCallError('unavailable', error instanceof Error ? error.message : String(error));
}

export function createAnthropicProvider(options: AnthropicAdapterOptions): LlmProvider {
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: 0,
    timeout: options.timeoutMs ?? 300_000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    kind: 'anthropic',
    account: options.account ?? 'anthropic',
    async generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      const { binding } = request;
      const capabilities = capabilitiesOf(binding.model);
      if (request.toolChoice.type === 'tool' && !capabilities.forcedToolChoice) {
        throw new LlmCallError('invalid_request', `${binding.model} does not support forced tool choice`);
      }
      const effort = binding.reasoning === 'off' ? 'low' : binding.reasoning;
      const outputConfig = {
        ...(capabilities.reasoningControl === 'effort' ? { effort } : {}),
        ...(request.responseFormat
          ? { format: { type: 'json_schema' as const, schema: request.responseFormat.schema } }
          : {}),
      };
      const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
        model: binding.model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: toMessages(request.messages),
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
              })),
              tool_choice:
                request.toolChoice.type === 'tool'
                  ? { type: 'tool' as const, name: request.toolChoice.name }
                  : { type: request.toolChoice.type },
            }
          : {}),
        // Opus 5.5 cannot turn thinking off and defaults to medium effort, so effort is always explicit.
        ...(capabilities.reasoningControl === 'effort' ? { thinking: { type: 'adaptive' as const } } : {}),
        ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
        // Automatic caching of the stable prefix (tools, system, earlier turns): the main cost lever in loops.
        ...(capabilities.promptCaching ? { cache_control: { type: 'ephemeral' as const } } : {}),
      };

      const started = performance.now();
      const { value: message, retryCount } = await withInCallRetries(
        () => client.messages.create(params, { signal }),
        classify,
        signal,
        options.sleep,
      );

      const textParts: string[] = [];
      const toolCalls: ToolCallRequest[] = [];
      for (const block of message.content) {
        if (block.type === 'text') textParts.push(block.text);
        if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, argumentsJson: JSON.stringify(block.input) });
        }
      }
      const usage = message.usage;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      let cacheStatus: CacheStatus = 'not_supported';
      if (capabilities.promptCaching) cacheStatus = cacheRead === 0 ? 'miss' : cacheWrite === 0 ? 'hit' : 'partial';

      return {
        text: textParts.length > 0 ? textParts.join('') : null,
        toolCalls,
        stopReason: STOP_REASONS[message.stop_reason ?? ''] ?? 'end_turn',
        usage: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          reasoningTokens: capabilities.reportsReasoningTokens
            ? (usage.output_tokens_details?.thinking_tokens ?? null)
            : null,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        },
        cacheStatus,
        providerContent: message.content,
        latencyMs: Math.round(performance.now() - started),
        retryCount,
      };
    },
  };
}

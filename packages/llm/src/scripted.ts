import type { LlmProviderKind } from '@aoc/contracts';
import type { LlmProvider, LlmRequest, LlmResponse } from './types';

export type ScriptedTurn = Partial<Omit<LlmResponse, 'providerContent'>> | ((request: LlmRequest) => LlmResponse);

/**
 * A provider that answers from a script, for unit tests of loops and structured calls. Every request is
 * kept so tests can assert what the model was shown.
 */
export function createScriptedProvider(
  turns: readonly ScriptedTurn[],
  options: { account?: string; kind?: LlmProviderKind } = {},
): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  const kind = options.kind ?? 'openai_compatible';
  return {
    kind,
    account: options.account ?? 'scripted',
    requests,
    generate(request: LlmRequest): Promise<LlmResponse> {
      requests.push(structuredClone(request));
      const turn = turns[requests.length - 1];
      if (turn === undefined) return Promise.reject(new Error(`Script exhausted after ${String(turns.length)} turns`));
      if (typeof turn === 'function') return Promise.resolve(turn(request));
      const toolCalls = turn.toolCalls ?? [];
      const text = turn.text ?? null;
      return Promise.resolve({
        text,
        toolCalls,
        stopReason: turn.stopReason ?? (toolCalls.length > 0 ? 'tool_use' : 'end_turn'),
        usage: turn.usage ?? {
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        },
        cacheStatus: turn.cacheStatus ?? 'not_supported',
        providerContent: { role: 'assistant', content: text, tool_calls: toolCalls },
        latencyMs: turn.latencyMs ?? 1,
        retryCount: turn.retryCount ?? 0,
      });
    },
  };
}

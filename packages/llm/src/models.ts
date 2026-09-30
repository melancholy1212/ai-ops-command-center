/**
 * Model configuration: prices and capabilities per model, and the routing table that maps each route class
 * to ordered bindings (docs/llm.md). Changing a task's model is an edit here, measured by evals first.
 */
import type { RouteClass, TokenUsage } from '@aoc/contracts';
import type { ModelBinding, ModelCapabilities } from './types';

/** Checked against anthropic.com and earthruntime.com/pricing.md on 2026-09-30. USD per million tokens. */
export const PRICING_VERSION = 'pricing@2026-09-30';

interface Price {
  input: number;
  output: number;
  /** Anthropic 5-minute cache write; null where the provider has no prompt caching. */
  cacheWrite: number | null;
  cacheRead: number | null;
}

const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'gpt-oss-120b': { input: 0.03, output: 0.17, cacheWrite: null, cacheRead: null },
  'qwen3.6-35b': { input: 0.1, output: 0.9, cacheWrite: null, cacheRead: null },
  'qwen3.8-27b': { input: 0.24, output: 2.2, cacheWrite: null, cacheRead: null },
};

export function isPriced(model: string): boolean {
  return model in PRICES;
}

/**
 * Cost in integer micro-USD, rounded up. `inputTokens` excludes cached tokens, which are priced separately
 * (that is how Anthropic reports usage; providers without caching report none). Reasoning tokens are part
 * of the output tokens on both providers.
 */
export function costUsdMicros(model: string, usage: TokenUsage): number {
  const price = PRICES[model];
  if (!price) throw new Error(`No price for model ${model}: it cannot be routed to`);
  // Price per million tokens in USD equals price per token in micro-USD.
  const micros =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    (usage.cacheWriteTokens ?? 0) * (price.cacheWrite ?? price.input) +
    (usage.cacheReadTokens ?? 0) * (price.cacheRead ?? price.input);
  return Math.ceil(Math.round(micros * 1e6) / 1e6);
}

const CLAUDE_5: ModelCapabilities = {
  // Forced tool choice returns 400 on Opus 5.5 and Sonnet 5.5; the loop never relies on it for them.
  forcedToolChoice: false,
  parallelToolCalls: true,
  structuredOutput: true,
  promptCaching: true,
  reasoningControl: 'effort',
  reportsReasoningTokens: true,
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
};

export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  'claude-opus-5-5': CLAUDE_5,
  'claude-sonnet-5-5': CLAUDE_5,
  'claude-haiku-4-5': {
    forcedToolChoice: true,
    parallelToolCalls: true,
    structuredOutput: true,
    promptCaching: true,
    reasoningControl: 'none',
    reportsReasoningTokens: false,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
  },
  // Verified against Earthruntime on 2026-09-30: forced tool choice and JSON schema work, no caching,
  // gpt-oss makes no parallel tool calls and reports reasoning_tokens as 0 even when reasoning.
  'gpt-oss-120b': {
    forcedToolChoice: true,
    parallelToolCalls: false,
    structuredOutput: true,
    promptCaching: false,
    reasoningControl: 'reasoning_effort',
    reportsReasoningTokens: false,
    contextWindow: 131_000,
    maxOutputTokens: 32_000,
  },
  'qwen3.6-35b': {
    forcedToolChoice: true,
    parallelToolCalls: true,
    structuredOutput: true,
    promptCaching: false,
    reasoningControl: 'enable_thinking',
    reportsReasoningTokens: false,
    contextWindow: 262_000,
    maxOutputTokens: 32_000,
  },
  'qwen3.8-27b': {
    forcedToolChoice: true,
    parallelToolCalls: true,
    structuredOutput: true,
    promptCaching: false,
    reasoningControl: 'enable_thinking',
    reportsReasoningTokens: false,
    contextWindow: 262_000,
    maxOutputTokens: 32_000,
  },
};

export function capabilitiesOf(model: string): ModelCapabilities {
  const capabilities = MODEL_CAPABILITIES[model];
  if (!capabilities) throw new Error(`No capabilities configured for model ${model}`);
  return capabilities;
}

export const ROUTING_CONFIG_VERSION = 'routes@2026-09-30';

const anthropic = (model: string, reasoning: ModelBinding['reasoning']): ModelBinding => ({
  providerAccount: 'anthropic',
  providerKind: 'anthropic',
  model,
  reasoning,
});
const earthruntime = (model: string, reasoning: ModelBinding['reasoning']): ModelBinding => ({
  providerAccount: 'earthruntime',
  providerKind: 'openai_compatible',
  model,
  reasoning,
});

/** Ordered: the router takes the first binding whose provider is configured and healthy. */
export const ROUTES: Record<RouteClass, readonly ModelBinding[]> = {
  planning: [anthropic('claude-opus-5-5', 'high'), earthruntime('gpt-oss-120b', 'medium')],
  agent_loop: [anthropic('claude-opus-5-5', 'medium'), earthruntime('gpt-oss-120b', 'low')],
  extraction: [anthropic('claude-haiku-4-5', 'off'), earthruntime('gpt-oss-120b', 'low')],
  judge: [anthropic('claude-haiku-4-5', 'off'), earthruntime('gpt-oss-120b', 'low')],
  analysis: [anthropic('claude-opus-5-5', 'high'), earthruntime('qwen3.8-27b', 'off')],
  writing: [anthropic('claude-opus-5-5', 'medium'), earthruntime('qwen3.8-27b', 'off')],
};

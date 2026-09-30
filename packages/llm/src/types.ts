/**
 * The provider-agnostic model interface (docs/llm.md). Agents and structured calls talk to this; adapters
 * translate it to one provider's API. Nothing outside an adapter sees provider request or response shapes,
 * except `providerContent`, which is carried opaquely so a conversation can be replayed exactly.
 */
import type {
  CacheStatus,
  ExecutionId,
  LlmCallId,
  LlmProviderKind,
  LlmStopReason,
  RouteClass,
  RunId,
  TaskId,
  TokenUsage,
} from '@aoc/contracts';

export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high';

/** A JSON Schema object, generated from a Zod contract. */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ToolCallRequest {
  /** The provider's id for the call, echoed back with its result. */
  id: string;
  name: string;
  /** Raw JSON text as the model produced it. Parsed and validated by the caller, never string-matched. */
  argumentsJson: string;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  /** JSON-encoded result, so page text reaches the model as data, not as prose. */
  content: string;
  isError: boolean;
}

export type ConversationMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      text: string | null;
      toolCalls: ToolCallRequest[];
      /** The provider's own content (thinking blocks included), replayed verbatim to the same provider. */
      providerContent: unknown;
      providerKind: LlmProviderKind;
    }
  | { role: 'tool'; results: ToolResult[] };

export interface ModelCapabilities {
  forcedToolChoice: boolean;
  parallelToolCalls: boolean;
  structuredOutput: boolean;
  promptCaching: boolean;
  reasoningControl: 'effort' | 'reasoning_effort' | 'enable_thinking' | 'none';
  reportsReasoningTokens: boolean;
  contextWindow: number;
  maxOutputTokens: number;
}

/** One configured way to serve a route: which provider account, which model, with which settings. */
export interface ModelBinding {
  providerAccount: string;
  providerKind: LlmProviderKind;
  model: string;
  reasoning: ReasoningLevel;
}

export interface LlmTelemetry {
  runId: RunId;
  taskId: TaskId;
  executionId: ExecutionId;
  callId: LlmCallId;
  route: RouteClass;
  promptVersion: string;
}

export type ToolChoice = { type: 'auto' } | { type: 'none' } | { type: 'tool'; name: string };

export interface LlmRequest {
  binding: ModelBinding;
  system: string;
  messages: ConversationMessage[];
  tools: ToolSpec[];
  toolChoice: ToolChoice;
  responseFormat?: { name: string; schema: JsonSchema };
  maxOutputTokens: number;
  telemetry: LlmTelemetry;
}

export interface LlmResponse {
  text: string | null;
  toolCalls: ToolCallRequest[];
  stopReason: LlmStopReason;
  usage: TokenUsage;
  cacheStatus: CacheStatus;
  providerContent: unknown;
  latencyMs: number;
  retryCount: number;
}

export interface LlmProvider {
  readonly kind: LlmProviderKind;
  /** The configured account name, e.g. "anthropic" or "earthruntime". */
  readonly account: string;
  generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
}

/**
 * A failed call, classified. `rate_limited` and `unavailable` are availability failures: retried in the
 * call and eligible for router fallback. Everything else is the request's or the configuration's fault.
 */
export class LlmCallError extends Error {
  constructor(
    readonly kind: 'rate_limited' | 'unavailable' | 'invalid_request' | 'auth' | 'aborted' | 'fixture_miss',
    message: string,
    readonly retryAfterMs: number | null = null,
    readonly retryCount = 0,
  ) {
    super(message);
    this.name = 'LlmCallError';
  }

  get availability(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'unavailable';
  }
}

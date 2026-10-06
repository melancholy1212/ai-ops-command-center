# LLM abstraction and routing

Goal: changing the model for a task is a configuration change, never a workflow rewrite. Application model calls
use the application's own provider credentials. **Claude Code Max is a subscription for Claude Code and does not
cover API usage by this application.**

## Interface

```ts
interface LlmProvider {
  readonly kind: 'anthropic' | 'openai_compatible';
  generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
}

interface LlmRequest {
  binding: ModelBinding;                 // provider account + model + params, chosen by the router
  system: string;                        // frozen per role version
  messages: ConversationMessage[];       // normalised; assistant turns keep opaque provider content for exact replay
  tools: ToolSpec[];                     // name, description, JSON Schema generated from the Zod contracts
  toolChoice: { type: 'auto' } | { type: 'none' } | { type: 'tool'; name: string }; // 'tool' only if the model supports it
  responseFormat?: { name: string; schema: JsonSchema };
  reasoning: 'off' | 'low' | 'medium' | 'high';   // mapped per provider and model
  maxOutputTokens: number;
  telemetry: { runId: RunId; taskId: TaskId; executionId: ExecutionId; callId: LlmCallId; route: RouteClass; promptVersion: string };
}

interface LlmResponse {
  text: string | null;
  toolCalls: { id: string; name: string; argumentsJson: string }[];
  stopReason: LlmStopReason;            // end_turn | tool_use | max_tokens | refusal | stop_sequence | error
  usage: TokenUsage;                    // input, output, reasoning?, cache read?, cache write?
  cacheStatus: CacheStatus;
  providerContent: unknown;             // appended to history verbatim; never edited
  latencyMs: number;
  retryCount: number;
}
```

Tool arguments are parsed with `JSON.parse` and validated against the tool's schema, never string-matched.
Refusals and truncation are explicit stop reasons with their own failure codes (`LLM_REFUSAL`, `LLM_TRUNCATED`).

## Routing

Agents declare a **route class**, not a model ([`AGENT_ROUTES`](../packages/contracts/src/workflow.ts)). A versioned
config maps each class to an ordered list of bindings. The router picks the first binding whose provider has
credentials and whose circuit breaker is closed. It falls back to the next binding only on availability failures
(rate limit or provider errors after in-call retries), never on a bad answer, since quality problems are for evals.

| Route | Used by | Needs |
|---|---|---|
| `planning` | planner | strong reasoning, structured output |
| `agent_loop` | research, company intelligence, people discovery | reliable multi-turn tool use |
| `extraction` | helpers: classification, normalisation | cheap, fast, structured |
| `judge` | verifier | narrow yes/no judgments, cheap |
| `analysis` | analyst | synthesis over many claims |
| `writing` | outreach writer | fluent short text, strict citations |

Initial bindings, to be tuned by evals:

| Route | Anthropic (when `ANTHROPIC_API_KEY` is set) | Earthruntime (OpenAI-compatible) |
|---|---|---|
| planning | `claude-opus-5-5`, effort high | `gpt-oss-120b`, reasoning medium |
| agent_loop | `claude-opus-5-5`, effort medium | `gpt-oss-120b`, reasoning low |
| extraction | `claude-haiku-4-5` | `gpt-oss-120b`, reasoning low |
| judge | `claude-haiku-4-5` | `gpt-oss-120b`, reasoning low |
| analysis | `claude-opus-5-5`, effort high | `qwen3.8-27b`, thinking off |
| writing | `claude-opus-5-5`, effort medium | `qwen3.8-27b`, thinking off |

With `BAZAARLINK_API_KEY` set, BazaarLink's free `qwen/qwen3.7-flash:free` is tried between Anthropic and
Earthruntime on planning, agent_loop, extraction and judge (routes@2026-10-06). BazaarLink is an OpenAI-compatible
gateway at `https://api.bazaarlink.ai/v1`. The free tier costs 0 and is limited to 10 requests a minute and 60 a
day, and a rate limit falls back to Earthruntime. It passed forced tool choice, JSON schema and usage reporting on
2026-10-06. On the first live run it planned well and ran the first discovery turns, then hit the daily limit.

Each call records the binding that served it and the routing config version. A model without a price entry
can't be routed to, so budgets can't be bypassed by an unpriced model.

Once a conversation contains an assistant turn, later calls in it stay on that provider kind: another provider
can't replay the turn exactly (thinking blocks and their signatures are provider-specific), so a fallback mid-loop
only goes to another binding of the same provider. Each binding has a circuit breaker (3 consecutive availability
failures open it for 30 s). A rate limit whose retry-after is longer than 60 s (a daily quota) opens it at once,
until that time, at most a day. A live run waited 3 minutes per turn retrying an exhausted free quota before
this rule existed.

## Model capabilities (config)

| Capability | Why it matters |
|---|---|
| `forcedToolChoice` | Whether the loop may force `submit_result` |
| `parallelToolCalls` | Informational; the loop never depends on it |
| `structuredOutput` | JSON-schema-constrained responses |
| `promptCaching` | Whether to place cache breakpoints and expect cache metrics |
| `reasoningControl` | `effort` (Anthropic), `reasoning_effort` (gpt-oss), `enable_thinking` (Qwen), or none |
| `reportsReasoningTokens` | Whether `reasoningTokens` is trustworthy or recorded as null |
| context window, max output | Hard limits for the loop's budget checks |

## Adapters

**Anthropic** (built first; official TypeScript SDK; Messages API):
- adaptive thinking with `output_config.effort`; Opus 5.5 can't disable thinking and defaults to `medium`, so effort is always set explicitly;
- forced tool choice returns 400 on Opus 5.5 and Sonnet 5.5 → `forcedToolChoice: false`; the loop uses a strict
  `submit_result` tool with `tool_choice: auto`, then a schema-constrained final call if needed;
- structured output via `output_config.format`; strict tool schemas;
- prompt caching on the stable prefix (tools, then system prompt), which is the main cost lever for multi-turn loops;
  `cache_read_input_tokens` / `cache_creation_input_tokens` set `cacheStatus`;
- `refusal` handled as a stop reason, with the server-side fallback option available;
- append-only history: assistant content (including thinking blocks) replayed unchanged.
Without an API key the adapter is tested against recorded responses only.

**OpenAI-compatible** (Earthruntime today; any compatible host tomorrow): chat completions with `tools`,
`tool_choice`, `response_format: json_schema`, streaming with usage. Verified on 2026-09-30 against
`gpt-oss-120b`, `qwen3.6-35b` and `qwen3.8-27b`:
- tools, forced tool choice, JSON schema and streaming usage all work;
- 20 concurrent requests succeeded with no rate-limit errors;
- gpt-oss-120b quoted most faithfully (9/9) but made no parallel tool calls;
- Qwen 3.8 overthinks with thinking on;
- no prompt caching;
- gpt-oss reports `reasoning_tokens: 0` even when reasoning, so it is recorded as null.

**Implemented in `packages/llm`** (Phase 3): both adapters call the official SDKs with SDK retries turned off, and
share one in-call retry policy, so `retryCount` is exact and both providers behave the same. Calls are
non-streaming (usage comes with the response). A response without token usage is refused (`invalid_request`)
rather than recorded as free. Account problems are not provider trouble: 401/403 (`auth`) and 402 (`billing`, credit
or quota used up) fail the task with `PROVIDER_ACCOUNT` and are not retried; only rate limits and 5xx/network errors are
retried and can fall back to another binding. `test:live` checks the OpenAI-compatible adapter against Earthruntime; the Anthropic
adapter is tested against recorded HTTP responses until an `ANTHROPIC_API_KEY` exists.

## Structured output strategy

| Situation | Anthropic | OpenAI-compatible |
|---|---|---|
| Structured call | `output_config.format` | `response_format: json_schema` (strict) |
| Tool loop final answer | strict `submit_result`, `tool_choice: auto`; if the model stops without it: nudge, then a schema-constrained final call | `submit_result`; if it stalls: nudge, then forced `tool_choice` |

Then always: Zod validation, up to 2 repair turns with the errors, then `LLM_OUTPUT_INVALID`.

## Telemetry per call (`llm_calls`)

Model; provider and provider account; route; routing config version; prompt version; request hash; input,
output, reasoning, cache-read and cache-write tokens; cache status; cost in micro-USD; latency; retry count;
stop reason; failure; run, task and execution ids; sequence within the execution.

## Cost

Cost = tokens × price from a versioned pricing table, computed in integer micro-USD (rounded up):

| Model | Input $/M | Output $/M | Cache read $/M |
|---|---|---|---|
| `claude-opus-5-5` | 4.00 | 20.00 | 0.20 |
| `claude-sonnet-5-5` | 2.00 | 10.00 | 0.20 |
| `claude-haiku-4-5` | 1.00 | 5.00 | per provider rate card |
| `gpt-oss-120b` (Earthruntime) | 0.03 | 0.17 | — |
| `qwen3.6-35b` (Earthruntime) | 0.10 | 0.90 | — |
| `qwen3.8-27b` (Earthruntime) | 0.24 | 2.20 | — |

Prices are re-checked against each provider's pricing page when the adapter is implemented.

## Credentials

| Variable | Provider | Lives in |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API (Console billing, not Claude Code Max) | worker: local `.env.local`, Railway |
| `EARTHRUNTIME_API_KEY` | Earthruntime | worker: local `.env.local`, Railway |
| `BAZAARLINK_API_KEY` | BazaarLink (optional; per-key spend caps) | worker: local `.env.local`, Railway |

Only the worker holds model credentials. Model context never contains credentials.

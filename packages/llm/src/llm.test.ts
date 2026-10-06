import type { ExecutionId, LlmCallId, RunId, TaskId } from '@aoc/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { kindForStatus } from './retry';
import {
  costUsdMicros,
  createAnthropicProvider,
  createOpenAiCompatibleProvider,
  createRecordingProvider,
  createReplayProvider,
  createScriptedProvider,
  LlmCallError,
  LlmRouter,
  requestHash,
  toJsonSchema,
  withInCallRetries,
  type ConversationMessage,
  type LlmProvider,
  type LlmRequest,
  type ModelBinding,
  type Recording,
} from './index';

const telemetry = {
  runId: '00000000-0000-4000-8000-000000000001' as RunId,
  taskId: '00000000-0000-4000-8000-000000000002' as TaskId,
  executionId: '00000000-0000-4000-8000-000000000003' as ExecutionId,
  callId: '00000000-0000-4000-8000-000000000004' as LlmCallId,
  route: 'agent_loop' as const,
  promptVersion: 'research@1',
};
const noWait = () => Promise.resolve();
const signal = new AbortController().signal;

function request(binding: ModelBinding, overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    binding,
    system: 'You research companies.',
    messages: [{ role: 'user', content: 'Find climate software companies.' }],
    tools: [{ name: 'web_search', description: 'Search the web', inputSchema: { type: 'object', properties: {} } }],
    toolChoice: { type: 'auto' },
    maxOutputTokens: 2000,
    telemetry,
    ...overrides,
  };
}

/** A fetch that serves queued responses and records every request body. */
function fakeFetch(responses: { status: number; body: unknown; headers?: Record<string, string> }[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json', ...next.headers },
      }),
    );
  };
  return { fetch, bodies };
}

const opus: ModelBinding = {
  providerAccount: 'anthropic',
  providerKind: 'anthropic',
  model: 'claude-opus-5-5',
  reasoning: 'medium',
};
const gptOss: ModelBinding = {
  providerAccount: 'earthruntime',
  providerKind: 'openai_compatible',
  model: 'gpt-oss-120b',
  reasoning: 'low',
};
const qwen: ModelBinding = { ...gptOss, model: 'qwen3.8-27b', reasoning: 'off' };

describe('pricing', () => {
  it('prices uncached, cached and output tokens separately, in whole micro-USD rounded up', () => {
    const usage = {
      inputTokens: 1000,
      outputTokens: 500,
      reasoningTokens: 100,
      cacheReadTokens: 2000,
      cacheWriteTokens: 100,
    };
    expect(costUsdMicros('claude-opus-5-5', usage)).toBe(1000 * 4 + 500 * 20 + 2000 * 0.2 + 100 * 5);
    const tiny = {
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    };
    expect(costUsdMicros('gpt-oss-120b', tiny)).toBe(1);
    expect(costUsdMicros('gpt-oss-120b', { ...tiny, inputTokens: 100_000, outputTokens: 10_000 })).toBe(4_700);
  });

  it('refuses to price an unknown model', () => {
    expect(() =>
      costUsdMicros('mystery-model', {
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      }),
    ).toThrow(/cannot be routed/);
  });
});

describe('in-call retries', () => {
  it('classifies HTTP statuses: account problems (401, 403, 402) are never retried as provider trouble', () => {
    expect([401, 403, 402, 429, 408, 503, 400, undefined].map(kindForStatus)).toEqual([
      'auth',
      'auth',
      'billing',
      'rate_limited',
      'unavailable',
      'unavailable',
      'invalid_request',
      'unavailable',
    ]);
    expect(new LlmCallError('billing', 'credit used up').availability).toBe(false);
  });

  it('honours retry-after up to 60 s, then backs off 1 s / 4 s / 10 s and gives up after 3 retries', async () => {
    const waits: number[] = [];
    const error = await withInCallRetries(
      () => Promise.reject(new Error('boom')),
      () => new LlmCallError('rate_limited', 'slow down', waits.length === 0 ? 45_000 : null),
      signal,
      (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    ).catch((e: unknown) => e);
    expect(waits).toEqual([45_000, 4_000, 10_000]);
    expect(error).toMatchObject({ kind: 'rate_limited', retryCount: 3 });
  });

  it('fails at once when the provider says to come back later than 60 s (a daily quota): waiting spends quota', async () => {
    let calls = 0;
    const waits: number[] = [];
    const error = await withInCallRetries(
      () => {
        calls += 1;
        return Promise.reject(new Error('daily limit'));
      },
      () => new LlmCallError('rate_limited', 'Free model daily limit reached.', 28_848_000),
      signal,
      (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    ).catch((e: unknown) => e);
    expect([calls, waits]).toEqual([1, []]);
    expect(error).toMatchObject({ kind: 'rate_limited', retryCount: 0, retryAfterMs: 28_848_000 });
  });

  it('does not retry a request the provider refused as invalid', async () => {
    let calls = 0;
    const error = await withInCallRetries(
      () => {
        calls += 1;
        return Promise.reject(new Error('bad'));
      },
      () => new LlmCallError('invalid_request', 'bad request'),
      signal,
      noWait,
    ).catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect(error).toMatchObject({ kind: 'invalid_request', retryCount: 0 });
  });
});

describe('Anthropic adapter', () => {
  const message = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'thinking', thinking: 'Search first.', signature: 'sig-abc' },
      { type: 'text', text: 'Searching.' },
      { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'climate software seed' } },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 50,
      output_tokens: 80,
      cache_read_input_tokens: 1200,
      cache_creation_input_tokens: 0,
      output_tokens_details: { thinking_tokens: 30 },
    },
  };

  it('sends effort, adaptive thinking and automatic caching, and normalises the response', async () => {
    const { fetch, bodies } = fakeFetch([{ status: 200, body: message }]);
    const provider = createAnthropicProvider({ apiKey: 'test', fetch, sleep: noWait });
    const response = await provider.generate(request(opus), signal);

    expect(bodies[0]).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 2000,
      system: 'You research companies.',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      tool_choice: { type: 'auto' },
      tools: [{ name: 'web_search', description: 'Search the web' }],
    });
    expect(response).toMatchObject({
      text: 'Searching.',
      toolCalls: [{ id: 'toolu_1', name: 'web_search', argumentsJson: '{"query":"climate software seed"}' }],
      stopReason: 'tool_use',
      usage: { inputTokens: 50, outputTokens: 80, reasoningTokens: 30, cacheReadTokens: 1200, cacheWriteTokens: 0 },
      cacheStatus: 'hit',
      retryCount: 0,
    });
    expect(response.providerContent).toEqual(message.content);
  });

  it('replays its own turns verbatim, thinking signature included, and sends tool results', async () => {
    const { fetch, bodies } = fakeFetch([
      { status: 200, body: { ...message, content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' } },
    ]);
    const provider = createAnthropicProvider({ apiKey: 'test', fetch, sleep: noWait });
    const history: ConversationMessage[] = [
      { role: 'user', content: 'Find companies.' },
      {
        role: 'assistant',
        text: 'Searching.',
        toolCalls: [],
        providerContent: message.content,
        providerKind: 'anthropic',
      },
      {
        role: 'tool',
        results: [{ toolCallId: 'toolu_1', name: 'web_search', content: '{"results":[]}', isError: false }],
      },
    ];
    await provider.generate(request(opus, { messages: history }), signal);
    expect(bodies[0]?.messages).toEqual([
      { role: 'user', content: 'Find companies.' },
      { role: 'assistant', content: message.content },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"results":[]}', is_error: false }],
      },
    ]);
  });

  it('retries a 429 after its retry-after and counts the retry; a 400 is not retried', async () => {
    const { fetch } = fakeFetch([
      {
        status: 429,
        body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } },
        headers: { 'retry-after': '2' },
      },
      { status: 200, body: message },
    ]);
    const waits: number[] = [];
    const provider = createAnthropicProvider({
      apiKey: 'test',
      fetch,
      sleep: (ms) => (waits.push(ms), Promise.resolve()),
    });
    expect((await provider.generate(request(opus), signal)).retryCount).toBe(1);
    expect(waits).toEqual([2000]);

    const bad = fakeFetch([
      { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'no' } } },
    ]);
    const strict = createAnthropicProvider({ apiKey: 'test', fetch: bad.fetch, sleep: noWait });
    await expect(strict.generate(request(opus), signal)).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(bad.bodies).toHaveLength(1);
  });

  it('refuses forced tool choice on models that reject it, before calling the API', async () => {
    const { fetch, bodies } = fakeFetch([]);
    const provider = createAnthropicProvider({ apiKey: 'test', fetch, sleep: noWait });
    await expect(
      provider.generate(request(opus, { toolChoice: { type: 'tool', name: 'web_search' } }), signal),
    ).rejects.toMatchObject({
      kind: 'invalid_request',
    });
    expect(bodies).toHaveLength(0);
  });
});

describe('OpenAI-compatible adapter', () => {
  const completion = (message: Record<string, unknown>, finish: string, usage?: Record<string, unknown>) => ({
    id: 'c1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-oss-120b',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });
  const usage = {
    prompt_tokens: 300,
    completion_tokens: 40,
    total_tokens: 340,
    completion_tokens_details: { reasoning_tokens: 0 },
  };

  it('maps reasoning per model and normalises tool calls; gpt-oss reasoning tokens are not trusted', async () => {
    const call = { id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x y z"}' } };
    const { fetch, bodies } = fakeFetch([
      { status: 200, body: completion({ content: null, tool_calls: [call] }, 'tool_calls', usage) },
    ]);
    const provider = createOpenAiCompatibleProvider({
      apiKey: 't',
      baseURL: 'https://llm.example/v1',
      account: 'earthruntime',
      fetch,
      sleep: noWait,
    });
    const response = await provider.generate(request(gptOss), signal);
    expect(bodies[0]).toMatchObject({
      model: 'gpt-oss-120b',
      reasoning_effort: 'low',
      tool_choice: 'auto',
      max_tokens: 2000,
    });
    expect(bodies[0]?.messages).toEqual([
      { role: 'system', content: 'You research companies.' },
      { role: 'user', content: 'Find climate software companies.' },
    ]);
    expect(response).toMatchObject({
      text: null,
      toolCalls: [{ id: 'call_1', name: 'web_search', argumentsJson: '{"query":"x y z"}' }],
      stopReason: 'tool_use',
      usage: { inputTokens: 300, outputTokens: 40, reasoningTokens: null, cacheReadTokens: null },
      cacheStatus: 'not_supported',
    });
  });

  it('turns Qwen thinking off and asks for a schema-shaped answer', async () => {
    const { fetch, bodies } = fakeFetch([{ status: 200, body: completion({ content: '{"ok":true}' }, 'stop', usage) }]);
    const provider = createOpenAiCompatibleProvider({
      apiKey: 't',
      baseURL: 'https://llm.example/v1',
      account: 'earthruntime',
      fetch,
      sleep: noWait,
    });
    await provider.generate(
      request(qwen, { tools: [], responseFormat: { name: 'answer', schema: { type: 'object' } } }),
      signal,
    );
    expect(bodies[0]).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: false } },
    });
    expect(bodies[0]).not.toHaveProperty('tools');
  });

  it('maps truncation and refusals to explicit stop reasons', async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: completion({ content: 'partial' }, 'length', usage) },
      { status: 200, body: completion({ content: null, refusal: 'I cannot help.' }, 'stop', usage) },
    ]);
    const provider = createOpenAiCompatibleProvider({
      apiKey: 't',
      baseURL: 'https://llm.example/v1',
      account: 'earthruntime',
      fetch,
      sleep: noWait,
    });
    expect((await provider.generate(request(gptOss), signal)).stopReason).toBe('max_tokens');
    expect((await provider.generate(request(gptOss), signal)).stopReason).toBe('refusal');
  });

  it('refuses a response without token usage rather than recording it as free', async () => {
    const { fetch } = fakeFetch([{ status: 200, body: completion({ content: 'hi' }, 'stop') }]);
    const provider = createOpenAiCompatibleProvider({
      apiKey: 't',
      baseURL: 'https://llm.example/v1',
      account: 'earthruntime',
      fetch,
      sleep: noWait,
    });
    await expect(provider.generate(request(gptOss), signal)).rejects.toMatchObject({ kind: 'invalid_request' });
  });

  it('retries provider errors and reports the final failure with its retry count', async () => {
    const error = { error: { message: 'down' } };
    const { fetch, bodies } = fakeFetch([0, 1, 2, 3].map(() => ({ status: 503, body: error })));
    const provider = createOpenAiCompatibleProvider({
      apiKey: 't',
      baseURL: 'https://llm.example/v1',
      account: 'earthruntime',
      fetch,
      sleep: noWait,
    });
    await expect(provider.generate(request(gptOss), signal)).rejects.toMatchObject({
      kind: 'unavailable',
      retryCount: 3,
    });
    expect(bodies).toHaveLength(4);
  });
});

describe('router', () => {
  const failing = (
    account: string,
    kind: LlmProvider['kind'],
    error: LlmCallError,
  ): LlmProvider & { calls: number } => {
    const provider = {
      kind,
      account,
      calls: 0,
      generate() {
        provider.calls += 1;
        return Promise.reject(error);
      },
    };
    return provider;
  };
  const routes = {
    planning: [opus, gptOss],
    agent_loop: [opus, gptOss],
    extraction: [gptOss],
    judge: [gptOss],
    analysis: [gptOss],
    writing: [gptOss],
  };

  it('uses the first configured binding and skips providers without credentials', async () => {
    const earth = createScriptedProvider([{ text: 'hi' }], { account: 'earthruntime' });
    const router = new LlmRouter({ providers: [earth], routes });
    const { binding } = await router.generate('agent_loop', request(opus), signal);
    expect(binding.model).toBe('gpt-oss-120b');
  });

  it('falls back on availability failures only', async () => {
    const anthropic = failing('anthropic', 'anthropic', new LlmCallError('unavailable', 'down'));
    const earth = createScriptedProvider([{ text: 'hi' }], { account: 'earthruntime' });
    const router = new LlmRouter({ providers: [anthropic, earth], routes });
    expect((await router.generate('agent_loop', request(opus), signal)).binding.providerAccount).toBe('earthruntime');

    const refusing = failing('anthropic', 'anthropic', new LlmCallError('invalid_request', 'bad schema'));
    const other = createScriptedProvider([{ text: 'hi' }], { account: 'earthruntime' });
    await expect(
      new LlmRouter({ providers: [refusing, other], routes }).generate('agent_loop', request(opus), signal),
    ).rejects.toMatchObject({
      kind: 'invalid_request',
    });
    expect(other.requests).toHaveLength(0);
  });

  it('tries the free BazaarLink tier before paid Earthruntime, and falls back to it on a rate limit', async () => {
    const free = createScriptedProvider([{ text: 'hi' }], { account: 'bazaarlink' });
    const earth = createScriptedProvider([{ text: 'hi' }], { account: 'earthruntime' });
    const router = new LlmRouter({ providers: [earth, free] });
    for (const route of ['planning', 'agent_loop', 'extraction', 'judge'] as const) {
      expect(router.candidates(route).map((b) => b.providerAccount)).toEqual(['bazaarlink', 'earthruntime']);
    }
    const { binding } = await router.generate('agent_loop', request(gptOss), signal);
    expect([binding.providerAccount, binding.model]).toEqual(['bazaarlink', 'qwen/qwen3.7-flash:free']);
    expect(
      costUsdMicros(binding.model, {
        inputTokens: 50_000,
        outputTokens: 2_000,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      }),
    ).toBe(0);

    const limited = failing(
      'bazaarlink',
      'openai_compatible',
      new LlmCallError('rate_limited', '429 upstream_rate_limited'),
    );
    const paid = createScriptedProvider([{ text: 'hi' }], { account: 'earthruntime' });
    const fallback = await new LlmRouter({ providers: [limited, paid] }).generate('judge', request(gptOss), signal);
    expect(fallback.binding.providerAccount).toBe('earthruntime');
    // Without its key, nothing changes for the other routes' order.
    expect(new LlmRouter({ providers: [paid] }).candidates('agent_loop').map((b) => b.model)).toEqual(['gpt-oss-120b']);
  });

  it('skips a binding until the time its provider gave, when that is not soon', async () => {
    let now = 0;
    const exhausted = failing(
      'bazaarlink',
      'openai_compatible',
      new LlmCallError('rate_limited', 'Free model daily limit reached.', 8 * 60 * 60 * 1000),
    );
    const paid = createScriptedProvider(
      Array.from({ length: 3 }, () => ({ text: 'hi' })),
      { account: 'earthruntime' },
    );
    const router = new LlmRouter({ providers: [exhausted, paid], now: () => now });
    expect((await router.generate('agent_loop', request(gptOss), signal)).binding.providerAccount).toBe('earthruntime');
    // One failure was enough: the next call does not try the exhausted binding at all.
    now = 7 * 60 * 60 * 1000;
    expect((await router.generate('agent_loop', request(gptOss), signal)).binding.providerAccount).toBe('earthruntime');
    expect(exhausted.calls).toBe(1);
    // After the provider's time has passed, it is tried again.
    now = 8 * 60 * 60 * 1000 + 1;
    await router.generate('agent_loop', request(gptOss), signal);
    expect(exhausted.calls).toBe(2);
  });

  it('opens a binding circuit after repeated failures and retries it after the cooldown', async () => {
    let now = 0;
    const anthropic = failing('anthropic', 'anthropic', new LlmCallError('rate_limited', 'slow'));
    const earth = createScriptedProvider(
      Array.from({ length: 6 }, () => ({ text: 'ok' })),
      { account: 'earthruntime' },
    );
    const router = new LlmRouter({
      providers: [anthropic, earth],
      routes,
      breaker: { failureThreshold: 2, cooldownMs: 1000 },
      now: () => now,
    });
    for (let i = 0; i < 4; i += 1) await router.generate('agent_loop', request(opus), signal);
    expect(anthropic.calls).toBe(2);
    now = 1001;
    await router.generate('agent_loop', request(opus), signal);
    expect(anthropic.calls).toBe(3);
  });

  it('keeps a conversation on the provider that wrote its earlier turns', async () => {
    const anthropic = failing('anthropic', 'anthropic', new LlmCallError('unavailable', 'down'));
    const earth = createScriptedProvider([{ text: 'ok' }], { account: 'earthruntime' });
    const router = new LlmRouter({ providers: [anthropic, earth], routes });
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', text: 'x', toolCalls: [], providerContent: [], providerKind: 'anthropic' },
      { role: 'user', content: 'continue' },
    ];
    await expect(router.generate('agent_loop', request(opus, { messages }), signal)).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(earth.requests).toHaveLength(0);
  });

  it('never routes to an unpriced model', () => {
    const unpriced = { ...gptOss, model: 'mystery-model' };
    const router = new LlmRouter({
      providers: [createScriptedProvider([], { account: 'earthruntime' })],
      routes: { ...routes, judge: [unpriced] },
    });
    expect(router.candidates('judge')).toEqual([]);
  });
});

describe('recording and replay', () => {
  const toolTurn = (sourceId: string): ConversationMessage[] => [
    { role: 'user', content: 'Find companies.' },
    {
      role: 'assistant',
      text: null,
      toolCalls: [{ id: 'call_1', name: 'fetch_page', argumentsJson: '{"url":"https://news.example/a"}' }],
      providerContent: {},
      providerKind: 'openai_compatible',
    },
    {
      role: 'tool',
      results: [{ toolCallId: 'call_1', name: 'fetch_page', content: JSON.stringify({ sourceId }), isError: false }],
    },
  ];

  it('replays a recorded answer when only minted ids differ, mapping them to the current run', async () => {
    const recordedSource = '11111111-1111-4111-8111-111111111111';
    const live = createScriptedProvider([{ text: `{"sourceId":"${recordedSource}","quote":"x"}` }], {
      account: 'earthruntime',
    });
    const sink: Recording[] = [];
    await createRecordingProvider(live, sink).generate(request(gptOss, { messages: toolTurn(recordedSource) }), signal);

    const replay = createReplayProvider(
      { version: 1, synthetic: true, recordings: sink },
      'earthruntime',
      'openai_compatible',
    );
    const currentSource = '22222222-2222-4222-8222-222222222222';
    const replayed = await replay.generate(request(gptOss, { messages: toolTurn(currentSource) }), signal);
    expect(replayed.text).toBe(`{"sourceId":"${currentSource}","quote":"x"}`);
    expect(requestHash(request(gptOss, { messages: toolTurn(currentSource) }))).toBe(sink[0]?.hash);
  });

  it('fails hard on a request that was never recorded', async () => {
    const replay = createReplayProvider(
      { version: 1, synthetic: false, recordings: [] },
      'earthruntime',
      'openai_compatible',
    );
    await expect(replay.generate(request(gptOss), signal)).rejects.toMatchObject({ kind: 'fixture_miss' });
  });
});

describe('toJsonSchema', () => {
  it('describes the input side of a contract, with defaults optional', () => {
    const schema = toJsonSchema(z.strictObject({ query: z.string().min(3), maxResults: z.int().max(10).default(5) }));
    expect(schema).toMatchObject({ type: 'object', required: ['query'], additionalProperties: false });
    expect(schema).not.toHaveProperty('$schema');
  });
});

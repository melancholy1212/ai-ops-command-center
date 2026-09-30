// Live check of the OpenAI-compatible adapter against Earthruntime. Not part of `pnpm test`; run with
// `pnpm --filter @aoc/llm test:live` and EARTHRUNTIME_API_KEY set. Costs a fraction of a cent.
import type { ExecutionId, LlmCallId, RunId, TaskId } from '@aoc/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { costUsdMicros, createOpenAiCompatibleProvider, LlmRouter, toJsonSchema, type LlmRequest } from './index';

const apiKey = process.env.EARTHRUNTIME_API_KEY;
const telemetry = {
  runId: '00000000-0000-4000-8000-000000000001' as RunId,
  taskId: '00000000-0000-4000-8000-000000000002' as TaskId,
  executionId: '00000000-0000-4000-8000-000000000003' as ExecutionId,
  callId: '00000000-0000-4000-8000-000000000004' as LlmCallId,
  route: 'agent_loop' as const,
  promptVersion: 'live-check@1',
};

describe.skipIf(!apiKey)('Earthruntime (live)', () => {
  const provider = createOpenAiCompatibleProvider({
    apiKey: apiKey ?? '',
    baseURL: process.env.EARTHRUNTIME_BASE_URL ?? 'https://api.earthruntime.com/v1',
    account: 'earthruntime',
  });
  const router = new LlmRouter({ providers: [provider] });
  const base: Omit<LlmRequest, 'binding'> = {
    system: 'You are a research assistant. Use tools when asked.',
    messages: [{ role: 'user', content: 'Search the web for seed-stage climate software companies in Sweden.' }],
    tools: [
      {
        name: 'web_search',
        description: 'Search the web.',
        inputSchema: toJsonSchema(z.strictObject({ query: z.string().min(3) })),
      },
    ],
    toolChoice: { type: 'auto' },
    maxOutputTokens: 800,
    telemetry,
  };

  it('routes agent_loop to gpt-oss-120b and gets a well-formed tool call with priced usage', async () => {
    const { response, binding } = await router.generate('agent_loop', base, AbortSignal.timeout(60_000));
    expect(binding.model).toBe('gpt-oss-120b');
    expect(response.toolCalls.length).toBeGreaterThan(0);
    const args = JSON.parse(response.toolCalls[0]?.argumentsJson ?? '{}') as { query?: string };
    expect(typeof args.query).toBe('string');
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(costUsdMicros(binding.model, response.usage)).toBeGreaterThan(0);
  }, 90_000);

  it('returns a schema-shaped answer on the writing route (Qwen, thinking off)', async () => {
    const Answer = z.strictObject({ country: z.string(), capital: z.string() });
    const { response, binding } = await router.generate(
      'writing',
      {
        ...base,
        telemetry: { ...telemetry, route: 'writing' },
        messages: [{ role: 'user', content: 'Give the capital of Sweden as JSON.' }],
        tools: [],
        responseFormat: { name: 'answer', schema: toJsonSchema(Answer) },
      },
      AbortSignal.timeout(60_000),
    );
    expect(binding.model).toBe('qwen3.8-27b');
    expect(Answer.parse(JSON.parse(response.text ?? '')).capital).toMatch(/stockholm/i);
  }, 90_000);
});

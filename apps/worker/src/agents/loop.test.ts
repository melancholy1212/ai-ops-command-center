// The tool loop with a scripted model, a fake tool client and an in-memory recorder: every control-flow
// path (tools, repairs, nudges, forced and schema-constrained finals, limits, budget, provider failures).
import { randomUUID } from 'node:crypto';
import type { RunId, TaskId, WorkspaceId } from '@aoc/contracts';
import { BudgetExhaustedError, type ClaimedTask, type TaskFailure } from '@aoc/core';
import {
  createScriptedProvider,
  LlmCallError,
  LlmRouter,
  type LlmProvider,
  type ScriptedTurn,
  type ToolCallRequest,
} from '@aoc/llm';
import { describe, expect, it } from 'vitest';
import { discoveryRole, type DiscoveryInput } from '../roles/research';
import { runToolLoop, SUBMIT_TOOL, type AgentRole, type LoopRecorder } from './loop';
import type { LlmCallRecord } from './recorder';
import type { ToolClient, ToolOutcome } from './tool-client';

const SOURCE = '5f0a3c1e-0000-4000-8000-000000000001';
const QUOTE = 'Northwind Climate, the Stockholm carbon accounting startup, raised a seed round';
const input: DiscoveryInput = {
  objective: 'Find seed-stage climate software companies in the Nordics.',
  today: '2026-09-30',
  criteria: {
    sectorKeywords: ['climate software'],
    countries: ['SE', 'NO'],
    fundingWindow: { from: '2025-09-30', to: '2026-09-30' },
    fundingStages: ['seed'],
    maxCompanies: 3,
    peopleRoles: ['founder'],
    outreach: { enabled: false, maxCompanies: 0 },
  },
};
const claim = (sourceId = SOURCE) => ({
  subject: { kind: 'new_company', name: 'Northwind Climate', domainHint: 'northwind.example' },
  assertion: { attribute: 'company.hq_country', value: { country: 'SE' } },
  rawValue: 'Stockholm',
  evidence: [{ sourceId, quote: QUOTE }],
});

let seq = 0;
const toolCall = (name: string, args: unknown): ToolCallRequest => ({
  id: `call_${String((seq += 1))}`,
  name,
  argumentsJson: JSON.stringify(args),
});
const turn = (...calls: ToolCallRequest[]): ScriptedTurn => ({ toolCalls: calls });

function recorder(): LoopRecorder & { calls: LlmCallRecord[]; messages: { role: string; content: unknown }[] } {
  const claimed: ClaimedTask = {
    taskId: randomUUID() as TaskId,
    workspaceId: randomUUID() as WorkspaceId,
    runId: randomUUID() as RunId,
    taskType: 'discover_companies',
    attempt: 1,
    leaseToken: randomUUID(),
  };
  const calls: LlmCallRecord[] = [];
  const messages: { role: string; content: unknown }[] = [];
  return {
    claim: claimed,
    executionId: randomUUID(),
    calls,
    messages,
    message: (role, content) => (messages.push({ role, content }), Promise.resolve()),
    llmCall: (call) => (calls.push(call), Promise.resolve()),
    toolCalls: () => Promise.resolve(),
  };
}

function tools(): ToolClient & { received: { name: string; args: unknown; modelId: string }[] } {
  const received: { name: string; args: unknown; modelId: string }[] = [];
  const spec = (name: string) => ({ name, description: name, inputSchema: { type: 'object' } });
  return {
    received,
    tools: [spec('web_search'), spec('fetch_page'), spec('get_source'), spec('lookup_company')],
    call(name, args, modelId): Promise<ToolOutcome> {
      received.push({ name, args, modelId });
      if (name === 'web_search') {
        return Promise.resolve({
          ok: true,
          output: { results: [{ url: 'https://news.example/a', rank: 0 }], provenance: { cached: false } },
        });
      }
      if (name === 'fetch_page') {
        return Promise.resolve({
          ok: true,
          output: {
            sourceId: SOURCE,
            text: `${QUOTE} led by Nordic Seed Partners.`,
            offset: 0,
            totalChars: 90,
            links: [],
            provenance: { cached: false },
          },
        });
      }
      return Promise.resolve({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'nothing', retryable: false, retryAfterMs: null },
      });
    },
    close: () => Promise.resolve(),
  };
}

const earthruntime = (turns: ScriptedTurn[]) => createScriptedProvider(turns, { account: 'earthruntime' });
const anthropic = (turns: ScriptedTurn[]) => createScriptedProvider(turns, { account: 'anthropic', kind: 'anthropic' });

async function run(
  provider: LlmProvider,
  options: { role?: AgentRole<DiscoveryInput, unknown>; budget?: string[] } = {},
) {
  const rec = recorder();
  const client = tools();
  const result = await runToolLoop({
    role: options.role ?? discoveryRole,
    input,
    router: new LlmRouter({ providers: [provider] }),
    tools: client,
    recorder: rec,
    checkBudget: () => Promise.resolve((options.budget ?? []) as never[]),
    signal: new AbortController().signal,
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { result, rec, client };
}

describe('tool loop', () => {
  it('searches, reads, submits a valid result, and records every turn with page text by reference', async () => {
    const provider = earthruntime([
      turn(toolCall('web_search', { query: 'Nordic climate software seed' })),
      turn(toolCall('fetch_page', { url: 'https://news.example/a' })),
      turn(toolCall(SUBMIT_TOOL, { claims: [claim()] })),
    ]);
    const { result, rec, client } = await run(provider);
    expect(result).toEqual({ ok: true, value: { claims: [claim()] } });
    expect(client.received.map((r) => [r.name, r.modelId])).toEqual([
      ['web_search', 'call_1'],
      ['fetch_page', 'call_2'],
    ]);
    expect(rec.calls).toHaveLength(3);
    expect(
      rec.calls.every((c) => c.binding.model === 'gpt-oss-120b' && c.promptVersion === discoveryRole.version),
    ).toBe(true);
    // The model sees tool results as JSON data, without provenance noise.
    const second = provider.requests[1]?.messages.at(-1);
    expect(second?.role === 'tool' && JSON.parse(second.results[0]?.content ?? '{}')).toEqual({
      results: [{ url: 'https://news.example/a', rank: 0 }],
    });
    // The log stores the snapshot reference, not the page text.
    const logged = JSON.stringify(rec.messages);
    expect(logged).toContain(SOURCE);
    expect(logged).not.toContain('led by Nordic Seed Partners');
    // submit_result is offered alongside the role's tools that the server lists; lookup_company is not the role's.
    expect(provider.requests[0]?.tools.map((t) => t.name)).toEqual([
      'web_search',
      'fetch_page',
      'get_source',
      SUBMIT_TOOL,
    ]);
  });

  it('turns a result that cites an unread source into a repair turn, and gives up after two repairs', async () => {
    const bad = toolCall(SUBMIT_TOOL, { claims: [claim('5f0a3c1e-0000-4000-8000-00000000dead')] });
    const provider = earthruntime([
      turn(toolCall('fetch_page', { url: 'https://news.example/a' })),
      turn(bad),
      turn(toolCall(SUBMIT_TOOL, { claims: [claim()] })),
    ]);
    const repaired = await run(provider);
    expect(repaired.result.ok).toBe(true);
    const repair = provider.requests[2]?.messages.at(-1);
    expect(repair?.role === 'tool' && repair.results[0]?.content).toMatch(/is not a source you read/);

    const stubborn = earthruntime([turn(bad), turn(bad), turn(bad)]);
    const failed = await run(stubborn);
    expect(failed.result.ok).toBe(false);
    expect((failed.result as { error: TaskFailure }).error).toMatchObject({ code: 'LLM_OUTPUT_INVALID' });
  });

  it('refuses tools outside the role and beyond the tool budget without calling the server', async () => {
    const role = { ...discoveryRole, limits: { ...discoveryRole.limits, maxToolCalls: 1 } };
    const provider = earthruntime([
      turn(
        toolCall('lookup_company', { query: { by: 'name', name: 'Northwind' } }),
        toolCall('web_search', { query: 'first query' }),
      ),
      turn(toolCall('web_search', { query: 'second query' })),
      turn(toolCall(SUBMIT_TOOL, { claims: [] })),
    ]);
    const { result, client } = await run(provider, { role });
    expect(result.ok).toBe(true);
    expect(client.received.map((r) => r.name)).toEqual(['web_search']);
    const first = provider.requests[1]?.messages.at(-1);
    expect(
      first?.role === 'tool' &&
        first.results.map((r) => (JSON.parse(r.content) as { error?: { code: string } }).error?.code),
    ).toEqual(['TOOL_NOT_PERMITTED', undefined]);
    const second = provider.requests[2]?.messages.at(-1);
    expect(second?.role === 'tool' && second.results[0]?.content).toMatch(/BUDGET_EXCEEDED/);
  });

  it('nudges a model that stops without submitting, then forces submit_result where the model supports it', async () => {
    const provider = earthruntime([
      { text: 'I found nothing.' },
      { text: 'Still nothing.' },
      turn(toolCall(SUBMIT_TOOL, { claims: [] })),
    ]);
    const { result } = await run(provider);
    expect(result).toEqual({ ok: true, value: { claims: [] } });
    expect(provider.requests[1]?.toolChoice).toEqual({ type: 'auto' });
    expect(provider.requests[2]?.toolChoice).toEqual({ type: 'tool', name: SUBMIT_TOOL });
  });

  it('asks a model without forced tool choice for one schema-constrained final answer', async () => {
    const provider = anthropic([
      { text: 'Done.' },
      { text: 'Done, really.' },
      { text: JSON.stringify({ claims: [] }) },
    ]);
    const { result } = await run(provider);
    expect(result).toEqual({ ok: true, value: { claims: [] } });
    const final = provider.requests[2];
    expect(final?.binding.model).toBe('claude-opus-5-5');
    expect(final?.tools).toEqual([]);
    expect(final?.responseFormat?.name).toBe('result');
  });

  it('stops at the turn limit, on refusals and on truncation', async () => {
    const role = { ...discoveryRole, limits: { ...discoveryRole.limits, maxTurns: 2 } };
    const looping = earthruntime([
      turn(toolCall('web_search', { query: 'one more search' })),
      turn(toolCall('web_search', { query: 'yet another one' })),
    ]);
    expect(((await run(looping, { role })).result as { error: TaskFailure }).error).toMatchObject({
      code: 'AGENT_LIMIT_REACHED',
    });
    const refusing = earthruntime([{ text: 'No.', stopReason: 'refusal' }]);
    expect(((await run(refusing)).result as { error: TaskFailure }).error).toMatchObject({ code: 'LLM_REFUSAL' });
    const truncated = earthruntime([{ text: 'partial', stopReason: 'max_tokens' }]);
    expect(((await run(truncated)).result as { error: TaskFailure }).error).toMatchObject({ code: 'LLM_TRUNCATED' });
  });

  it('checks the budget before every model call', async () => {
    const provider = earthruntime([turn(toolCall(SUBMIT_TOOL, { claims: [] }))]);
    const { result } = await run(provider, { budget: ['cost'] });
    expect((result as { error: unknown }).error).toBeInstanceOf(BudgetExhaustedError);
    expect(provider.requests).toHaveLength(0);
  });

  it('maps provider outages to a retryable task failure and records the failed call', async () => {
    const down: LlmProvider = {
      kind: 'openai_compatible',
      account: 'earthruntime',
      generate: () => Promise.reject(new LlmCallError('unavailable', 'down', null, 3)),
    };
    const { result, rec } = await run(down);
    expect((result as { error: TaskFailure }).error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      failureClass: 'transient',
    });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toMatchObject({ response: null, retryCount: 3, failure: { code: 'PROVIDER_UNAVAILABLE' } });
  });

  it('answers unparseable tool arguments with an error the model can fix', async () => {
    const provider = earthruntime([
      { toolCalls: [{ id: 'bad', name: 'web_search', argumentsJson: '{not json' }] },
      turn(toolCall(SUBMIT_TOOL, { claims: [] })),
    ]);
    const { result, client } = await run(provider);
    expect(result.ok).toBe(true);
    expect(client.received).toHaveLength(0);
    const answer = provider.requests[1]?.messages.at(-1);
    expect(answer?.role === 'tool' && answer.results[0]?.content).toMatch(/INVALID_ARGUMENT/);
  });
});

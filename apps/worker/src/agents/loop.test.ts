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
  seedUrls: [],
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

  it('reserves the last turn for the result instead of discarding what was found', async () => {
    const role = { ...discoveryRole, limits: { ...discoveryRole.limits, maxTurns: 3 } };
    const provider = earthruntime([
      turn(toolCall('web_search', { query: 'Nordic climate software seed' })),
      turn(toolCall('fetch_page', { url: 'https://news.example/a' })),
      turn(toolCall(SUBMIT_TOOL, { claims: [claim()] })),
    ]);
    const { result } = await run(provider, { role });
    expect(result).toEqual({ ok: true, value: { claims: [claim()] } });
    expect(provider.requests[2]?.toolChoice).toEqual({ type: 'tool', name: SUBMIT_TOOL });
    const last = provider.requests[2]?.messages.at(-1);
    expect(last?.role === 'user' && last.content).toMatch(/used all your turns/);

    // A model without forced tool choice gets one schema-constrained answer on its last turn.
    const opus = anthropic([
      turn(toolCall('web_search', { query: 'first query' })),
      turn(toolCall('web_search', { query: 'second query' })),
      { text: JSON.stringify({ claims: [] }) },
    ]);
    const structured = await run(opus, { role });
    expect(structured.result).toEqual({ ok: true, value: { claims: [] } });
    expect(opus.requests[2]?.responseFormat?.name).toBe('result');
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

  it('stops offering a tool that reports it cannot work in this task', async () => {
    const client = tools();
    const original = client.call.bind(client);
    client.call = (name, args, id, signal) =>
      name === 'web_search'
        ? Promise.resolve({
            ok: false,
            error: {
              code: 'PROVIDER_UNAVAILABLE',
              message: 'No search provider.',
              retryable: false,
              retryAfterMs: null,
            },
          })
        : original(name, args, id, signal);
    const provider = earthruntime([
      turn(toolCall('web_search', { query: 'Nordic climate software seed' })),
      turn(toolCall('web_search', { query: 'try again anyway' })),
      turn(toolCall(SUBMIT_TOOL, { claims: [] })),
    ]);
    const rec = recorder();
    await runToolLoop({
      role: discoveryRole,
      input,
      router: new LlmRouter({ providers: [provider] }),
      tools: client,
      recorder: rec,
      checkBudget: () => Promise.resolve([]),
      signal: new AbortController().signal,
    });
    expect(provider.requests[0]?.tools.map((t) => t.name)).toContain('web_search');
    expect(provider.requests[1]?.tools.map((t) => t.name)).not.toContain('web_search');
    const refused = provider.requests[2]?.messages.at(-1);
    expect(refused?.role === 'tool' && refused.results[0]?.content).toMatch(/unavailable in this task/);
  });

  it('pauses search after two searches without opening a page, and resumes it once a page is read', async () => {
    const search = (q: string) => toolCall('web_search', { query: q });
    const provider = earthruntime([
      turn(search('a')),
      turn(search('b')),
      turn(search('c')),
      turn(toolCall('fetch_page', { url: 'https://news.example/a' })),
      turn(toolCall(SUBMIT_TOOL, { claims: [claim()] })),
    ]);
    const { result, client, rec } = await run(provider);
    expect(result.ok).toBe(true);
    const offered = (i: number) => provider.requests[i]?.tools.map((t) => t.name);
    expect(offered(1)).toContain('web_search');
    // After the second search: not offered, the model is told why, and a call anyway is refused unexecuted.
    expect(offered(2)).not.toContain('web_search');
    const told = provider.requests[2]?.messages.at(-1);
    expect(told?.role === 'user' && told.content).toMatch(/^Search is paused/);
    const refused = provider.requests[3]?.messages.at(-1);
    expect(refused?.role === 'tool' && refused.results[0]?.content).toMatch(/Search is paused/);
    expect(client.received.filter((r) => r.name === 'web_search')).toHaveLength(2);
    // Reading a page resets the count.
    expect(offered(4)).toContain('web_search');
    expect(
      rec.messages.filter((m) => m.role === 'user' && (m.content as { text: string }).text === 'pacing'),
    ).toHaveLength(1);
  });

  it('counts parallel searches in one turn against the pace', async () => {
    const provider = earthruntime([
      turn(...['a', 'b', 'c', 'd'].map((q) => toolCall('web_search', { query: q }))),
      turn(toolCall(SUBMIT_TOOL, { claims: [] })),
      turn(toolCall('fetch_page', { url: 'https://news.example/a' })),
      turn(toolCall(SUBMIT_TOOL, { claims: [] })),
    ]);
    const { result, client } = await run(provider);
    expect(result.ok).toBe(true);
    expect(client.received.filter((r) => r.name === 'web_search')).toHaveLength(2);
    const results = provider.requests[1]?.messages.find((m, i, all) => m.role === 'tool' && i === all.length - 2);
    expect(results?.role === 'tool' && results.results.map((r) => r.isError)).toEqual([false, false, true, true]);
  });

  it('sends back an empty result from a model that found search results but opened none', async () => {
    const provider = earthruntime([
      turn(toolCall('web_search', { query: 'Nordic climate software seed' })),
      turn(toolCall(SUBMIT_TOOL, { claims: [] })),
      turn(toolCall('fetch_page', { url: 'https://news.example/a' })),
      turn(toolCall(SUBMIT_TOOL, { claims: [] })),
    ]);
    const { result } = await run(provider);
    expect(result.ok && result.value).toEqual({ claims: [] });
    const repair = provider.requests[2]?.messages.at(-1);
    expect(repair?.role === 'tool' && repair.results[0]?.content).toMatch(/not read any page successfully/);
  });

  it('sends an empty result back at most once: the check is advice, not a way to fail an honest result', async () => {
    const provider = earthruntime([
      turn(toolCall('web_search', { query: 'Nordic climate software seed' })),
      turn(toolCall(SUBMIT_TOOL, { claims: [] })),
      turn(toolCall(SUBMIT_TOOL, { claims: [] })),
    ]);
    const { result } = await run(provider);
    expect(result.ok && result.value).toEqual({ claims: [] });
    expect(provider.requests).toHaveLength(3);
  });

  it('sends back an empty result after failed reads once, then accepts it', async () => {
    const client = tools();
    const original = client.call.bind(client);
    client.call = (name, args, id, signal) =>
      name === 'fetch_page'
        ? Promise.resolve({
            ok: false,
            error: { code: 'ROBOTS_DISALLOWED', message: 'Disallowed.', retryable: false, retryAfterMs: null },
          })
        : original(name, args, id, signal);
    const provider = earthruntime([
      turn(toolCall('web_search', { query: 'Nordic climate software seed' })),
      turn(toolCall('fetch_page', { url: 'https://news.example/a' })),
      turn(toolCall(SUBMIT_TOOL, { claims: [] })),
      turn(toolCall(SUBMIT_TOOL, { claims: [] })),
    ]);
    const outcome = await runToolLoop({
      role: discoveryRole,
      input,
      router: new LlmRouter({ providers: [provider] }),
      tools: client,
      recorder: recorder(),
      checkBudget: () => Promise.resolve([]),
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({ claims: [] });
    expect(provider.requests).toHaveLength(4);
  });

  it('keeps the valid claims of a last-turn result and records the ones it dropped', async () => {
    const role = { ...discoveryRole, limits: { ...discoveryRole.limits, maxTurns: 3 } };
    const unread = '5f0a3c1e-0000-4000-8000-00000000dead';
    const mixed = {
      claims: [
        claim(),
        claim(unread),
        {
          ...claim(),
          evidence: [
            { sourceId: unread, quote: QUOTE },
            { sourceId: SOURCE, quote: QUOTE },
          ],
        },
      ],
    };
    const provider = earthruntime([
      turn(toolCall('fetch_page', { url: 'https://news.example/a' })),
      turn(toolCall('web_search', { query: 'more' })),
      turn(toolCall(SUBMIT_TOOL, mixed)),
    ]);
    const { result, rec } = await run(provider, { role });
    // The claim citing only an unread source is gone; the mixed one keeps its readable quote only.
    expect(result.ok && result.value).toEqual({
      claims: [claim(), { ...claim(), evidence: [{ sourceId: SOURCE, quote: QUOTE }] }],
    });
    const salvaged = rec.messages.find((m) => (m.content as { salvaged?: boolean }).salvaged);
    expect((salvaged?.content as { dropped: string[] }).dropped).toEqual([
      'claims.1: 1 quote(s) cite sources not read in this task',
      'claims.2: 1 quote(s) cite sources not read in this task',
    ]);
  });

  it('salvages after the repairs run out, and still fails when nothing valid is left', async () => {
    const unread = '5f0a3c1e-0000-4000-8000-00000000dead';
    const mixed = { claims: [claim(), claim(unread)] };
    const salvaged = await run(
      earthruntime([
        turn(toolCall('fetch_page', { url: 'https://news.example/a' })),
        turn(toolCall(SUBMIT_TOOL, mixed)),
        turn(toolCall(SUBMIT_TOOL, mixed)),
        turn(toolCall(SUBMIT_TOOL, mixed)),
      ]),
    );
    expect(salvaged.result.ok && salvaged.result.value).toEqual({ claims: [claim()] });

    const role = { ...discoveryRole, limits: { ...discoveryRole.limits, maxTurns: 2 } };
    const hopeless = await run(
      earthruntime([
        turn(toolCall('web_search', { query: 'x' })),
        turn(toolCall(SUBMIT_TOOL, { claims: [claim(unread)] })),
      ]),
      { role },
    );
    expect(hopeless.result.ok || hopeless.result.error).toMatchObject({ code: 'AGENT_LIMIT_REACHED' });
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

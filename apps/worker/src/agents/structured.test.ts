import { randomUUID } from 'node:crypto';
import type { RunId, TaskId, WorkspaceId } from '@aoc/contracts';
import type { ClaimedTask, TaskFailure } from '@aoc/core';
import { createScriptedProvider, LlmCallError, LlmRouter, type ScriptedTurn } from '@aoc/llm';
import { describe, expect, it } from 'vitest';
import { verifierRole } from '../roles/verifier';
import type { LoopRecorder } from './loop';
import type { LlmCallRecord } from './recorder';
import { toTaskFailure } from './model';
import { runStructuredCall } from './structured';

function recorder(): LoopRecorder & { calls: LlmCallRecord[] } {
  const claim: ClaimedTask = {
    taskId: randomUUID() as TaskId,
    workspaceId: randomUUID() as WorkspaceId,
    runId: randomUUID() as RunId,
    taskType: 'verify_entity',
    attempt: 1,
    leaseToken: randomUUID(),
  };
  const calls: LlmCallRecord[] = [];
  return {
    claim,
    executionId: randomUUID(),
    calls,
    message: () => Promise.resolve(),
    llmCall: (call) => {
      calls.push(call);
      return Promise.resolve();
    },
    toolCalls: () => Promise.resolve(),
  };
}

const input = {
  items: [
    {
      index: 0,
      claim: 'Northwind Climate is headquartered in Sweden.',
      quote: 'Stockholm-based Northwind Climate',
      context: '...',
    },
    {
      index: 1,
      claim: 'Northwind Climate was founded in 2023.',
      quote: 'The company was founded in 2021',
      context: '...',
    },
  ],
};
const good = JSON.stringify({
  verdicts: [
    { index: 0, verdict: 'supports', reason: 'Stockholm is in Sweden.' },
    { index: 1, verdict: 'contradicts', reason: 'The quote says 2021.' },
  ],
});

async function run(turns: ScriptedTurn[]) {
  const provider = createScriptedProvider(turns, { account: 'earthruntime' });
  const rec = recorder();
  const result = await runStructuredCall({
    role: verifierRole,
    input,
    router: new LlmRouter({ providers: [provider] }),
    recorder: rec,
    checkBudget: () => Promise.resolve([]),
    signal: new AbortController().signal,
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: error as TaskFailure }),
  );
  return { result, provider, rec };
}

describe('structured call', () => {
  it('asks for a schema-shaped answer on the judge route and returns it with the call id', async () => {
    const { result, provider, rec } = await run([{ text: good }]);
    expect(result.ok && result.value.output.verdicts.map((v) => v.verdict)).toEqual(['supports', 'contradicts']);
    expect(result.ok && result.value.callId).toBe(rec.calls[0]?.callId);
    expect(provider.requests[0]).toMatchObject({
      binding: { model: 'gpt-oss-120b' },
      tools: [],
      responseFormat: { name: 'result' },
    });
    expect(rec.calls[0]).toMatchObject({ route: 'judge', promptVersion: 'verifier@1' });
  });

  it('accepts JSON wrapped in a Markdown fence', async () => {
    const { result } = await run([{ text: `\`\`\`json\n${good}\n\`\`\`` }]);
    expect(result.ok).toBe(true);
  });

  it('repairs invalid JSON and missing answers with the errors, then gives up after two repairs', async () => {
    const partial = JSON.stringify({ verdicts: [{ index: 0, verdict: 'supports', reason: 'ok' }] });
    const repaired = await run([{ text: 'not json' }, { text: partial }, { text: good }]);
    expect(repaired.result.ok).toBe(true);
    const lastRepair = repaired.provider.requests[2]?.messages.at(-1);
    expect(lastRepair?.role === 'user' && lastRepair.content).toMatch(/no verdict for index 1/);

    const stubborn = await run([{ text: partial }, { text: partial }, { text: partial }]);
    expect(stubborn.result.ok || stubborn.result.error).toMatchObject({ code: 'LLM_OUTPUT_INVALID' });
    expect(stubborn.rec.calls).toHaveLength(3);
  });

  it('fails explicitly on refusal and truncation', async () => {
    const refused = await run([{ text: 'No.', stopReason: 'refusal' }]);
    expect(refused.result.ok || refused.result.error).toMatchObject({ code: 'LLM_REFUSAL' });
    const cut = await run([{ text: '{"verdicts": [', stopReason: 'max_tokens' }]);
    expect(cut.result.ok || cut.result.error).toMatchObject({ code: 'LLM_TRUNCATED' });
  });
});

describe('model failures', () => {
  it('reports a refused account as an operator problem that is not retried', () => {
    const billing = toTaskFailure(new LlmCallError('billing', 'Provider 402: prepaid credit is used up.'));
    expect([billing.code, billing.failureClass]).toEqual(['PROVIDER_ACCOUNT', 'permanent']);
    expect(billing.message).toMatch(/credit or quota used up/);
    expect(toTaskFailure(new LlmCallError('auth', 'Provider 401')).code).toBe('PROVIDER_ACCOUNT');
    expect(toTaskFailure(new LlmCallError('unavailable', 'Provider 503')).failureClass).toBe('transient');
  });
});

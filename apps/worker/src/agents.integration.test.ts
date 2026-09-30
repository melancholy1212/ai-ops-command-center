// Discovery through the real scheduler, handler, recorder and database: the execution, its conversation,
// model calls, cost and spend are all recorded, and the execution's outcome follows the task's. The model is
// scripted and the MCP session is a fake here; evals run the real MCP server.
import { randomUUID } from 'node:crypto';
import { createLogger } from '@aoc/config/logger';
import type { Budget, ExecutionId, RunId } from '@aoc/contracts';
import { createRun, DEFAULT_RUN_BUDGET, saveBrief } from '@aoc/core';
import { createTasks, lockRun, recomputeRunStatus, settleRun } from '@aoc/core/testing';
import { withWorkspace } from '@aoc/db';
import { createTestHarness, type TestHarness, type TestTenant } from '@aoc/db/testing';
import { createScriptedProvider, LlmRouter, type ScriptedTurn } from '@aoc/llm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ToolClient } from './agents/tool-client';
import { createHandlers } from './handlers';
import { createScheduler, type Scheduler } from './scheduler';

const SOURCE = '5f0a3c1e-0000-4000-8000-0000000000aa';
const QUOTE = 'Northwind Climate, the Stockholm carbon accounting startup, raised a seed round';
const silent = createLogger('agents-test', 'silent');

let h: TestHarness;
let tenant: TestTenant;
const schedulers: Scheduler[] = [];

beforeAll(async () => {
  h = await createTestHarness();
  tenant = await h.createTenant('agents');
});
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map((s) => s.stop()));
  await h.admin.query('delete from public.runs where workspace_id = $1', [tenant.workspaceId]);
});
afterAll(async () => {
  await h.close();
});

/** A run with an approved brief and one ready discover_companies task (task-scoped, as evals use it). */
async function discoveryRun(budget: Budget = DEFAULT_RUN_BUDGET): Promise<RunId> {
  const runId = await createRun(h.db, { userId: tenant.userId }, tenant.workspaceId, {
    projectId: tenant.projectId,
    objective: 'Find seed-stage climate software companies in the Nordics.',
    budget,
  });
  const actor = { kind: 'system' } as const;
  await withWorkspace(h.db, tenant.workspaceId, async (tx) => {
    const run = await lockRun(tx, runId);
    await saveBrief(
      tx,
      run,
      {
        revision: 1,
        objective: run.objective,
        criteria: {
          sectorKeywords: ['climate software'],
          countries: ['SE', 'NO', 'DK', 'FI'],
          fundingWindow: { from: '2025-09-30', to: '2026-09-30' },
          fundingStages: ['seed'],
          maxCompanies: 3,
          peopleRoles: ['founder'],
          outreach: { enabled: false, maxCompanies: 0 },
        },
        assumptions: [],
        openQuestions: [],
        plannerExecutionId: randomUUID() as ExecutionId,
      },
      actor,
    );
    await createTasks(
      tx,
      run,
      {
        tasks: [
          {
            ref: 'discover',
            type: 'discover_companies',
            input: { type: 'discover_companies' },
            idempotencyKey: 'discover_companies',
          },
        ],
      },
      null,
      'run_start',
      actor,
    );
    await settleRun(tx, run, actor);
    await recomputeRunStatus(tx, run, actor);
  });
  return runId;
}

const fakeTools = (): ToolClient => ({
  tools: [
    { name: 'web_search', description: 'search', inputSchema: { type: 'object' } },
    { name: 'fetch_page', description: 'fetch', inputSchema: { type: 'object' } },
  ],
  call: (name) =>
    Promise.resolve(
      name === 'fetch_page'
        ? { ok: true, output: { sourceId: SOURCE, text: `${QUOTE}.`, offset: 0, totalChars: 80, links: [] } }
        : { ok: true, output: { results: [{ url: 'https://news.example/a', rank: 0 }] } },
    ),
  close: () => Promise.resolve(),
});

const claim = {
  subject: { kind: 'new_company', name: 'Northwind Climate', domainHint: 'northwind.example' },
  assertion: { attribute: 'company.hq_country', value: { country: 'SE' } },
  rawValue: 'Stockholm',
  evidence: [{ sourceId: SOURCE, quote: QUOTE }],
};
const usage = (inputTokens: number) => ({
  inputTokens,
  outputTokens: 500,
  reasoningTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
});
const call = (name: string, args: unknown, n: number, inputTokens = 10_000): ScriptedTurn => ({
  toolCalls: [{ id: `call_${String(n)}`, name, argumentsJson: JSON.stringify(args) }],
  usage: usage(inputTokens),
});

function start(turns: ScriptedTurn[]) {
  const scheduler = createScheduler({
    db: h.db,
    workerId: `agents-${randomUUID().slice(0, 6)}`,
    log: silent,
    handlers: createHandlers({
      router: new LlmRouter({ providers: [createScriptedProvider(turns, { account: 'earthruntime' })] }),
      mintToken: () => Promise.resolve('test-token'),
      connectTools: () => Promise.resolve(fakeTools()),
    }),
    idlePollMs: 50,
    reapIntervalMs: 3_600_000,
    heartbeatIntervalMs: 1_000,
    leaseSeconds: 10,
    retryPolicy: { baseMs: 0, maxMs: 0, jitterMs: 0 },
  });
  schedulers.push(scheduler);
  scheduler.start();
}

async function waitForTask(runId: RunId, statuses: string[]) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { rows } = await h.admin.query<{ status: string }>(`select status from public.tasks where run_id = $1`, [
      runId,
    ]);
    if (rows[0] && statuses.includes(rows[0].status)) return rows[0].status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for the discovery task');
}

async function execution(runId: RunId) {
  const { rows } = await h.admin.query<{
    id: string;
    status: string;
    output: { claims: unknown[] } | null;
    failure: { code: string } | null;
    turns: number;
    llm_calls: number;
    tool_calls: number;
    cost_usd_micros: string;
    prompt_hash: string;
    agent_version: string;
  }>('select * from public.agent_executions where run_id = $1', [runId]);
  return rows;
}

describe('discovery agent', () => {
  it('runs the Research agent to a result and records the whole execution', async () => {
    const runId = await discoveryRun();
    start([
      call('web_search', { query: 'Nordic climate software seed round' }, 1),
      call('fetch_page', { url: 'https://news.example/a' }, 2),
      call('submit_result', { claims: [claim] }, 3),
    ]);
    expect(await waitForTask(runId, ['succeeded', 'failed'])).toBe('succeeded');

    const [exec] = await execution(runId);
    expect(exec).toMatchObject({
      status: 'succeeded',
      turns: 3,
      llm_calls: 3,
      tool_calls: 2,
      agent_version: 'research.discovery@3',
    });
    expect(exec?.output?.claims).toHaveLength(1);
    // gpt-oss-120b: (10,000 x 0.03 + 500 x 0.17) micro-USD per call = 385.
    expect(exec?.cost_usd_micros).toBe(String(3 * 385));

    const { rows: calls } = await h.admin.query<{
      seq: number;
      model: string;
      route: string;
      cost_usd_micros: string;
      stop_reason: string;
    }>(
      'select seq, model, route, cost_usd_micros, stop_reason from public.llm_calls where execution_id = $1 order by seq',
      [exec?.id],
    );
    expect(calls.map((c) => [c.seq, c.model, c.route, c.cost_usd_micros, c.stop_reason])).toEqual([
      [0, 'gpt-oss-120b', 'agent_loop', '385', 'tool_use'],
      [1, 'gpt-oss-120b', 'agent_loop', '385', 'tool_use'],
      [2, 'gpt-oss-120b', 'agent_loop', '385', 'tool_use'],
    ]);
    const { rows: messages } = await h.admin.query<{ role: string }>(
      'select role from public.agent_messages where execution_id = $1 order by seq',
      [exec?.id],
    );
    expect(messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
      'tool',
    ]);

    const { rows: run } = await h.admin.query<{
      spend_cost_usd_micros: string;
      spend_llm_input_tokens: string;
      spend_llm_output_tokens: string;
    }>('select spend_cost_usd_micros, spend_llm_input_tokens, spend_llm_output_tokens from public.runs where id = $1', [
      runId,
    ]);
    expect(run[0]).toEqual({
      spend_cost_usd_micros: '1155',
      spend_llm_input_tokens: '30000',
      spend_llm_output_tokens: '1500',
    });
    const { rows: task } = await h.admin.query<{ output: { summary: unknown } }>(
      'select output from public.tasks where run_id = $1',
      [runId],
    );
    expect(task[0]?.output.summary).toEqual({ claimsProposed: 1, companies: 1 });
  });

  it('fails the execution with the task when the model refuses', async () => {
    const runId = await discoveryRun();
    start([{ text: 'I will not do that.', stopReason: 'refusal', usage: usage(1000) }]);
    expect(await waitForTask(runId, ['succeeded', 'failed'])).toBe('failed');
    const [exec] = await execution(runId);
    expect([exec?.status, exec?.failure?.code]).toEqual(['failed', 'LLM_REFUSAL']);
    const { rows } = await h.admin.query<{ status: string }>('select status from public.runs where id = $1', [runId]);
    expect(rows[0]?.status).toBe('failed');
  });

  it('pauses the run for a budget extension when the budget runs out mid-attempt', async () => {
    // Enough to start (agent loops are estimated at 150,000 tokens), not enough after one expensive call.
    const runId = await discoveryRun({ ...DEFAULT_RUN_BUDGET, maxLlmTokens: 150_000 });
    start([
      call('web_search', { query: 'Nordic climate software seed round' }, 1, 200_000),
      call('submit_result', { claims: [] }, 2),
    ]);
    const deadline = Date.now() + 15_000;
    let run: { status: string; pause_reason: string | null } | undefined;
    while (Date.now() < deadline) {
      ({
        rows: [run],
      } = await h.admin.query<{ status: string; pause_reason: string | null }>(
        'select status, pause_reason from public.runs where id = $1',
        [runId],
      ));
      if (run?.status === 'paused') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(run).toEqual({ status: 'paused', pause_reason: 'budget_exhausted' });
    const { rows: task } = await h.admin.query<{ status: string; attempt: number }>(
      'select status, attempt from public.tasks where run_id = $1',
      [runId],
    );
    expect(task[0]).toEqual({ status: 'ready', attempt: 0 });
    const [exec] = await execution(runId);
    expect([exec?.status, exec?.failure?.code]).toEqual(['abandoned', 'BUDGET_EXHAUSTED']);
    const { rows: approvals } = await h.admin.query<{ type: string }>(
      `select type from public.approvals where run_id = $1 and status = 'pending'`,
      [runId],
    );
    expect(approvals).toEqual([{ type: 'budget_extension' }]);
  });
});

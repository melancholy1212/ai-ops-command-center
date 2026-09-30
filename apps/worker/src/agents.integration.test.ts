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

/** The snapshot the fake fetch_page points at, saved as the MCP server would have saved it. */
async function saveSource(): Promise<void> {
  const text = `${QUOTE} led by Nordic Seed Partners. Northwind Climate AB is headquartered in Stockholm, Sweden.`;
  await h.admin.query(
    `insert into public.sources (id, workspace_id, requested_url, final_url, final_url_hash, host, registrable_domain,
       source_type, tier, origin, retrieved_at, http, published_at_method, raw_sha256, content_sha256, text, text_length,
       truncated, extraction_method, extractor_version, fetched_by_tool_call_id, published_at)
     values ($1, $2, 'https://news.example/a', 'https://news.example/a', $3, 'news.example', 'news.example', 'news_article',
       'B', '{"kind":"search_result"}', now(), '{"status":200}', 'html_meta', $3, $4, $5, char_length($5), false,
       'readability_html', 'extract@1', gen_random_uuid(), '2026-03-12T08:00:00Z')
     on conflict (id) do nothing`,
    [SOURCE, tenant.workspaceId, 'a'.repeat(64), 'b'.repeat(64), text],
  );
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

async function waitForTask(runId: RunId, statuses: string[], type = 'discover_companies') {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { rows } = await h.admin.query<{ status: string }>(
      `select status from public.tasks where run_id = $1 and type = $2`,
      [runId, type],
    );
    if (rows[0] && statuses.includes(rows[0].status)) return rows[0].status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for the ${type} task`);
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
    await saveSource();
    const runId = await discoveryRun();
    start([
      call('web_search', { query: 'Nordic climate software seed round' }, 1),
      call('fetch_page', { url: 'https://news.example/a' }, 2),
      call('submit_result', { claims: [claim] }, 3),
      // The verifier's structured answer for the one grounded quote.
      {
        text: JSON.stringify({
          verdicts: [{ index: 0, verdict: 'supports', reason: 'The quote places it in Stockholm.' }],
        }),
        usage: usage(2_000),
      },
    ]);
    expect(await waitForTask(runId, ['succeeded', 'failed'])).toBe('succeeded');

    const [exec] = await execution(runId);
    expect(exec).toMatchObject({
      status: 'succeeded',
      turns: 3,
      llm_calls: 3,
      tool_calls: 2,
      agent_version: 'research.discovery@4',
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

    const { rows: task } = await h.admin.query<{ output: { summary: unknown } }>(
      "select output from public.tasks where run_id = $1 and type = 'discover_companies'",
      [runId],
    );
    expect(task[0]?.output.summary).toEqual({ claimsProposed: 1, companies: 1 });

    // Code grounded and saved the proposal, then expanded the graph from it.
    const { rows: claims } = await h.admin.query<{
      attribute: string;
      status: string;
      statement: string;
      company: string;
      domain: string;
    }>(
      `select c.attribute, c.status, c.statement, co.name as company, co.primary_domain as domain
       from public.claims c join public.companies co on co.id = c.subject_company_id where c.run_id = $1`,
      [runId],
    );
    expect(claims).toEqual([
      {
        attribute: 'company.hq_country',
        status: 'grounded',
        statement: 'Northwind Climate is headquartered in Sweden.',
        company: 'Northwind Climate',
        domain: 'northwind.example',
      },
    ]);
    const { rows: evidence } = await h.admin.query<{ grounding: string; value_in_quote: boolean }>(
      `select e.grounding, e.value_in_quote from public.evidence e join public.claims c on c.id = e.claim_id where c.run_id = $1`,
      [runId],
    );
    expect(evidence).toEqual([{ grounding: 'exact', value_in_quote: true }]);
    const { rows: created } = await h.admin.query<{ type: string; status: string }>(
      `select type, status from public.tasks where run_id = $1 and type <> 'discover_companies' order by type`,
      [runId],
    );
    expect(created.map((t) => t.type)).toEqual(['compile_report', 'verify_entity']);
    // The report waits for verification (softly: a failed verification still gets reported).
    const { rows: edges } = await h.admin.query<{ mode: string; on: string }>(
      `select d.mode, p.type as on from public.task_dependencies d join public.tasks t on t.id = d.task_id
       join public.tasks p on p.id = d.depends_on_task_id where t.run_id = $1 and t.type = 'compile_report'`,
      [runId],
    );
    expect(edges).toEqual([{ mode: 'soft', on: 'verify_entity' }]);

    // Verification runs next: the judge's verdict, policy v1 and confidence, then coverage gaps.
    expect(await waitForTask(runId, ['succeeded', 'failed'], 'verify_entity')).toBe('succeeded');
    const { rows: verified } = await h.admin.query<{ status: string; confidence: string; verdict: string }>(
      `select c.status, c.confidence, e.judge_verdict as verdict from public.claims c join public.evidence e on e.claim_id = c.id
       where c.run_id = $1`,
      [runId],
    );
    // One tier-B article, not the company's own site: probable, medium confidence.
    expect(verified).toEqual([{ status: 'probable', confidence: 'medium', verdict: 'supports' }]);
    const { rows: gaps } = await h.admin.query<{ attribute: string }>(
      'select attribute from public.research_gaps where run_id = $1 order by attribute',
      [runId],
    );
    expect(gaps.map((g) => g.attribute)).toEqual(['company.funding_round', 'company.sector', 'company.website']);
    const { rows: verifierRuns } = await h.admin.query<{ agent: string; status: string; llm_calls: number }>(
      `select agent, status, llm_calls from public.agent_executions where run_id = $1 and agent = 'verifier'`,
      [runId],
    );
    expect(verifierRuns).toEqual([{ agent: 'verifier', status: 'succeeded', llm_calls: 1 }]);
    // The run's spend: three discovery calls (3 x 385) and the verifier's (2,000 x 0.03 + 500 x 0.17 = 145).
    const { rows: run } = await h.admin.query<{
      spend_cost_usd_micros: string;
      spend_llm_input_tokens: string;
      spend_llm_output_tokens: string;
    }>('select spend_cost_usd_micros, spend_llm_input_tokens, spend_llm_output_tokens from public.runs where id = $1', [
      runId,
    ]);
    expect(run[0]).toEqual({
      spend_cost_usd_micros: '1300',
      spend_llm_input_tokens: '32000',
      spend_llm_output_tokens: '2000',
    });
    expect(await waitForTask(runId, ['succeeded', 'failed'], 'compile_report')).toBe('succeeded');
  }, 30_000);

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
      "select status, attempt from public.tasks where run_id = $1 and type = 'discover_companies'",
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

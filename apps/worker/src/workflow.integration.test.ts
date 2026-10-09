// The whole workflow (version 2) through the real engine, scheduler, handlers and database: plan -> human
// approval -> discover -> profile -> verify -> report. Only the model and the MCP session are scripted.
import { randomUUID } from 'node:crypto';
import { createLogger } from '@aoc/config/logger';
import type { ApprovalId, RunId, SourceId } from '@aoc/contracts';
import { createRun, decideApproval, startRun } from '@aoc/core';
import { createTestHarness, type TestHarness, type TestTenant } from '@aoc/db/testing';
import { createScriptedProvider, LlmRouter, type ScriptedTurn } from '@aoc/llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolClient } from './agents/tool-client';
import { createHandlers } from './handlers';
import { createScheduler, type Scheduler } from './scheduler';

const silent = createLogger('workflow-test', 'silent');
let h: TestHarness;
let tenant: TestTenant;
let scheduler: Scheduler | null = null;
let sourceId: SourceId;

const RELEASE =
  'Northwind Climate AB today announced a EUR 4 million seed round led by Nordic Seed Partners. Northwind Climate is headquartered in Stockholm, Sweden, and builds carbon accounting software for manufacturers.';

beforeAll(async () => {
  h = await createTestHarness();
  tenant = await h.createTenant('workflow');
  const { rows } = await h.admin.query<{ id: SourceId }>(
    `insert into public.sources (workspace_id, requested_url, final_url, final_url_hash, host, registrable_domain, source_type,
       tier, origin, retrieved_at, http, published_at_method, raw_sha256, content_sha256, text, text_length, truncated,
       extraction_method, extractor_version, fetched_by_tool_call_id, published_at)
     values ($1, 'https://www.prnewswire.com/northwind', 'https://www.prnewswire.com/northwind', $2, 'www.prnewswire.com',
       'prnewswire.com', 'press_release', 'C', '{"kind":"search_result"}', now(), '{"status":200}', 'html_meta', $2, $3, $4,
       char_length($4), false, 'readability_html', 'extract@1', gen_random_uuid(), '2026-03-12T08:00:00Z')
     returning id`,
    [tenant.workspaceId, 'c'.repeat(64), 'd'.repeat(64), RELEASE],
  );
  sourceId = rows[0]!.id;
});

afterAll(async () => {
  await scheduler?.stop();
  await h.admin.query('delete from public.runs where workspace_id = $1', [tenant.workspaceId]);
  await h.close();
});

const usage = {
  inputTokens: 5_000,
  outputTokens: 400,
  reasoningTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
};
const json = (value: unknown): ScriptedTurn => ({ text: JSON.stringify(value), usage });
const tool = (id: string, name: string, args: unknown): ScriptedTurn => ({
  toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }],
  usage,
});

function script(): ScriptedTurn[] {
  return [
    // plan_run: the planner's proposal.
    json({
      sectorKeywords: ['climate software', 'carbon accounting'],
      places: ['Nordics'],
      fundingWindow: null,
      fundingStages: ['seed'],
      maxCompanies: 3,
      peopleRoles: ['founder'],
      assumptions: [{ field: 'fundingStages', assumed: 'seed', reason: '"seed-stage" in the objective.' }],
      openQuestions: [],
    }),
    // discover_companies: search, read, submit.
    tool('c1', 'web_search', { query: 'Nordic climate software seed round' }),
    tool('c2', 'fetch_page', { url: 'https://www.prnewswire.com/northwind' }),
    tool('c3', 'submit_result', {
      claims: [
        {
          subject: { kind: 'new_company', name: 'Northwind Climate', domainHint: 'northwind.example' },
          assertion: {
            attribute: 'company.funding_round',
            value: {
              stage: 'seed',
              amount: 4_000_000,
              currency: 'EUR',
              announcedOn: '2026-03-12',
              leadInvestors: ['Nordic Seed Partners'],
              otherInvestors: [],
            },
          },
          rawValue: 'EUR 4 million seed round',
          evidence: [{ sourceId, quote: 'Northwind Climate AB today announced a EUR 4 million seed round' }],
        },
        {
          subject: { kind: 'new_company', name: 'Northwind Climate', domainHint: 'northwind.example' },
          assertion: { attribute: 'company.hq_country', value: { country: 'SE' } },
          rawValue: 'Stockholm, Sweden',
          evidence: [{ sourceId, quote: 'Northwind Climate is headquartered in Stockholm, Sweden' }],
        },
      ],
    }),
    // profile_company: the company's domain came with discovery; its profile finds nothing to add.
    tool('c4', 'submit_result', { claims: [] }),
    // verify_entity: one verdict per grounded quote.
    json({
      verdicts: [
        { index: 0, verdict: 'supports', reason: 'The release announces the round.' },
        { index: 1, verdict: 'supports', reason: 'The release states Stockholm, Sweden.' },
      ],
    }),
  ];
}

const tools = (): ToolClient => ({
  tools: [
    { name: 'web_search', description: 'search', inputSchema: { type: 'object' } },
    { name: 'fetch_page', description: 'fetch', inputSchema: { type: 'object' } },
  ],
  call: (name) =>
    Promise.resolve(
      name === 'fetch_page'
        ? { ok: true, output: { sourceId, text: RELEASE, offset: 0, totalChars: RELEASE.length, links: [] } }
        : { ok: true, output: { results: [{ url: 'https://www.prnewswire.com/northwind', rank: 0 }] } },
    ),
  close: () => Promise.resolve(),
});

async function waitFor<T>(read: () => Promise<T | undefined>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('workflow version 2', () => {
  it('goes from an objective to a report: plan, approval, discovery, profile, verification, report', async () => {
    const user = { userId: tenant.userId };
    const runId: RunId = await createRun(h.db, user, tenant.workspaceId, {
      projectId: tenant.projectId,
      objective: 'Find seed-stage climate software startups in the Nordics that raised money in the last 12 months.',
    });
    await startRun(h.db, user, tenant.workspaceId, { runId });
    scheduler = createScheduler({
      db: h.db,
      workerId: `workflow-${randomUUID().slice(0, 6)}`,
      log: silent,
      handlers: createHandlers({
        router: new LlmRouter({ providers: [createScriptedProvider(script(), { account: 'earthruntime' })] }),
        mintToken: () => Promise.resolve('test-token'),
        connectTools: () => Promise.resolve(tools()),
        now: () => new Date('2026-09-30T12:00:00Z'),
      }),
      idlePollMs: 50,
      reapIntervalMs: 3_600_000,
      heartbeatIntervalMs: 1_000,
      leaseSeconds: 10,
    });
    scheduler.start();

    // The plan waits for a human, who approves exactly the snapshot they were shown.
    const approval = await waitFor(async () => {
      const { rows } = await h.admin.query<{
        id: ApprovalId;
        snapshot_hash: string;
        snapshot: { criteria: { countries: string[] }; assumptions: { field: string }[] };
      }>(
        `select id, snapshot_hash, snapshot from public.approvals where run_id = $1 and status = 'pending' and type = 'plan'`,
        [runId],
      );
      return rows[0];
    }, 'the plan approval');
    expect(approval.snapshot.criteria.countries).toEqual(['SE', 'NO', 'DK', 'FI', 'IS']);
    expect(approval.snapshot.assumptions.map((a) => a.field)).toEqual(
      expect.arrayContaining(['countries', 'fundingWindow', 'outreach']),
    );
    await decideApproval(h.db, user, tenant.workspaceId, {
      approvalId: approval.id,
      decision: 'approved',
      snapshotHashSeen: approval.snapshot_hash,
      reason: null,
    });

    const run = await waitFor(async () => {
      const { rows } = await h.admin.query<{ status: string }>('select status from public.runs where id = $1', [runId]);
      return rows[0] && ['completed', 'failed', 'cancelled'].includes(rows[0].status) ? rows[0] : undefined;
    }, 'the run to finish');
    expect(run.status).toBe('completed');

    const { rows: claims } = await h.admin.query<{ attribute: string; status: string; confidence: string }>(
      'select attribute, status, confidence from public.claims where run_id = $1 order by attribute',
      [runId],
    );
    // The company's press release is authoritative for its funding round; one source is probable for its country.
    expect(claims).toEqual([
      { attribute: 'company.funding_round', status: 'verified', confidence: 'high' },
      { attribute: 'company.hq_country', status: 'probable', confidence: 'medium' },
    ]);

    const { rows: reports } = await h.admin.query<{
      status: string;
      version: number;
      content: {
        companies: { rank: number; claimIds: string[]; gapIds: string[]; scoreFindingId: string }[];
        excluded: unknown[];
      };
    }>(`select status, version, content from public.artifacts where run_id = $1 and kind = 'prospect_report'`, [runId]);
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect([report.status, report.version]).toEqual(['final', 1]);
    expect(report.content.companies).toHaveLength(1);
    expect(report.content.companies[0]).toMatchObject({ rank: 1 });
    expect(report.content.companies[0]?.claimIds).toHaveLength(2);
    expect(report.content.companies[0]?.gapIds).toHaveLength(2); // website and sector: unavailable
    expect(report.content.excluded).toEqual([]);

    const { rows: findings } = await h.admin.query<{
      kind: string;
      label: string;
      author_kind: string;
      statement: string;
      basis: number;
    }>(
      `select f.kind, f.label, f.author_kind, f.statement, count(fc.claim_id)::int as basis from public.findings f
       join public.finding_claims fc on fc.finding_id = f.id where f.run_id = $1 group by f.id`,
      [runId],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'score', label: 'fact_derived', author_kind: 'code', basis: 2 });
    expect(findings[0]?.statement).toMatch(/^Northwind Climate scores 0\.\d\d of 1 \(funding recency/);

    const { rows: statuses } = await h.admin.query<{ to: string }>(
      `select data ->> 'to' as to from public.run_events where run_id = $1 and type = 'run.status_changed' order by seq`,
      [runId],
    );
    expect(statuses.map((s) => s.to)).toEqual(['planning', 'awaiting_plan_approval', 'running', 'completed']);
    const { rows: agents } = await h.admin.query<{ agent: string }>(
      `select agent from public.agent_executions where run_id = $1 and status = 'succeeded' order by started_at`,
      [runId],
    );
    expect(agents.map((a) => a.agent)).toEqual(['planner', 'research', 'company_intelligence', 'verifier']);
    const { rows: version } = await h.admin.query<{ workflow_version: number }>(
      'select workflow_version from public.runs where id = $1',
      [runId],
    );
    expect(version[0]?.workflow_version).toBe(2);
  }, 60_000);
});

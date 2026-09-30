// Discovery persistence against the local database: entity resolution, grounding against saved snapshots,
// idempotent claims, rejection reasons, pre-score ranking and the expansion it drives.
import { randomUUID } from 'node:crypto';
import type { InterpretedCriteria, ProposedClaim, SourceId } from '@aoc/contracts';
import { withWorkspace } from '@aoc/db';
import { createTestHarness, type TestHarness, type TestTenant } from '@aoc/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRun } from './commands/runs';
import { discoveryExpansion, persistDiscovery, type DiscoveryContext } from './workflow/discovery';
import { applyVerification, judgeItems, loadCompanyForVerification } from './workflow/verify';

let h: TestHarness;
let tenant: TestTenant;

beforeAll(async () => {
  h = await createTestHarness();
  tenant = await h.createTenant('discovery');
});
afterEach(async () => {
  await h.admin.query('delete from public.runs where workspace_id = $1', [tenant.workspaceId]);
  await h.admin.query('delete from public.companies where workspace_id = $1', [tenant.workspaceId]);
});
afterAll(async () => {
  await h.close();
});

const criteria: InterpretedCriteria = {
  sectorKeywords: ['climate software'],
  countries: ['SE', 'NO'],
  fundingWindow: { from: '2025-09-30', to: '2026-09-30' },
  fundingStages: ['seed'],
  maxCompanies: 2,
  peopleRoles: ['founder'],
  outreach: { enabled: false, maxCompanies: 0 },
};

async function context(): Promise<DiscoveryContext> {
  const runId = await createRun(h.db, { userId: tenant.userId }, tenant.workspaceId, {
    projectId: tenant.projectId,
    objective: 'Find seed-stage climate software companies in the Nordics.',
  });
  const { rows: tasks } = await h.admin.query<{ id: string }>(
    `insert into public.tasks (run_id, workspace_id, type, kind, status, input, idempotency_key, max_attempts)
     values ($1, $2, 'discover_companies', 'agent_loop', 'blocked', '{"type":"discover_companies"}', 'discover', 2) returning id`,
    [runId, tenant.workspaceId],
  );
  const taskId = tasks[0]!.id;
  const { rows: executions } = await h.admin.query<{ id: string }>(
    `insert into public.agent_executions (workspace_id, run_id, task_id, agent, agent_version, prompt_hash, attempt, lease_token, input, limits)
     values ($1, $2, $3, 'research', 'research@test', $4, 1, $5, '{}', '{}') returning id`,
    [tenant.workspaceId, runId, taskId, 'a'.repeat(64), randomUUID()],
  );
  return {
    run: { id: runId, workspace_id: tenant.workspaceId },
    taskId,
    executionId: executions[0]!.id,
    agent: 'research',
    criteria,
    now: new Date('2026-09-30T12:00:00Z'),
  };
}

async function source(
  text: string,
  tier = 'B',
  publishedAt = '2026-03-12T08:00:00Z',
  domain = 'news.example',
  sourceType = 'news_article',
): Promise<SourceId> {
  const { rows } = await h.admin.query<{ id: SourceId }>(
    `insert into public.sources (workspace_id, requested_url, final_url, final_url_hash, host, registrable_domain, source_type,
       tier, origin, retrieved_at, http, published_at_method, raw_sha256, content_sha256, text, text_length, truncated,
       extraction_method, extractor_version, fetched_by_tool_call_id, published_at)
     values ($1, $2, $2, $3, $7, $7, $8, $5, '{"kind":"search_result"}', now(),
       '{"status":200}', 'html_meta', $3, $3, $4, char_length($4), false, 'readability_html', 'extract@1', gen_random_uuid(), $6)
     returning id`,
    [
      tenant.workspaceId,
      `https://${domain}/${randomUUID()}`,
      randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
      text,
      tier,
      publishedAt,
      domain,
      sourceType,
    ],
  );
  return rows[0]!.id;
}

const company = (name: string, domainHint: string | null = null) => ({
  kind: 'new_company' as const,
  name,
  domainHint,
});

function claim(
  subject: ReturnType<typeof company>,
  assertion: ProposedClaim['assertion'],
  sourceId: SourceId,
  quote: string,
): ProposedClaim {
  return { subject, assertion, rawValue: 'as stated', evidence: [{ sourceId, quote }] };
}

const ARTICLE =
  'Stockholm-based Northwind Climate has raised a EUR 4 million seed round led by Nordic Seed Partners. The company builds carbon accounting software for manufacturers.';

describe('persistDiscovery', () => {
  it('grounds quotes, writes claims and evidence, and resolves one company per domain', async () => {
    const ctx = await context();
    const s = await source(ARTICLE);
    const round: ProposedClaim['assertion'] = {
      attribute: 'company.funding_round',
      value: {
        stage: 'seed',
        amount: 4_000_000,
        currency: 'EUR',
        announcedOn: '2026-03-12',
        leadInvestors: ['Nordic Seed Partners'],
        otherInvestors: [],
      },
    };
    const result = await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      persistDiscovery(tx, ctx, [
        claim(
          company('Northwind Climate', 'www.northwind.example'),
          round,
          s,
          'Northwind Climate has raised a EUR 4 million seed round',
        ),
        claim(
          company('Northwind Climate AB', 'northwind.example'),
          { attribute: 'company.hq_country', value: { country: 'SE' } },
          s,
          'Stockholm-based Northwind Climate has raised a EUR 4 million seed round',
        ),
        // Proposed twice: one claim, the evidence merged (same quote is not duplicated).
        claim(
          company('Northwind Climate', 'northwind.example'),
          round,
          s,
          'Northwind Climate has raised a EUR 4 million seed round',
        ),
        claim(
          company('Northwind Climate', 'northwind.example'),
          { attribute: 'company.sector', value: { tags: ['climate software'] } },
          s,
          'The company builds carbon accounting software for manufacturers',
        ),
      ]),
    );
    expect(result.companies).toHaveLength(1);
    expect(result).toMatchObject({ grounded: 3, rejected: 0 });
    const { rows: companies } = await h.admin.query(
      'select name, primary_domain from public.companies where workspace_id = $1',
      [tenant.workspaceId],
    );
    expect(companies).toEqual([{ name: 'Northwind Climate', primary_domain: 'northwind.example' }]);
    const { rows: claims } = await h.admin.query<{ attribute: string; status: string; evidence: number }>(
      `select c.attribute, c.status, count(e.id)::int as evidence from public.claims c left join public.evidence e on e.claim_id = c.id
       where c.run_id = $1 group by c.id order by c.attribute`,
      [ctx.run.id],
    );
    expect(claims).toEqual([
      { attribute: 'company.funding_round', status: 'grounded', evidence: 1 },
      { attribute: 'company.hq_country', status: 'grounded', evidence: 1 },
      { attribute: 'company.sector', status: 'grounded', evidence: 1 },
    ]);
  });

  it('rejects claims whose quotes are not in the snapshot or too short, with the reason', async () => {
    const ctx = await context();
    const s = await source(ARTICLE);
    await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      persistDiscovery(tx, ctx, [
        claim(
          company('Northwind Climate', 'northwind.example'),
          { attribute: 'company.hq_city', value: { city: 'Malmo' } },
          s,
          'Northwind Climate opened its headquarters in Malmo last year',
        ),
        claim(
          company('Northwind Climate', 'northwind.example'),
          { attribute: 'company.founded_year', value: { year: 2023 } },
          s,
          'Northwind Climate has',
        ),
      ]),
    );
    const { rows } = await h.admin.query<{
      attribute: string;
      status: string;
      verification: { reasons: { code: string }[] };
    }>('select attribute, status, verification from public.claims where run_id = $1 order by attribute', [ctx.run.id]);
    expect(rows.map((r) => [r.attribute, r.status, r.verification.reasons.map((x) => x.code)])).toEqual([
      ['company.founded_year', 'rejected', ['QUOTE_TOO_SHORT']],
      ['company.hq_city', 'rejected', ['QUOTE_NOT_FOUND']],
    ]);
  });

  it('reuses a company known from an earlier run and learns its domain', async () => {
    const earlier = await context();
    const s = await source(ARTICLE);
    const hq = { attribute: 'company.hq_country', value: { country: 'SE' } } as const;
    await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      persistDiscovery(tx, earlier, [
        claim(company('Northwind Climate'), hq, s, 'Stockholm-based Northwind Climate has raised a EUR 4 million'),
      ]),
    );
    const later = await context();
    await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      persistDiscovery(tx, later, [
        claim(
          company('NORTHWIND CLIMATE AB', 'northwind.example'),
          hq,
          s,
          'Stockholm-based Northwind Climate has raised a EUR 4 million',
        ),
      ]),
    );
    const { rows } = await h.admin.query('select name, primary_domain from public.companies where workspace_id = $1', [
      tenant.workspaceId,
    ]);
    expect(rows).toEqual([{ name: 'Northwind Climate', primary_domain: 'northwind.example' }]);
  });

  it('ranks candidates by criteria fit and expands the top ones with a report waiting for all', async () => {
    const ctx = await context();
    const nordic = await source(
      'Oslo startup Fjordlight Energy Analytics has closed a NOK 30 million seed round led by Fjord Ventures.',
    );
    const us = await source('Denver-based Pinecrest Carbon raised a $25 million Series A led by Front Range Capital.');
    const sthlm = await source(ARTICLE);
    const result = await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      persistDiscovery(tx, ctx, [
        claim(
          company('Pinecrest Carbon', 'pinecrest.example'),
          { attribute: 'company.hq_country', value: { country: 'US' } },
          us,
          'Denver-based Pinecrest Carbon raised a $25 million Series A',
        ),
        claim(
          company('Fjordlight Energy Analytics', 'fjordlight.example'),
          { attribute: 'company.hq_country', value: { country: 'NO' } },
          nordic,
          'Oslo startup Fjordlight Energy Analytics has closed a NOK 30 million seed round',
        ),
        claim(
          company('Northwind Climate', 'northwind.example'),
          {
            attribute: 'company.funding_round',
            value: {
              stage: 'seed',
              amount: 4_000_000,
              currency: 'EUR',
              announcedOn: '2026-03-12',
              leadInvestors: [],
              otherInvestors: [],
            },
          },
          sthlm,
          'Northwind Climate has raised a EUR 4 million seed round',
        ),
      ]),
    );
    expect(result.companies.map((c) => c.name)).toEqual([
      'Northwind Climate',
      'Fjordlight Energy Analytics',
      'Pinecrest Carbon',
    ]);
    const plan = discoveryExpansion(result.companies, criteria.maxCompanies);
    expect(plan.tasks.map((t) => t.type)).toEqual(['verify_entity', 'verify_entity', 'compile_report']);
    expect(plan.tasks.at(-1)?.dependsOn).toHaveLength(2);
    expect(discoveryExpansion([], 3).tasks.map((t) => t.type)).toEqual(['compile_report']);
  });
});

describe('applyVerification', () => {
  it('applies judge verdicts, policy, criteria, conflicts and confidence, and records coverage gaps', async () => {
    const ctx = await context();
    const release = await source(
      'Northwind Climate AB today announced a EUR 4 million seed round led by Nordic Seed Partners. Northwind Climate is headquartered in Stockholm, Sweden.',
      'C',
      '2026-03-12T08:00:00Z',
      'prnewswire.com',
      'press_release',
    );
    const news = await source(
      'Northwind Climate, which raised EUR 4.5 million in a seed round in March, builds carbon accounting software.',
    );
    const other = await source(
      'Northwind Climate also opened a sales office in Denver, United States, according to the company.',
    );
    const nw = company('Northwind Climate', 'northwind.example');
    const seed = (amount: number, announcedOn: string): ProposedClaim['assertion'] => ({
      attribute: 'company.funding_round',
      value: { stage: 'seed', amount, currency: 'EUR', announcedOn, leadInvestors: [], otherInvestors: [] },
    });
    await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      persistDiscovery(tx, ctx, [
        claim(
          nw,
          seed(4_000_000, '2026-03-12'),
          release,
          'Northwind Climate AB today announced a EUR 4 million seed round',
        ),
        claim(
          nw,
          seed(4_500_000, '2026-03-15'),
          news,
          'Northwind Climate, which raised EUR 4.5 million in a seed round in March',
        ),
        claim(
          nw,
          { attribute: 'company.hq_country', value: { country: 'SE' } },
          release,
          'Northwind Climate is headquartered in Stockholm, Sweden',
        ),
        claim(
          nw,
          { attribute: 'company.sector', value: { tags: ['carbon accounting'] } },
          news,
          'carbon accounting software',
        ),
        claim(
          nw,
          { attribute: 'company.hq_city', value: { city: 'Denver' } },
          other,
          'Northwind Climate also opened a sales office in Denver, United States',
        ),
      ]),
    );
    const { rows: companies } = await h.admin.query<{ id: string }>(
      'select id from public.companies where workspace_id = $1',
      [tenant.workspaceId],
    );
    const companyId = companies[0]!.id;
    const loaded = await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      loadCompanyForVerification(tx, ctx.run.id, companyId),
    );
    const items = judgeItems(loaded);
    // The too-short sector quote was rejected at grounding and never reaches the judge.
    expect(items).toHaveLength(4);
    const verdictFor = (statementPart: string) => items.find((i) => i.statement.includes(statementPart))!.evidenceId;
    const summary = await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      applyVerification(tx, { run: ctx.run, taskId: ctx.taskId, criteria, now: ctx.now }, loaded, [
        {
          evidenceId: verdictFor('EUR 4,000,000'),
          verdict: 'supports',
          reason: 'The release states the round.',
          llmCallId: null,
        },
        {
          evidenceId: verdictFor('EUR 4,500,000'),
          verdict: 'supports',
          reason: 'The article states the round.',
          llmCallId: null,
        },
        {
          evidenceId: verdictFor('headquartered'),
          verdict: 'supports',
          reason: 'States Stockholm, Sweden.',
          llmCallId: null,
        },
        {
          evidenceId: verdictFor('based in Denver'),
          verdict: 'contradicts',
          reason: 'A sales office is not the base.',
          llmCallId: null,
        },
      ]),
    );
    const { rows } = await h.admin.query<{
      statement: string;
      status: string;
      confidence: string | null;
      conflict_state: string;
      verification: { reasons: { code: string }[] };
    }>(
      'select statement, status, confidence, conflict_state, verification from public.claims where run_id = $1 order by statement',
      [ctx.run.id],
    );
    const byPart = (part: string) => rows.find((r) => r.statement.includes(part))!;
    // Two reports of the same seed round with amounts 12 % apart contest each other.
    expect([byPart('EUR 4,000,000').status, byPart('EUR 4,000,000').conflict_state]).toEqual([
      'contested',
      'conflicting',
    ]);
    expect(byPart('EUR 4,500,000').status).toBe('contested');
    // The company's own press release is authoritative for its headquarters... but one source is probable for hq.
    expect(byPart('headquartered').status).toBe('probable');
    expect(byPart('headquartered').confidence).toBe('medium');
    expect(byPart('based in Denver').verification.reasons.map((r) => r.code)).toContain('JUDGE_CONTRADICTS');
    expect(byPart('works in').verification.reasons.map((r) => r.code)).toEqual(['QUOTE_TOO_SHORT']);
    expect(summary).toMatchObject({ contested: 2, probable: 1, rejected: 2 });
    const { rows: gaps } = await h.admin.query<{ attribute: string; status: string; reason: string }>(
      'select attribute, status, reason from public.research_gaps where run_id = $1 order by attribute',
      [ctx.run.id],
    );
    expect(gaps).toEqual([
      { attribute: 'company.funding_round', status: 'unavailable', reason: 'conflict_unresolved' },
      { attribute: 'company.sector', status: 'unavailable', reason: 'only_rejected_claims' },
      { attribute: 'company.website', status: 'unavailable', reason: 'no_claim' },
    ]);
    const { rows: judged } = await h.admin.query<{ n: number }>(
      `select count(*)::int as n from public.evidence e join public.claims c on c.id = e.claim_id
       where c.run_id = $1 and e.judge_verdict is not null`,
      [ctx.run.id],
    );
    expect(judged[0]?.n).toBe(4);
    const { rows: country } = await h.admin.query('select country from public.companies where id = $1', [companyId]);
    expect(country[0]).toEqual({ country: 'SE' });
  });

  it('never sends an ungrounded quote to the judge, even when the claim has a grounded one', async () => {
    const ctx = await context();
    const s1 = await source(ARTICLE);
    const mixed: ProposedClaim = {
      subject: company('Northwind Climate', 'northwind.example'),
      assertion: { attribute: 'company.hq_country', value: { country: 'SE' } },
      rawValue: 'Stockholm',
      evidence: [
        { sourceId: s1, quote: 'Stockholm-based Northwind Climate has raised a EUR 4 million seed round' },
        { sourceId: s1, quote: 'Northwind Climate moved its head office to Stockholm in 2024' },
      ],
    };
    await withWorkspace(h.db, tenant.workspaceId, (tx) => persistDiscovery(tx, ctx, [mixed]));
    const { rows: companies } = await h.admin.query<{ id: string }>(
      'select id from public.companies where workspace_id = $1',
      [tenant.workspaceId],
    );
    const loaded = await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      loadCompanyForVerification(tx, ctx.run.id, companies[0]!.id),
    );
    expect(loaded.claims[0]?.evidence.map((e) => e.grounding).sort()).toEqual(['exact', 'not_found']);
    const items = judgeItems(loaded);
    expect(items.map((i) => i.quote)).toEqual([
      'Stockholm-based Northwind Climate has raised a EUR 4 million seed round',
    ]);
  });

  it('rejects a verified fact that takes the company outside the brief', async () => {
    const ctx = await context();
    const us = await source(
      'Denver-based Pinecrest Carbon raised a $25 million seed round led by Front Range Capital.',
    );
    const pc = company('Pinecrest Carbon', 'pinecrest.example');
    await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      persistDiscovery(tx, ctx, [
        claim(
          pc,
          { attribute: 'company.hq_country', value: { country: 'US' } },
          us,
          'Denver-based Pinecrest Carbon raised a $25 million seed round',
        ),
      ]),
    );
    const { rows: companies } = await h.admin.query<{ id: string }>(
      'select id from public.companies where workspace_id = $1',
      [tenant.workspaceId],
    );
    const loaded = await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      loadCompanyForVerification(tx, ctx.run.id, companies[0]!.id),
    );
    const [item] = judgeItems(loaded);
    await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      applyVerification(tx, { run: ctx.run, taskId: ctx.taskId, criteria, now: ctx.now }, loaded, [
        { evidenceId: item!.evidenceId, verdict: 'supports', reason: 'Denver-based.', llmCallId: null },
      ]),
    );
    const { rows } = await h.admin.query<{
      status: string;
      verification: { reasons: { code: string; detail: string }[] };
    }>('select status, verification from public.claims where run_id = $1', [ctx.run.id]);
    expect(rows[0]?.status).toBe('rejected');
    expect(rows[0]?.verification.reasons.find((r) => r.code === 'OUTSIDE_CRITERIA')?.detail).toMatch(/outside SE, NO/);
  });
});

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
import { compileReport } from './workflow/report';
import { canonicalJson, sha256Hex } from './canonical-json';

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

  it('joins a mention without a domain to the company of that name, and keeps ambiguous namesakes apart', async () => {
    const ctx = await context();
    const s1 = await source(ARTICLE);
    const hqSe = { attribute: 'company.hq_country', value: { country: 'SE' } } as const;
    const quote = 'Stockholm-based Northwind Climate has raised a EUR 4 million seed round';
    // One run: the agent gives the domain on one claim and leaves it out on the next.
    const first = await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      persistDiscovery(tx, ctx, [
        claim(company('Northwind Climate', 'northwind.example'), hqSe, s1, quote),
        claim(
          company('NORTHWIND CLIMATE AB', null),
          { attribute: 'company.sector', value: { tags: ['carbon accounting'] } },
          s1,
          'The company builds carbon accounting software for manufacturers',
        ),
      ]),
    );
    expect(first.companies).toHaveLength(1);

    // Namesakes: two companies called Nova with different domains. A bare "Nova" in a new run is ambiguous and
    // stays apart; once this run has named one of them, a bare mention joins that one.
    for (const domain of ['nova-a.example', 'nova-b.example']) {
      await withWorkspace(h.db, tenant.workspaceId, async (tx) =>
        persistDiscovery(tx, await context(), [claim(company('Nova', domain), hqSe, s1, quote)]),
      );
    }
    const ambiguous = await withWorkspace(h.db, tenant.workspaceId, async (tx) =>
      persistDiscovery(tx, await context(), [claim(company('Nova', null), hqSe, s1, quote)]),
    );
    const named = await context();
    const joined = await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      persistDiscovery(tx, named, [
        claim(company('Nova', 'nova-b.example'), hqSe, s1, quote),
        claim(
          company('Nova', null),
          { attribute: 'company.sector', value: { tags: ['carbon accounting'] } },
          s1,
          'The company builds carbon accounting software for manufacturers',
        ),
      ]),
    );
    const { rows } = await h.admin.query<{ id: string; primary_domain: string | null }>(
      `select id, primary_domain from public.companies where workspace_id = $1 and normalized_name = 'nova' order by created_at`,
      [tenant.workspaceId],
    );
    expect(rows.map((r) => r.primary_domain)).toEqual(['nova-a.example', 'nova-b.example', null]);
    expect(ambiguous.companies.map((c) => c.id)).toEqual([rows[2]?.id]);
    expect(joined.companies.map((c) => c.id)).toEqual([rows[1]?.id]);
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
    // The judge never sees a round's date; code checks it.
    expect(items.filter((i) => i.statement.includes('round')).map((i) => / on \d{4}-/.test(i.statement))).toEqual([
      false,
      false,
    ]);
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
    // Dates are checked against publication dates by code: the release appeared the day of the round; the
    // article is dated three days before the round it supposedly reports.
    const codes = (part: string) => byPart(part).verification.reasons.map((r) => r.code);
    expect(codes('EUR 4,000,000')).not.toContain('DATE_UNVERIFIED');
    expect(codes('EUR 4,500,000')).toContain('DATE_UNVERIFIED');
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

describe('compileReport', () => {
  async function verifyTask(runId: string, companyId: string, status: 'succeeded' | 'failed') {
    await h.admin.query(
      `insert into public.tasks (run_id, workspace_id, type, kind, status, subject_company_id, input, output, idempotency_key,
         attempt, max_attempts, finished_at)
       values ($1, $2, 'verify_entity', 'structured_llm', $3, $4, jsonb_build_object('type', 'verify_entity', 'companyId', $5::text),
         case when $3 = 'succeeded' then '{}'::jsonb end, 'verify_entity:' || $5 || ':r1', 1, 2, now())`,
      [runId, tenant.workspaceId, status, companyId, companyId],
    );
  }

  it('ranks included companies by a code score, excludes the rest with reasons, and versions the report', async () => {
    const ctx = await context();
    const release = await source(
      'Northwind Climate AB today announced a EUR 4 million seed round led by Nordic Seed Partners. Northwind Climate is headquartered in Stockholm, Sweden.',
      'C',
      '2026-03-12T08:00:00Z',
      'prnewswire.com',
      'press_release',
    );
    const oslo = await source(
      'Oslo-based Fjordlight Energy Analytics closed a NOK 30 million seed round in November, led by Fjord Ventures.',
      'B',
      '2025-11-02T08:00:00Z',
    );
    const denver = await source(
      'Denver-based Pinecrest Carbon raised a $2 million seed round led by Front Range Capital.',
    );
    const other = await source(
      'Bergen-based Tidewater Systems and Aarhus-based Kelpworks both build software for fish farms, the report says.',
    );
    const round = (amount: number, currency: string, announcedOn: string): ProposedClaim['assertion'] => ({
      attribute: 'company.funding_round',
      value: { stage: 'seed', amount, currency, announcedOn, leadInvestors: [], otherInvestors: [] },
    });
    const hq = (country: string): ProposedClaim['assertion'] => ({
      attribute: 'company.hq_country',
      value: { country },
    });
    const nw = company('Northwind Climate', 'northwind.example');
    const fj = company('Fjordlight Energy Analytics', 'fjordlight.example');
    const pc = company('Pinecrest Carbon', 'pinecrest.example');
    const tw = company('Tidewater Systems', 'tidewater.example');
    const kw = company('Kelpworks', 'kelpworks.example');
    const gh = company('Ghost Grid', 'ghostgrid.example');
    // Found first (an earlier transaction), yet listed last: verification never saw them.
    const early = await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      persistDiscovery(tx, ctx, [
        claim(kw, hq('DK'), other, 'Bergen-based Tidewater Systems and Aarhus-based Kelpworks both build software'),
        claim(gh, hq('FI'), other, 'Ghost Grid is headquartered in Helsinki and sells grid software'),
      ]),
    );
    const discovered = await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      persistDiscovery(tx, ctx, [
        claim(
          nw,
          round(4_000_000, 'EUR', '2026-03-12'),
          release,
          'Northwind Climate AB today announced a EUR 4 million seed round',
        ),
        claim(nw, hq('SE'), release, 'Northwind Climate is headquartered in Stockholm, Sweden'),
        claim(
          fj,
          round(30_000_000, 'NOK', '2025-11-02'),
          oslo,
          'Fjordlight Energy Analytics closed a NOK 30 million seed round',
        ),
        claim(fj, hq('NO'), oslo, 'Oslo-based Fjordlight Energy Analytics closed a NOK 30 million seed round'),
        claim(pc, hq('US'), denver, 'Denver-based Pinecrest Carbon raised a $2 million seed round'),
        claim(tw, hq('NO'), other, 'Bergen-based Tidewater Systems and Aarhus-based Kelpworks both build software'),
      ]),
    );
    const id = (name: string) => [...early.companies, ...discovered.companies].find((c) => c.name === name)!.id;
    // Kelpworks was never verified (not in the top N); Tidewater's verification failed; the rest succeeded.
    for (const name of ['Northwind Climate', 'Fjordlight Energy Analytics', 'Pinecrest Carbon']) {
      await verifyTask(ctx.run.id, id(name), 'succeeded');
      const loaded = await withWorkspace(h.db, tenant.workspaceId, (tx) =>
        loadCompanyForVerification(tx, ctx.run.id, id(name)),
      );
      const verdicts = judgeItems(loaded).map((i) => ({
        evidenceId: i.evidenceId,
        verdict: 'supports' as const,
        reason: 'Stated.',
        llmCallId: null,
      }));
      await withWorkspace(h.db, tenant.workspaceId, (tx) =>
        applyVerification(tx, { run: ctx.run, taskId: ctx.taskId, criteria, now: ctx.now }, loaded, verdicts),
      );
    }
    await verifyTask(ctx.run.id, id('Tidewater Systems'), 'failed');

    const report = await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      compileReport(tx, { run: ctx.run, criteria, now: ctx.now }),
    );
    expect(report).toMatchObject({ included: 2, excluded: 4 });
    const { rows: artifacts } = await h.admin.query<{
      id: string;
      status: string;
      version: number;
      content_hash: string;
      content: {
        companies: { companyId: string; rank: number; scoreFindingId: string; claimIds: string[]; gapIds: string[] }[];
        excluded: { companyId: string; reason: string; claimIds: string[] }[];
        excludedOmitted: number;
      };
    }>('select id, status, version, content_hash, content from public.artifacts where id = $1', [report.artifactId]);
    const artifact = artifacts[0]!;
    expect([artifact.status, artifact.version]).toEqual(['final', 1]);
    expect(artifact.content_hash).toBe(sha256Hex(canonicalJson(artifact.content)));
    // The newer, press-release-backed round ranks first.
    expect(artifact.content.companies.map((c) => [c.companyId, c.rank])).toEqual([
      [id('Northwind Climate'), 1],
      [id('Fjordlight Energy Analytics'), 2],
    ]);
    expect(artifact.content.companies[0]?.gapIds.length).toBeGreaterThan(0);
    const excluded = new Map(artifact.content.excluded.map((e) => [e.companyId, e]));
    expect(excluded.get(id('Pinecrest Carbon'))?.reason).toMatch(/US/);
    expect(excluded.get(id('Pinecrest Carbon'))?.claimIds).toHaveLength(1);
    expect(excluded.get(id('Tidewater Systems'))?.reason).toBe('Verification did not complete.');
    expect(excluded.get(id('Kelpworks'))?.reason).toBe('Not among the top 2 candidates after discovery.');
    expect(excluded.get(id('Ghost Grid'))?.reason).toMatch(/^No claim survived grounding/);
    expect(excluded.get(id('Ghost Grid'))?.claimIds).toHaveLength(1);
    // Verified exclusions are listed before the ones verification never saw; none were omitted.
    expect(artifact.content.excluded.map((e) => e.companyId).slice(-2)).toEqual([id('Kelpworks'), id('Ghost Grid')]);
    expect(artifact.content.excludedOmitted).toBe(0);

    const { rows: scores } = await h.admin.query<{
      id: string;
      subject_company_id: string;
      score: { total: number; components: { criterion: string; weight: number; value: number }[] };
      basis: string[];
    }>(
      `select f.id, f.subject_company_id, f.score, array_agg(fc.claim_id order by fc.claim_id) as basis from public.findings f
       join public.finding_claims fc on fc.finding_id = f.id where f.run_id = $1 group by f.id`,
      [ctx.run.id],
    );
    expect(scores).toHaveLength(2);
    for (const score of scores) {
      const entry = artifact.content.companies.find((c) => c.companyId === score.subject_company_id)!;
      expect(entry.scoreFindingId).toBe(score.id);
      // The total is the weighted sum of its components, and every claim it rests on is a basis link.
      const sum = score.score.components.reduce((a, c) => a + c.weight * c.value, 0);
      expect(score.score.total).toBeCloseTo(sum, 2);
      expect(score.basis).toEqual([...entry.claimIds].sort());
    }
    const northwind = scores.find((s) => s.subject_company_id === id('Northwind Climate'))!;
    const fjordlight = scores.find((s) => s.subject_company_id === id('Fjordlight Energy Analytics'))!;
    expect(northwind.score.total).toBeGreaterThan(fjordlight.score.total);

    const { rows: refs } = await h.admin.query<{ claims: number; findings: number }>(
      `select count(claim_id)::int as claims, count(finding_id)::int as findings from public.artifact_references
       where artifact_id = $1`,
      [report.artifactId],
    );
    // Included companies' claims, Pinecrest's outside-criteria claim and Ghost Grid's rejected one.
    expect(refs[0]).toEqual({ claims: 4 + 1 + 1, findings: 2 });

    // Compiling again makes version 2 and supersedes version 1; the old one is never edited in place.
    const again = await withWorkspace(h.db, tenant.workspaceId, (tx) =>
      compileReport(tx, { run: ctx.run, criteria, now: ctx.now }),
    );
    const { rows: versions } = await h.admin.query<{
      id: string;
      version: number;
      status: string;
      previous: string | null;
    }>(
      `select id, version, status, previous_version_id as previous from public.artifacts where run_id = $1 order by version`,
      [ctx.run.id],
    );
    expect(versions).toEqual([
      { id: report.artifactId, version: 1, status: 'superseded', previous: null },
      { id: again.artifactId, version: 2, status: 'final', previous: report.artifactId },
    ]);
  });
});

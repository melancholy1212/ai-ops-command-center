// Discovery persistence against the local database: entity resolution, grounding against saved snapshots,
// idempotent claims, rejection reasons, pre-score ranking and the expansion it drives.
import { randomUUID } from 'node:crypto';
import type { InterpretedCriteria, ProposedClaim, SourceId } from '@aoc/contracts';
import { withWorkspace } from '@aoc/db';
import { createTestHarness, type TestHarness, type TestTenant } from '@aoc/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRun } from './commands/runs';
import { discoveryExpansion, persistDiscovery, type DiscoveryContext } from './workflow/discovery';

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

async function source(text: string, tier = 'B', publishedAt = '2026-03-12T08:00:00Z'): Promise<SourceId> {
  const { rows } = await h.admin.query<{ id: SourceId }>(
    `insert into public.sources (workspace_id, requested_url, final_url, final_url_hash, host, registrable_domain, source_type,
       tier, origin, retrieved_at, http, published_at_method, raw_sha256, content_sha256, text, text_length, truncated,
       extraction_method, extractor_version, fetched_by_tool_call_id, published_at)
     values ($1, $2, $2, $3, 'news.example', 'news.example', 'news_article', $5, '{"kind":"search_result"}', now(),
       '{"status":200}', 'html_meta', $3, $3, $4, char_length($4), false, 'readability_html', 'extract@1', gen_random_uuid(), $6)
     returning id`,
    [
      tenant.workspaceId,
      `https://news.example/${randomUUID()}`,
      randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
      text,
      tier,
      publishedAt,
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
  return { subject, assertion, rawValue: 'as stated', evidence: [{ sourceId, quote }] } as ProposedClaim;
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

/**
 * What happens to discovery's proposals (docs/workflow.md#expansion-rules-code-not-models): code resolves
 * each proposed company, grounds every quote against the saved snapshot, writes claims and evidence
 * idempotently, ranks the candidates with a deterministic pre-score, and expands the graph for the top ones.
 * No model decides any of this.
 */
import {
  ClaimAssertion,
  type AgentType,
  type CompanyId,
  type InterpretedCriteria,
  type ProposedClaim,
  type TaskId,
  type VerificationReason,
} from '@aoc/contracts';
import { toJson, type WorkspaceTransaction } from '@aoc/db';
import type { ExpansionPlan } from '../engine/types';
import { sha256Hex } from '../canonical-json';
import { groundQuote, sentenceAround } from '../verification/grounding';
import { claimFingerprint, normalizeCompanyName, registrableDomainOf } from '../verification/identity';
import { renderStatement } from '../verification/statement';
import { valueInText } from '../verification/values';

export interface DiscoveryContext {
  run: { id: string; workspace_id: string };
  taskId: string;
  executionId: string;
  agent: AgentType;
  criteria: InterpretedCriteria;
  now: Date;
}

export interface DiscoveredCompany {
  id: CompanyId;
  name: string;
  preScore: number;
  groundedClaims: number;
}

export interface DiscoveryResult {
  /** Ranked by pre-score, best first. */
  companies: DiscoveredCompany[];
  claimIds: string[];
  sourceIds: string[];
  grounded: number;
  rejected: number;
}

interface SourceRow {
  id: string;
  text: string;
  published_at: Date | null;
  retrieved_at: Date;
  tier: string;
}

function subjectKey(claim: ProposedClaim): string | null {
  if (claim.subject.kind !== 'new_company') return null;
  const domain =
    registrableDomainOf(claim.subject.domainHint) ??
    (claim.assertion.attribute === 'company.website' ? registrableDomainOf(claim.assertion.value.url) : null);
  return domain ? `domain:${domain}` : `name:${normalizeCompanyName(claim.subject.name)}`;
}

async function resolveCompany(
  tx: WorkspaceTransaction,
  ctx: DiscoveryContext,
  name: string,
  domain: string | null,
  /** Companies this discovery has already resolved, before their claims are written. */
  namedInCall: ReadonlySet<string>,
): Promise<{ id: string; name: string }> {
  const normalized = normalizeCompanyName(name);
  if (domain) {
    const byDomain = await tx
      .selectFrom('companies')
      .select(['id', 'name'])
      .where('primary_domain', '=', domain)
      .executeTakeFirst();
    if (byDomain) return byDomain;
  }
  // By name. With a domain, only a company not yet tied to another domain can match. Without one, the mention
  // joins the namesake this run already names (agents give a domain on one claim and omit it on the next, which
  // must not split one company in two), else a namesake without a domain. A bare name never joins a company with
  // a domain from an earlier run: two companies can share a name.
  const namesakes = await tx
    .selectFrom('companies')
    .select(['id', 'name', 'primary_domain'])
    .where('normalized_name', '=', normalized)
    .where((eb) =>
      domain ? eb.or([eb('primary_domain', 'is', null), eb('primary_domain', '=', domain)]) : eb.val(true),
    )
    .orderBy('created_at')
    .execute();
  let byName = domain ? namesakes[0] : undefined;
  if (!domain && namesakes.length > 0) {
    const inRun = await tx
      .selectFrom('claims')
      .select('subject_company_id')
      .distinct()
      .where('run_id', '=', ctx.run.id)
      .where(
        'subject_company_id',
        'in',
        namesakes.map((c) => c.id),
      )
      .execute();
    const named = new Set([
      ...inRun.map((c) => c.subject_company_id),
      ...namesakes.filter((c) => namedInCall.has(c.id)).map((c) => c.id),
    ]);
    byName =
      named.size === 1 ? namesakes.find((c) => named.has(c.id)) : namesakes.find((c) => c.primary_domain === null);
  }
  if (byName) {
    if (domain && byName.primary_domain === null) {
      await tx
        .updateTable('companies')
        .set({ primary_domain: domain, updated_at: ctx.now })
        .where('id', '=', byName.id)
        .execute();
    }
    return { id: byName.id, name: byName.name };
  }
  const inserted = await tx
    .insertInto('companies')
    .values({
      workspace_id: ctx.run.workspace_id,
      name: name.trim().slice(0, 200),
      normalized_name: normalized,
      primary_domain: domain,
      first_seen_run_id: ctx.run.id,
    })
    .returning(['id', 'name'])
    .executeTakeFirstOrThrow();
  return inserted;
}

/** Deterministic pre-score from grounded claims: criteria fit, funding recency, evidence tier, completeness. */
function preScore(
  claims: { assertion: ClaimAssertion; grounded: boolean; tierB: boolean }[],
  criteria: InterpretedCriteria,
  now: Date,
): number {
  let score = 0;
  const grounded = claims.filter((c) => c.grounded);
  const attributes = new Set(grounded.map((c) => c.assertion.attribute));
  for (const { assertion } of grounded) {
    if (assertion.attribute === 'company.funding_round') {
      const { announcedOn, stage } = assertion.value;
      const inWindow = announcedOn >= criteria.fundingWindow.from && announcedOn <= criteria.fundingWindow.to;
      const stageOk = criteria.fundingStages.length === 0 || criteria.fundingStages.includes(stage);
      if (inWindow && stageOk) score += 3;
      if (now.getTime() - Date.parse(announcedOn) < 183 * 24 * 60 * 60 * 1000) score += 1;
    }
    if (assertion.attribute === 'company.hq_country')
      score += criteria.countries.includes(assertion.value.country) ? 2 : -5;
  }
  if (grounded.some((c) => c.tierB)) score += 0.5;
  return score + attributes.size * 0.25;
}

export async function persistDiscovery(
  tx: WorkspaceTransaction,
  ctx: DiscoveryContext,
  proposals: readonly ProposedClaim[],
): Promise<DiscoveryResult> {
  const sourceIds = [...new Set(proposals.flatMap((p) => p.evidence.map((e) => e.sourceId)))];
  const sources = new Map<string, SourceRow>(
    sourceIds.length === 0
      ? []
      : (
          await tx
            .selectFrom('sources')
            .select(['id', 'text', 'published_at', 'retrieved_at', 'tier'])
            .where('id', 'in', sourceIds)
            .execute()
        ).map((s) => [s.id, s]),
  );

  // Group proposals by company (registrable domain, else normalised name).
  const groups = new Map<string, { name: string; domain: string | null; claims: ProposedClaim[] }>();
  for (const proposal of proposals) {
    const key = subjectKey(proposal);
    if (!key || proposal.subject.kind !== 'new_company') continue;
    const group = groups.get(key) ?? {
      name: proposal.subject.name,
      domain: key.startsWith('domain:') ? key.slice('domain:'.length) : null,
      claims: [],
    };
    group.claims.push(proposal);
    groups.set(key, group);
  }

  const companies: DiscoveredCompany[] = [];
  const claimIds: string[] = [];
  const groundedById = new Map<string, boolean>();
  // Resolve every group first: two groups (a domain and a bare name) can turn out to be one company.
  const resolved = new Map<string, { company: { id: string; name: string }; claims: ProposedClaim[] }>();
  for (const group of groups.values()) {
    const company = await resolveCompany(tx, ctx, group.name, group.domain, new Set(resolved.keys()));
    const entry = resolved.get(company.id) ?? { company, claims: [] };
    entry.claims.push(...group.claims);
    resolved.set(company.id, entry);
  }
  for (const { company, claims: proposed } of resolved.values()) {
    const scored: { assertion: ClaimAssertion; grounded: boolean; tierB: boolean }[] = [];
    for (const proposal of proposed) {
      const assertion = ClaimAssertion.parse(proposal.assertion);
      const evidence = proposal.evidence
        .map((e) => ({ ...e, source: sources.get(e.sourceId) }))
        .filter((e): e is typeof e & { source: SourceRow } => e.source !== undefined);
      if (evidence.length === 0) continue;
      const checked = evidence.map((e) => {
        const g = groundQuote(e.source.text, e.quote);
        const first = g.spans[0];
        const valueInQuote = first
          ? valueInText(assertion, `${e.quote} ${sentenceAround(e.source.text, first)}`)
          : null;
        return { ...e, grounding: g, valueInQuote };
      });
      const anyGrounded = checked.some((c) => c.grounding.result !== 'not_found');
      const reasons: VerificationReason[] = checked
        .filter((c) => c.grounding.problem !== null)
        .map((c) => ({
          code: c.grounding.problem ?? 'QUOTE_NOT_FOUND',
          detail:
            c.grounding.problem === 'QUOTE_TOO_SHORT'
              ? 'The quote is too short to be evidence.'
              : 'The quote was not found in the saved source.',
          evidenceIds: [],
        }));
      const published = checked
        .map((c) => c.source.published_at?.getTime())
        .filter((t): t is number => t !== undefined);
      const fingerprint = claimFingerprint(company.id, assertion);
      const status = anyGrounded ? 'grounded' : 'rejected';
      const inserted = await tx
        .insertInto('claims')
        .values({
          workspace_id: ctx.run.workspace_id,
          run_id: ctx.run.id,
          subject_company_id: company.id,
          attribute: assertion.attribute,
          value: toJson(assertion.value),
          raw_value: proposal.rawValue,
          statement: renderStatement(company.name, assertion),
          fingerprint,
          status,
          verification: toJson({
            reasons,
            policy: null,
            evaluatedAt: ctx.now.toISOString(),
            evaluatedByTaskId: ctx.taskId as TaskId,
          }),
          proposed_by_agent: ctx.agent,
          proposed_by_execution_id: ctx.executionId,
          newest_published_at: published.length > 0 ? new Date(Math.max(...published)) : null,
          oldest_published_at: published.length > 0 ? new Date(Math.min(...published)) : null,
          newest_retrieved_at: new Date(Math.max(...checked.map((c) => c.source.retrieved_at.getTime()))),
        })
        .onConflict((oc) => oc.columns(['run_id', 'fingerprint']).doNothing())
        .returning('id')
        .executeTakeFirst();
      // The same claim proposed twice in a run is one claim with more evidence.
      const existing = inserted
        ? null
        : await tx
            .selectFrom('claims')
            .select(['id', 'status'])
            .where('run_id', '=', ctx.run.id)
            .where('fingerprint', '=', fingerprint)
            .executeTakeFirstOrThrow();
      const claimId = inserted?.id ?? existing?.id ?? '';
      if (existing?.status === 'rejected' && anyGrounded) {
        await tx
          .updateTable('claims')
          .set({ status: 'grounded', updated_at: ctx.now })
          .where('id', '=', claimId)
          .execute();
      }
      for (const c of checked) {
        await tx
          .insertInto('evidence')
          .values({
            workspace_id: ctx.run.workspace_id,
            claim_id: claimId,
            source_id: c.sourceId,
            quote: c.quote,
            quote_sha256: sha256Hex(c.quote),
            grounding: c.grounding.result,
            spans: toJson(c.grounding.spans),
            value_in_quote: c.valueInQuote,
            source_published_at: c.source.published_at,
            source_retrieved_at: c.source.retrieved_at,
            extracted_by_execution_id: ctx.executionId,
          })
          .onConflict((oc) => oc.columns(['claim_id', 'source_id', 'quote_sha256']).doNothing())
          .execute();
      }
      if (!claimIds.includes(claimId)) claimIds.push(claimId);
      // Counted per claim, not per proposal: a claim proposed twice is one claim.
      groundedById.set(claimId, (groundedById.get(claimId) ?? false) || anyGrounded);
      scored.push({
        assertion,
        grounded: anyGrounded,
        tierB: checked.some((c) => c.source.tier === 'A' || c.source.tier === 'B'),
      });
    }
    companies.push({
      id: company.id as CompanyId,
      name: company.name,
      preScore: preScore(scored, ctx.criteria, ctx.now),
      groundedClaims: scored.filter((s) => s.grounded).length,
    });
  }
  companies.sort((a, b) => b.preScore - a.preScore || a.name.localeCompare(b.name));
  const grounded = [...groundedById.values()].filter(Boolean).length;
  return { companies, claimIds, sourceIds: [...sources.keys()], grounded, rejected: groundedById.size - grounded };
}

/**
 * Workflow version 1 (Phase 4): the top candidates with grounded evidence get a verification task; the
 * report waits for all of them (soft join). Profiles, people, gap-fill, ranking and outreach join in
 * version 2 (Phase 5).
 */
export function discoveryExpansion(companies: readonly DiscoveredCompany[], maxCompanies: number): ExpansionPlan {
  const chosen = companies.filter((c) => c.groundedClaims > 0).slice(0, maxCompanies);
  return {
    tasks: [
      ...chosen.map((c) => ({
        ref: `verify:${c.id}`,
        type: 'verify_entity' as const,
        input: { type: 'verify_entity' as const, companyId: c.id, round: 1 as const },
        idempotencyKey: `verify_entity:${c.id}:r1`,
        priority: 60,
      })),
      {
        ref: 'report',
        type: 'compile_report',
        input: { type: 'compile_report' },
        idempotencyKey: 'compile_report',
        priority: 40,
        dependsOn: chosen.map((c) => ({ ref: `verify:${c.id}`, mode: 'soft' as const })),
      },
    ],
  };
}

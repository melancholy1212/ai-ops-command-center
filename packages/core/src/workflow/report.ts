/**
 * compile_report (docs/workflow.md#what-each-step-guarantees): deterministic. It includes the verified
 * companies that fit the brief, excludes the rest with a reason and the claims behind it, scores the included
 * ones in code (a fact_derived score finding citing its claims), and saves an immutable report artifact that
 * references every claim, finding and gap it rests on. No model writes any of it.
 */
import {
  ClaimAssertion,
  ReportContent,
  REQUIRED_COMPANY_ATTRIBUTES,
  type ArtifactId,
  type ClaimId,
  type CompanyId,
  type FindingId,
  type GapId,
  type InterpretedCriteria,
} from '@aoc/contracts';
import { toJson, type WorkspaceTransaction } from '@aoc/db';
import { sql } from 'kysely';
import type { z } from 'zod';
import { canonicalJson, sha256Hex } from '../canonical-json';

export const SCORING = { module: 'prospect-score', version: 'score@1' } as const;
export const REPORT = { module: 'prospect-report', version: 'report@1' } as const;

/** Scoring v1 weights (docs/workflow.md: funding recency, stage fit, geography fit, evidence, completeness). */
export const SCORE_WEIGHTS = {
  funding_recency: 0.35,
  stage_fit: 0.2,
  geography_fit: 0.15,
  evidence_strength: 0.2,
  completeness: 0.1,
} as const;

interface ClaimRow {
  id: string;
  subject_company_id: string;
  attribute: string;
  value: unknown;
  status: string;
  confidence_score: string | null;
  verification: unknown;
}

const STANDING = new Set(['verified', 'probable']);
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReportContext {
  run: { id: string; workspace_id: string };
  criteria: InterpretedCriteria;
  now: Date;
}

export interface CompiledReport {
  artifactId: ArtifactId;
  findingIds: FindingId[];
  included: number;
  excluded: number;
}

function reasonsOf(claim: ClaimRow): { code: string; detail: string }[] {
  return (claim.verification as { reasons?: { code: string; detail: string }[] } | null)?.reasons ?? [];
}

export async function compileReport(tx: WorkspaceTransaction, ctx: ReportContext): Promise<CompiledReport> {
  const claims = (await tx
    .selectFrom('claims')
    .select(['id', 'subject_company_id', 'attribute', 'value', 'status', 'confidence_score', 'verification'])
    .where('run_id', '=', ctx.run.id)
    .orderBy('created_at')
    .orderBy('id')
    .execute()) as ClaimRow[];
  const companyIds = [...new Set(claims.map((c) => c.subject_company_id))];
  const companies =
    companyIds.length === 0
      ? []
      : await tx.selectFrom('companies').select(['id', 'name']).where('id', 'in', companyIds).execute();
  const names = new Map(companies.map((c) => [c.id, c.name]));
  const verifyTasks = await tx
    .selectFrom('tasks')
    .select(['subject_company_id', 'status'])
    .where('run_id', '=', ctx.run.id)
    .where('type', '=', 'verify_entity')
    .execute();
  const verification = new Map(verifyTasks.map((t) => [t.subject_company_id ?? '', t.status]));
  // Workflow version 2 profiles a company before verifying it; a failed profile skips the verification.
  const profileTasks = await tx
    .selectFrom('tasks')
    .select(['subject_company_id', 'status', sql<string | null>`last_failure->>'code'`.as('failure_code')])
    .where('run_id', '=', ctx.run.id)
    .where('type', '=', 'profile_company')
    .execute();
  const profiles = new Map(profileTasks.map((t) => [t.subject_company_id ?? '', t]));
  const gaps = await tx
    .selectFrom('research_gaps')
    .select(['id', 'company_id'])
    .where('run_id', '=', ctx.run.id)
    .execute();

  interface Component {
    criterion: string;
    weight: number;
    value: number;
    claimIds: string[];
  }
  const included: { companyId: string; claims: ClaimRow[]; total: number; components: Component[] }[] = [];
  // `order` lists what verification judged before what it never saw, so the listed 50 are the informative ones.
  const excluded: { companyId: string; reason: string; claimIds: string[]; order: number }[] = [];
  const windowFrom = Date.parse(ctx.criteria.fundingWindow.from);
  const windowTo = Date.parse(ctx.criteria.fundingWindow.to);

  for (const companyId of companyIds) {
    const own = claims.filter((c) => c.subject_company_id === companyId);
    const standing = own.filter((c) => STANDING.has(c.status));
    const outside = own.find((c) => reasonsOf(c).some((r) => r.code === 'OUTSIDE_CRITERIA'));
    const rounds = standing.filter((c) => c.attribute === 'company.funding_round');
    const hq = standing.find((c) => c.attribute === 'company.hq_country');
    const verifyStatus = verification.get(companyId);
    const exclude = (reason: string, cited: ClaimRow[], order = 0) =>
      excluded.push({ companyId, reason, claimIds: cited.map((c) => c.id), order });

    // Discovery only sends companies with grounded evidence to verification (discoveryExpansion).
    if (verifyStatus === undefined && own.every((c) => c.status === 'rejected'))
      exclude('No claim survived grounding: every quote was missing from its source or too short.', own, 2);
    else if (verifyStatus === undefined)
      exclude(`Not among the top ${String(ctx.criteria.maxCompanies)} candidates after discovery.`, [], 1);
    else if (verifyStatus !== 'succeeded') {
      const profile = profiles.get(companyId);
      exclude(
        profile && profile.status !== 'succeeded'
          ? `The company profile ${profile.status === 'failed' ? `failed (${profile.failure_code ?? 'unknown error'})` : `was ${profile.status}`}, so it was not verified.`
          : 'Verification did not complete.',
        [],
      );
    } else if (outside)
      exclude(reasonsOf(outside).find((r) => r.code === 'OUTSIDE_CRITERIA')?.detail ?? 'Outside the brief.', [outside]);
    else if (rounds.length === 0)
      exclude(
        'No verified or probable funding round inside the brief.',
        own.filter((c) => c.attribute === 'company.funding_round'),
      );
    else if (!hq)
      exclude(
        'Headquarters country not established.',
        own.filter((c) => c.attribute === 'company.hq_country'),
      );
    else {
      // Scoring v1, all code.
      const newestRound = rounds
        .map((c) => ({
          claim: c,
          date: Date.parse(
            (ClaimAssertion.parse({ attribute: c.attribute, value: c.value }).value as { announcedOn: string })
              .announcedOn,
          ),
        }))
        .sort((a, b) => b.date - a.date)[0];
      const span = Math.max(DAY_MS, windowTo - windowFrom);
      const recency = newestRound ? Math.min(1, Math.max(0, 1 - (ctx.now.getTime() - newestRound.date) / span)) : 0;
      // Standing rounds are inside the brief by construction (others were rejected OUTSIDE_CRITERIA).
      const stageFit = 1;
      const confidences = standing.map((c) => Number(c.confidence_score ?? 0));
      const evidence = confidences.reduce((a, b) => a + b, 0) / Math.max(1, confidences.length);
      const covered = REQUIRED_COMPANY_ATTRIBUTES.filter((a) => standing.some((c) => c.attribute === a));
      const components = [
        {
          criterion: 'funding_recency',
          weight: SCORE_WEIGHTS.funding_recency,
          value: recency,
          claimIds: newestRound ? [newestRound.claim.id] : [],
        },
        { criterion: 'stage_fit', weight: SCORE_WEIGHTS.stage_fit, value: stageFit, claimIds: rounds.map((c) => c.id) },
        { criterion: 'geography_fit', weight: SCORE_WEIGHTS.geography_fit, value: 1, claimIds: [hq.id] },
        {
          criterion: 'evidence_strength',
          weight: SCORE_WEIGHTS.evidence_strength,
          value: evidence,
          claimIds: standing.map((c) => c.id),
        },
        {
          criterion: 'completeness',
          weight: SCORE_WEIGHTS.completeness,
          value: covered.length / REQUIRED_COMPANY_ATTRIBUTES.length,
          claimIds: standing
            .filter((c) => (REQUIRED_COMPANY_ATTRIBUTES as readonly string[]).includes(c.attribute))
            .map((c) => c.id),
        },
      ].map((c) => ({ ...c, value: Math.round(c.value * 1000) / 1000, claimIds: c.claimIds.slice(0, 20) }));
      const total = Math.round(components.reduce((sum, c) => sum + c.weight * c.value, 0) * 1000) / 1000;
      included.push({ companyId, claims: standing, total, components });
    }
  }

  included.sort(
    (a, b) => b.total - a.total || (names.get(a.companyId) ?? '').localeCompare(names.get(b.companyId) ?? ''),
  );
  const findingIds: FindingId[] = [];
  const reportCompanies: z.infer<typeof ReportContent>['companies'] = [];
  for (const [index, entry] of included.entries()) {
    const name = names.get(entry.companyId) ?? 'The company';
    const breakdown = entry.components.map((c) => `${c.criterion.replace('_', ' ')} ${c.value.toFixed(2)}`).join(', ');
    const finding = await tx
      .insertInto('findings')
      .values({
        workspace_id: ctx.run.workspace_id,
        run_id: ctx.run.id,
        subject_kind: 'company',
        subject_company_id: entry.companyId,
        kind: 'score',
        label: 'fact_derived',
        statement: `${name} scores ${entry.total.toFixed(2)} of 1 (${breakdown}).`.slice(0, 1200),
        score: toJson({ total: entry.total, components: entry.components, scoringVersion: SCORING.version }),
        author_kind: 'code',
        author_module: SCORING.module,
        author_version: SCORING.version,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const basis = [...new Set(entry.components.flatMap((c) => c.claimIds))];
    for (const claimId of basis) {
      await tx
        .insertInto('finding_claims')
        .values({ finding_id: finding.id, claim_id: claimId, workspace_id: ctx.run.workspace_id, role: 'basis' })
        .execute();
    }
    findingIds.push(finding.id as FindingId);
    reportCompanies.push({
      companyId: entry.companyId as CompanyId,
      rank: index + 1,
      scoreFindingId: finding.id as FindingId,
      claimIds: entry.claims.map((c) => c.id as ClaimId).slice(0, 100),
      findingIds: [finding.id as FindingId],
      gapIds: gaps
        .filter((g) => g.company_id === entry.companyId)
        .map((g) => g.id as GapId)
        .slice(0, 30),
      outreachArtifactIds: [],
    });
  }

  const content = ReportContent.parse({
    kind: 'prospect_report',
    generatedAt: ctx.now.toISOString(),
    companies: reportCompanies,
    excluded: excluded
      .sort((a, b) => a.order - b.order)
      .slice(0, 50)
      .map((e) => ({ companyId: e.companyId, reason: e.reason.slice(0, 300), claimIds: e.claimIds.slice(0, 20) })),
    excludedOmitted: Math.max(0, excluded.length - 50),
  });
  const previous = await tx
    .selectFrom('artifacts')
    .select(['id', 'version'])
    .where('run_id', '=', ctx.run.id)
    .where('kind', '=', 'prospect_report')
    .orderBy('version', 'desc')
    .executeTakeFirst();
  if (previous) await tx.updateTable('artifacts').set({ status: 'superseded' }).where('id', '=', previous.id).execute();
  const artifact = await tx
    .insertInto('artifacts')
    .values({
      workspace_id: ctx.run.workspace_id,
      run_id: ctx.run.id,
      kind: 'prospect_report',
      version: (previous?.version ?? 0) + 1,
      previous_version_id: previous?.id ?? null,
      status: 'final',
      content: toJson(content),
      content_hash: sha256Hex(canonicalJson(content)),
      author_kind: 'code',
      author_module: REPORT.module,
      author_version: REPORT.version,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const referencedClaims = new Set([
    ...content.companies.flatMap((c) => c.claimIds),
    ...content.excluded.flatMap((e) => e.claimIds),
  ]);
  for (const claimId of referencedClaims) {
    await tx
      .insertInto('artifact_references')
      .values({ artifact_id: artifact.id, workspace_id: ctx.run.workspace_id, claim_id: claimId })
      .execute();
  }
  for (const findingId of findingIds) {
    await tx
      .insertInto('artifact_references')
      .values({ artifact_id: artifact.id, workspace_id: ctx.run.workspace_id, finding_id: findingId })
      .execute();
  }
  return {
    artifactId: artifact.id as ArtifactId,
    findingIds,
    included: content.companies.length,
    excluded: content.excluded.length,
  };
}

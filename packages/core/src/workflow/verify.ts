/**
 * verify_entity (docs/provenance.md#verification): everything except the judge is code. The worker asks the
 * verifier model one question per grounded quote ("does this quote support this claim?"); this module applies
 * policy v1, the brief's criteria, consistency, confidence and coverage, and records every reason.
 */
import {
  ClaimAssertion,
  type InterpretedCriteria,
  REQUIRED_COMPANY_ATTRIBUTES,
  type ClaimStatus,
  type JudgeVerdict,
  type SourceFlag,
  type SourceTier,
  type SourceType,
  type TaskId,
  type VerificationReason,
} from '@aoc/contracts';
import { toJson, type WorkspaceTransaction } from '@aoc/db';
import { findConflicts } from '../verification/consistency';
import { outsideCriteria } from '../verification/criteria';
import { contextAround, type Span } from '../verification/grounding';
import {
  computeConfidence,
  evaluatePolicy,
  POLICY,
  type EvidenceFeatures,
  type PolicyOutcome,
} from '../verification/policy';

export interface EvidenceForVerification {
  id: string;
  quote: string;
  grounding: 'exact' | 'normalized' | 'elided_segments' | 'not_found';
  spans: Span[];
  valueInQuote: boolean | null;
  judge: JudgeVerdict | null;
  source: {
    id: string;
    registrableDomain: string;
    tier: SourceTier;
    sourceType: SourceType;
    flags: SourceFlag[];
    publishedAt: Date | null;
    retrievedAt: Date;
    text: string;
  };
}

export interface ClaimForVerification {
  id: string;
  statement: string;
  status: ClaimStatus;
  assertion: ClaimAssertion;
  reasons: VerificationReason[];
  evidence: EvidenceForVerification[];
}

export interface CompanyForVerification {
  id: string;
  name: string;
  primaryDomain: string | null;
  claims: ClaimForVerification[];
}

/** One question for the judge: a grounded quote of a claim still to be verified, with its surroundings. */
export interface JudgeItem {
  evidenceId: string;
  statement: string;
  quote: string;
  context: string;
}

export async function loadCompanyForVerification(
  tx: WorkspaceTransaction,
  runId: string,
  companyId: string,
): Promise<CompanyForVerification> {
  const company = await tx
    .selectFrom('companies')
    .select(['id', 'name', 'primary_domain'])
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  const claims = await tx
    .selectFrom('claims')
    .select(['id', 'statement', 'status', 'attribute', 'value', 'verification'])
    .where('run_id', '=', runId)
    .where('subject_company_id', '=', companyId)
    .orderBy('created_at')
    .execute();
  const evidence =
    claims.length === 0
      ? []
      : await tx
          .selectFrom('evidence as e')
          .innerJoin('sources as s', 's.id', 'e.source_id')
          .select([
            'e.id',
            'e.claim_id',
            'e.quote',
            'e.grounding',
            'e.spans',
            'e.value_in_quote',
            'e.judge_verdict',
            's.id as source_id',
            's.registrable_domain',
            's.tier',
            's.source_type',
            's.flags',
            's.published_at',
            's.retrieved_at',
            's.text',
          ])
          .where(
            'e.claim_id',
            'in',
            claims.map((c) => c.id),
          )
          .orderBy('e.created_at')
          .execute();
  return {
    id: company.id,
    name: company.name,
    primaryDomain: company.primary_domain,
    claims: claims.map((c) => ({
      id: c.id,
      statement: c.statement,
      status: c.status as ClaimStatus,
      assertion: ClaimAssertion.parse({ attribute: c.attribute, value: c.value }),
      reasons: (c.verification as { reasons?: VerificationReason[] }).reasons ?? [],
      evidence: evidence
        .filter((e) => e.claim_id === c.id)
        .map((e) => ({
          id: e.id,
          quote: e.quote,
          grounding: e.grounding as EvidenceForVerification['grounding'],
          spans: e.spans as unknown as Span[],
          valueInQuote: e.value_in_quote,
          judge: e.judge_verdict as JudgeVerdict | null,
          source: {
            id: e.source_id,
            registrableDomain: e.registrable_domain,
            tier: e.tier as SourceTier,
            sourceType: e.source_type as SourceType,
            flags: e.flags as SourceFlag[],
            publishedAt: e.published_at,
            retrievedAt: e.retrieved_at,
            text: e.text,
          },
        })),
    })),
  };
}

/** Grounded quotes of grounded claims that have no verdict yet. Ungrounded quotes never reach the judge. */
export function judgeItems(company: CompanyForVerification): JudgeItem[] {
  return company.claims
    .filter((c) => c.status === 'grounded')
    .flatMap((c) =>
      c.evidence
        .filter((e) => e.grounding !== 'not_found' && e.judge === null)
        .map((e) => ({
          evidenceId: e.id,
          statement: c.statement,
          quote: e.quote,
          context: contextAround(e.source.text, e.spans[0] ?? { start: 0, end: 0 }, 300),
        })),
    );
}

export interface JudgeVerdictRecord {
  evidenceId: string;
  verdict: JudgeVerdict;
  reason: string;
  llmCallId: string | null;
}

export interface VerificationSummary {
  verified: number;
  probable: number;
  contested: number;
  rejected: number;
  outsideCriteria: number;
  gaps: number;
}

export interface VerifyContext {
  run: { id: string; workspace_id: string };
  taskId: string;
  criteria: InterpretedCriteria;
  now: Date;
}

export async function applyVerification(
  tx: WorkspaceTransaction,
  ctx: VerifyContext,
  company: CompanyForVerification,
  verdicts: readonly JudgeVerdictRecord[],
): Promise<VerificationSummary> {
  const byEvidence = new Map(verdicts.map((v) => [v.evidenceId, v]));
  for (const v of verdicts) {
    await tx
      .updateTable('evidence')
      .set({ judge_verdict: v.verdict, judge_reason: v.reason.slice(0, 500), judge_llm_call_id: v.llmCallId })
      .where('id', '=', v.evidenceId)
      .where('judge_verdict', 'is', null)
      .execute();
  }

  interface Decided {
    claim: ClaimForVerification;
    status: 'verified' | 'probable' | 'rejected' | 'contested';
    reasons: VerificationReason[];
    outcome: PolicyOutcome | null;
    conflicting: string[];
  }
  const decided: Decided[] = company.claims.map((claim) => {
    // Claims already rejected at grounding stay rejected with their reasons.
    if (claim.status === 'rejected')
      return { claim, status: 'rejected', reasons: claim.reasons, outcome: null, conflicting: [] };
    const features: EvidenceFeatures[] = claim.evidence.map((e) => ({
      evidenceId: e.id,
      sourceId: e.source.id,
      registrableDomain: e.source.registrableDomain,
      tier: e.source.tier,
      sourceType: e.source.sourceType,
      flags: e.source.flags,
      publishedAt: e.source.publishedAt,
      retrievedAt: e.source.retrievedAt,
      grounding: e.grounding,
      valueInQuote: e.valueInQuote,
      judge: byEvidence.get(e.id)?.verdict ?? e.judge,
      context: contextAround(e.source.text, e.spans[0] ?? { start: 0, end: 0 }, 300),
      selfPublished: company.primaryDomain !== null && e.source.registrableDomain === company.primaryDomain,
    }));
    const outcome = evaluatePolicy(claim.assertion, features);
    const reasons = [...outcome.reasons];
    let status: Decided['status'] = outcome.status;
    const outside = status === 'rejected' ? null : outsideCriteria(claim.assertion, ctx.criteria);
    if (outside) {
      status = 'rejected';
      reasons.push({ code: 'OUTSIDE_CRITERIA', detail: outside.slice(0, 300), evidenceIds: [] });
    }
    return { claim, status, reasons, outcome, conflicting: [] };
  });

  // Consistency: conflicting values of the same attribute contest each other.
  const standing = decided.filter((d) => d.status === 'verified' || d.status === 'probable');
  const conflicts = findConflicts(standing.map((d) => ({ id: d.claim.id, assertion: d.claim.assertion })));
  for (const d of standing) {
    const others = conflicts.get(d.claim.id);
    if (!others) continue;
    d.status = 'contested';
    d.conflicting = others;
    d.reasons.push({ code: 'CONFLICTING_VALUE', detail: 'Another claim states a conflicting value.', evidenceIds: [] });
  }

  const summary: VerificationSummary = {
    verified: 0,
    probable: 0,
    contested: 0,
    rejected: 0,
    outsideCriteria: 0,
    gaps: 0,
  };
  for (const d of decided) {
    const scored = d.status !== 'rejected' && d.outcome ? computeConfidence(d.status, d.outcome, ctx.now) : null;
    const reasons = [...d.reasons, ...(scored?.reasons ?? [])].slice(0, 20);
    await tx
      .updateTable('claims')
      .set({
        status: d.status,
        confidence: scored?.level ?? null,
        confidence_score: scored ? String(scored.score) : null,
        verification: toJson({
          reasons,
          policy: d.outcome ? POLICY : null,
          evaluatedAt: ctx.now.toISOString(),
          evaluatedByTaskId: ctx.taskId as TaskId,
        }),
        conflict_state: d.status === 'contested' ? 'conflicting' : 'none',
        conflicting_claim_ids: d.conflicting,
        updated_at: ctx.now,
      })
      .where('id', '=', d.claim.id)
      .execute();
    summary[d.status] += 1;
    if (reasons.some((r) => r.code === 'OUTSIDE_CRITERIA')) summary.outsideCriteria += 1;
  }

  // The company's country, once a claim establishes it without contest.
  const country = decided.find(
    (d) => d.claim.assertion.attribute === 'company.hq_country' && (d.status === 'verified' || d.status === 'probable'),
  );
  if (country?.claim.assertion.attribute === 'company.hq_country') {
    await tx
      .updateTable('companies')
      .set({ country: country.claim.assertion.value.country, updated_at: ctx.now })
      .where('id', '=', company.id)
      .execute();
  }

  // Coverage: required attributes with no standing claim are recorded, not silently omitted. Workflow version 1
  // has no gap-fill round, so they are unavailable for this run.
  for (const attribute of REQUIRED_COMPANY_ATTRIBUTES) {
    const forAttribute = decided.filter((d) => d.claim.assertion.attribute === attribute);
    if (forAttribute.some((d) => d.status === 'verified' || d.status === 'probable')) continue;
    const reason =
      forAttribute.length === 0
        ? 'no_claim'
        : forAttribute.some((d) => d.status === 'contested')
          ? 'conflict_unresolved'
          : 'only_rejected_claims';
    const inserted = await tx
      .insertInto('research_gaps')
      .values({
        workspace_id: ctx.run.workspace_id,
        run_id: ctx.run.id,
        company_id: company.id,
        attribute,
        status: 'unavailable',
        reason,
        note: 'No gap-fill round in this workflow version.',
        resolved_at: ctx.now,
      })
      .onConflict((oc) => oc.columns(['run_id', 'company_id', 'attribute']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) summary.gaps += 1;
  }
  return summary;
}

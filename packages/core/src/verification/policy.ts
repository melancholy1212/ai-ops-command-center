/**
 * Verification policy v1 (docs/provenance.md#policy-v1) and confidence (#confidence-code-only). Everything
 * here is deterministic code over evidence features; the only model input is the judge's verdict per quote.
 */
import type {
  ClaimAssertion,
  ClaimAttribute,
  ConfidenceLevel,
  GroundingResult,
  JudgeVerdict,
  SourceFlag,
  SourceTier,
  SourceType,
  VerificationReason,
  VerificationReasonCode,
} from '@aoc/contracts';
import { independentGroups } from './independence';

export const POLICY = { id: 'verification', version: 1 } as const;

export interface EvidenceFeatures {
  evidenceId: string;
  sourceId: string;
  registrableDomain: string;
  tier: SourceTier;
  sourceType: SourceType;
  flags: readonly SourceFlag[];
  publishedAt: Date | null;
  retrievedAt: Date;
  grounding: GroundingResult;
  valueInQuote: boolean | null;
  judge: JudgeVerdict | null;
  /** Text around the quote, for syndication detection. */
  context: string;
  /** The source is the subject company's own site. */
  selfPublished: boolean;
}

export type PolicyStatus = 'verified' | 'probable' | 'rejected';

export interface PolicyOutcome {
  status: PolicyStatus;
  reasons: VerificationReason[];
  supporting: EvidenceFeatures[];
  independentSources: number;
  authoritative: boolean;
}

const reason = (code: VerificationReasonCode, detail: string, evidenceIds: string[] = []): VerificationReason => ({
  code,
  detail: detail.slice(0, 300),
  evidenceIds: evidenceIds.slice(0, 20) as VerificationReason['evidenceIds'],
});

/** Self-reported facts: the company's own site and its press releases are authoritative for these. */
const SELF_REPORTED: readonly ClaimAttribute[] = [
  'company.website',
  'company.hq_country',
  'company.hq_city',
  'company.founded_year',
  'company.description',
  'company.sector',
  'company.funding_round',
  'company.employee_count',
  'company.hiring_signal',
];

function authoritative(attribute: ClaimAttribute, e: EvidenceFeatures): boolean {
  if (e.sourceType === 'registry_record') return true;
  return SELF_REPORTED.includes(attribute) && (e.selfPublished || e.sourceType === 'press_release');
}

export function evaluatePolicy(assertion: ClaimAssertion, evidence: readonly EvidenceFeatures[]): PolicyOutcome {
  const reasons: VerificationReason[] = [];
  const attribute = assertion.attribute;

  const ungrounded = evidence.filter((e) => e.grounding === 'not_found');
  if (ungrounded.length > 0) {
    reasons.push(
      reason(
        'QUOTE_NOT_FOUND',
        `${String(ungrounded.length)} quote(s) not found in the saved source.`,
        ungrounded.map((e) => e.evidenceId),
      ),
    );
  }
  const grounded = evidence.filter((e) => e.grounding !== 'not_found');
  const valueMissing = grounded.filter((e) => e.valueInQuote === false);
  if (valueMissing.length > 0) {
    reasons.push(
      reason(
        'VALUE_NOT_IN_QUOTE',
        'The claimed value does not appear in the quote or its sentence.',
        valueMissing.map((e) => e.evidenceId),
      ),
    );
  }
  const contradicting = grounded.filter((e) => e.judge === 'contradicts');
  if (contradicting.length > 0)
    reasons.push(
      reason(
        'JUDGE_CONTRADICTS',
        'A quote contradicts the claim.',
        contradicting.map((e) => e.evidenceId),
      ),
    );
  const unsupported = grounded.filter((e) => e.judge === 'does_not_support');
  if (unsupported.length > 0)
    reasons.push(
      reason(
        'JUDGE_UNSUPPORTED',
        'A quote does not support the claim.',
        unsupported.map((e) => e.evidenceId),
      ),
    );

  const supporting = grounded.filter(
    (e) => e.valueInQuote !== false && (e.judge === 'supports' || e.judge === 'partially_supports'),
  );
  if (supporting.length === 0 || contradicting.length > 0) {
    return { status: 'rejected', reasons, supporting: [], independentSources: 0, authoritative: false };
  }

  const { groups, syndicated } = independentGroups(
    supporting.map((e) => ({ id: e.evidenceId, registrableDomain: e.registrableDomain, context: e.context })),
  );
  if (syndicated.length > 0) {
    reasons.push(
      reason('SYNDICATED_DUPLICATE', 'Near-identical text on different sites counts as one source.', syndicated.flat()),
    );
  }
  const byId = new Map(supporting.map((e) => [e.evidenceId, e]));
  const groupFeatures = groups.map((g) =>
    g.map((id) => byId.get(id)).filter((e): e is EvidenceFeatures => e !== undefined),
  );
  const independent = groups.length;
  const isAuthoritative = supporting.some((e) => authoritative(attribute, e));
  const selfGroups = groupFeatures.filter((g) => g.some((e) => e.selfPublished)).length;
  const tierBGroups = groupFeatures.filter((g) => g.some((e) => e.tier === 'A' || e.tier === 'B')).length;
  const onlyUserGenerated = supporting.every((e) => e.tier === 'D');

  let verified: boolean;
  switch (attribute) {
    case 'company.funding_round':
      verified = isAuthoritative || tierBGroups >= 2;
      break;
    case 'company.hq_country':
    case 'company.website':
      // Registry record, or the company's own site plus one independent source.
      verified = supporting.some((e) => e.sourceType === 'registry_record') || (selfGroups >= 1 && independent >= 2);
      break;
    case 'company.sector':
      verified = independent >= 2 || supporting.some((e) => e.selfPublished);
      break;
    default:
      verified = independent >= 2;
  }

  if (isAuthoritative)
    reasons.push(
      reason(
        'AUTHORITATIVE_SOURCE',
        'Supported by an authoritative source for this attribute.',
        supporting.filter((e) => authoritative(attribute, e)).map((e) => e.evidenceId),
      ),
    );
  if (independent >= 2)
    reasons.push(
      reason(
        'INDEPENDENT_SOURCES',
        `${String(independent)} independent sources agree.`,
        supporting.map((e) => e.evidenceId),
      ),
    );
  else
    reasons.push(
      reason(
        'SINGLE_SOURCE',
        'Only one independent source.',
        supporting.map((e) => e.evidenceId),
      ),
    );

  if (!verified && onlyUserGenerated) {
    return { status: 'rejected', reasons, supporting, independentSources: independent, authoritative: isAuthoritative };
  }
  return {
    status: verified ? 'verified' : 'probable',
    reasons,
    supporting,
    independentSources: independent,
    authoritative: isAuthoritative,
  };
}

const BASE_SCORE = { verified: 0.8, probable: 0.55, contested: 0.35 } as const;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface ConfidenceOutcome {
  score: number;
  level: ConfidenceLevel;
  reasons: VerificationReason[];
}

/** Confidence is arithmetic over the evidence, never a model's opinion. Every adjustment is a recorded reason. */
export function computeConfidence(
  status: 'verified' | 'probable' | 'contested',
  outcome: Pick<PolicyOutcome, 'supporting' | 'independentSources' | 'authoritative'>,
  now: Date,
): ConfidenceOutcome {
  const reasons: VerificationReason[] = [];
  let score: number = BASE_SCORE[status];
  const ids = outcome.supporting.map((e) => e.evidenceId);
  if (outcome.supporting.some((e) => e.tier === 'A' || e.sourceType === 'registry_record' || e.selfPublished))
    score += 0.1;
  score += Math.min(0.1, Math.max(0, outcome.independentSources - 1) * 0.05);
  const newest = outcome.supporting
    .map((e) => e.publishedAt?.getTime() ?? e.retrievedAt.getTime())
    .reduce((a, b) => Math.max(a, b), 0);
  if (newest > 0 && now.getTime() - newest > YEAR_MS) {
    score -= 0.1;
    reasons.push(reason('SOURCE_TOO_OLD', 'The newest source is older than 12 months.', ids));
  }
  if (outcome.supporting.some((e) => e.judge === 'partially_supports')) score -= 0.1;
  const injected = outcome.supporting.filter((e) => e.flags.includes('suspected_prompt_injection'));
  if (injected.length > 0) {
    score -= 0.2;
    reasons.push(
      reason(
        'SUSPECTED_INJECTION_SOURCE',
        'A supporting source contains instruction-like text.',
        injected.map((e) => e.evidenceId),
      ),
    );
  }
  const clamped = Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
  return { score: clamped, level: clamped >= 0.75 ? 'high' : clamped >= 0.5 ? 'medium' : 'low', reasons };
}

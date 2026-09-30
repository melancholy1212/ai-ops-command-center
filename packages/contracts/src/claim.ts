/**
 * Claim: one typed assertion about one entity, e.g. "Quillmark Security raised a Series A of EUR 12,000,000
 * on 2026-06-18". A claim answers "what exactly are we asserting?" and points at the evidence behind it.
 * The human-readable `statement` is rendered by code from the typed assertion, never written by a model.
 */
import { z } from 'zod';
import {
  AgentType,
  ClaimId,
  CompanyId,
  Count,
  CountryCode,
  CurrencyCode,
  EvidenceId,
  ExecutionId,
  FundingStage,
  GapId,
  HttpUrl,
  IsoDate,
  PersonId,
  PersonRole,
  RegistryScheme,
  RunId,
  Sha256Hex,
  SourceId,
  TaskId,
  Timestamp,
  WorkspaceId,
} from './common';

export const ClaimAttribute = z.enum([
  'company.website',
  'company.hq_country',
  'company.hq_city',
  'company.founded_year',
  'company.description',
  'company.sector',
  'company.funding_round',
  'company.employee_count',
  'company.hiring_signal',
  'company.registry_id',
  'person.current_role',
  'person.public_profile',
]);
export type ClaimAttribute = z.infer<typeof ClaimAttribute>;

/** Normalised: stage enum, whole currency units, ISO currency and date. rawValue keeps the source's wording. */
export const FundingRoundValue = z
  .object({
    stage: FundingStage,
    amount: z.int().positive().nullable(),
    currency: CurrencyCode.nullable(),
    announcedOn: IsoDate,
    leadInvestors: z.array(z.string().trim().min(1).max(120)).max(10),
    otherInvestors: z.array(z.string().trim().min(1).max(120)).max(30),
  })
  .refine((v) => (v.amount === null) === (v.currency === null), { error: 'amount and currency are set together' });

const assertion = <A extends ClaimAttribute, V extends z.ZodType>(attribute: A, value: V) =>
  z.object({ attribute: z.literal(attribute), value });

export const ClaimAssertion = z.discriminatedUnion('attribute', [
  assertion('company.website', z.object({ url: HttpUrl })),
  assertion('company.hq_country', z.object({ country: CountryCode })),
  assertion('company.hq_city', z.object({ city: z.string().trim().min(1).max(100) })),
  assertion('company.founded_year', z.object({ year: z.int().min(1800).max(2100) })),
  assertion('company.description', z.object({ text: z.string().trim().min(10).max(600) })),
  assertion('company.sector', z.object({ tags: z.array(z.string().trim().min(2).max(60)).min(1).max(8) })),
  assertion('company.funding_round', FundingRoundValue),
  assertion('company.employee_count', z.object({ min: Count, max: Count.nullable() })),
  assertion(
    'company.hiring_signal',
    z.object({ summary: z.string().trim().min(5).max(300), openRoles: Count.nullable() }),
  ),
  assertion('company.registry_id', z.object({ scheme: RegistryScheme, id: z.string().trim().min(1).max(40) })),
  assertion(
    'person.current_role',
    z.object({
      companyId: CompanyId,
      title: z.string().trim().min(2).max(120),
      role: PersonRole,
      since: IsoDate.nullable(),
    }),
  ),
  assertion(
    'person.public_profile',
    z.object({ url: HttpUrl, kind: z.enum(['company_team_page', 'professional_network', 'personal_site', 'other']) }),
  ),
]);
export type ClaimAssertion = z.infer<typeof ClaimAssertion>;

export const ClaimSubject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('company'), companyId: CompanyId }),
  z.object({ kind: z.literal('person'), personId: PersonId }),
]);
export type ClaimSubject = z.infer<typeof ClaimSubject>;

export const ClaimStatus = z.enum(['proposed', 'grounded', 'verified', 'probable', 'contested', 'stale', 'rejected']);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

/** Calculated by code from evidence features. A model never supplies it. */
export const ConfidenceLevel = z.enum(['high', 'medium', 'low']);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

export const VerificationReasonCode = z.enum([
  'QUOTE_NOT_FOUND',
  'QUOTE_TOO_SHORT',
  'VALUE_NOT_IN_QUOTE',
  'JUDGE_UNSUPPORTED',
  'JUDGE_CONTRADICTS',
  'AUTHORITATIVE_SOURCE',
  'INDEPENDENT_SOURCES',
  'SINGLE_SOURCE',
  'SYNDICATED_DUPLICATE',
  'SOURCE_TOO_OLD',
  'OUTSIDE_CRITERIA',
  'CONFLICTING_VALUE',
  'SUSPECTED_INJECTION_SOURCE',
  'SUPERSEDED',
]);
export type VerificationReasonCode = z.infer<typeof VerificationReasonCode>;

export const VerificationReason = z.object({
  code: VerificationReasonCode,
  detail: z.string().max(300),
  evidenceIds: z.array(EvidenceId).max(20),
});
export type VerificationReason = z.infer<typeof VerificationReason>;

const SCORED_STATUSES: readonly ClaimStatus[] = ['verified', 'probable', 'contested'];

export const Verification = z
  .object({
    status: ClaimStatus,
    confidence: ConfidenceLevel.nullable(),
    confidenceScore: z.number().min(0).max(1).nullable(),
    reasons: z.array(VerificationReason).max(20),
    policy: z.object({ id: z.string().min(1).max(60), version: z.int().positive() }).nullable(),
    evaluatedAt: Timestamp.nullable(),
    evaluatedByTaskId: TaskId.nullable(),
  })
  .superRefine((v, ctx) => {
    if (SCORED_STATUSES.includes(v.status) !== (v.confidence !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['confidence'],
        message: 'confidence is set exactly for verified, probable and contested claims',
      });
    }
    if ((v.confidence === null) !== (v.confidenceScore === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['confidenceScore'],
        message: 'confidence and confidenceScore are set together',
      });
    }
    if ((v.status === 'proposed') !== (v.evaluatedAt === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['evaluatedAt'],
        message: 'every status except proposed has been evaluated',
      });
    }
  });
export type Verification = z.infer<typeof Verification>;

export const ConflictState = z.object({
  state: z.enum(['none', 'conflicting', 'superseded']),
  conflictingClaimIds: z.array(ClaimId).max(20),
  supersededBy: ClaimId.nullable(),
});
export type ConflictState = z.infer<typeof ConflictState>;

export const Claim = z
  .object({
    id: ClaimId,
    workspaceId: WorkspaceId,
    runId: RunId,
    subject: ClaimSubject,
    assertion: ClaimAssertion,
    /** How the source phrased it, e.g. "€12 million". */
    rawValue: z.string().min(1).max(300),
    /** Rendered by code from `assertion`. Reports show this, never model prose. */
    statement: z.string().min(5).max(400),
    /** sha256(subject, attribute, canonical value). Unique per run: the idempotency key for claim writes. */
    fingerprint: Sha256Hex,
    evidenceIds: z.array(EvidenceId).min(1).max(20),
    sourceDates: z.object({
      newestPublishedAt: Timestamp.nullable(),
      oldestPublishedAt: Timestamp.nullable(),
      newestRetrievedAt: Timestamp,
    }),
    verification: Verification,
    conflict: ConflictState,
    provenance: z.object({ proposedByAgent: AgentType, proposedByExecutionId: ExecutionId, proposedAt: Timestamp }),
  })
  .superRefine((c, ctx) => {
    if (!c.assertion.attribute.startsWith(`${c.subject.kind}.`)) {
      ctx.addIssue({
        code: 'custom',
        path: ['assertion', 'attribute'],
        message: 'attribute does not apply to this subject kind',
      });
    }
    if (c.conflict.state === 'conflicting' && c.verification.status !== 'contested') {
      ctx.addIssue({ code: 'custom', path: ['verification', 'status'], message: 'a conflicting claim is contested' });
    }
    if ((c.conflict.state === 'superseded') !== (c.conflict.supersededBy !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['conflict', 'supersededBy'],
        message: 'supersededBy is set exactly when superseded',
      });
    }
  });
export type Claim = z.infer<typeof Claim>;

// ---------------------------------------------------------------------------
// What agents return. The domain validates, grounds and persists these; agents never write claims directly.
// ---------------------------------------------------------------------------
export const ProposedSubject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('company'), companyId: CompanyId }),
  z.object({ kind: z.literal('person'), personId: PersonId }),
  z.object({
    kind: z.literal('new_company'),
    name: z.string().trim().min(2).max(200),
    domainHint: z.string().max(253).nullable(),
  }),
  z.object({ kind: z.literal('new_person'), fullName: z.string().trim().min(3).max(120) }),
]);
export type ProposedSubject = z.infer<typeof ProposedSubject>;

export const ProposedEvidence = z.strictObject({
  sourceId: SourceId,
  quote: z.string().trim().min(20).max(1200),
});

export const ProposedClaim = z.strictObject({
  subject: ProposedSubject,
  assertion: ClaimAssertion,
  rawValue: z.string().trim().min(1).max(300),
  evidence: z.array(ProposedEvidence).min(1).max(5),
});
export type ProposedClaim = z.infer<typeof ProposedClaim>;

/** A required attribute we could not establish. "Not found" is a recorded result, not a silent omission. */
export const ResearchGap = z
  .object({
    id: GapId,
    workspaceId: WorkspaceId,
    runId: RunId,
    companyId: CompanyId,
    personId: PersonId.nullable(),
    attribute: ClaimAttribute,
    status: z.enum(['open', 'filled', 'unavailable']),
    reason: z.enum(['no_claim', 'only_rejected_claims', 'only_stale_claims', 'conflict_unresolved']),
    attempts: Count,
    note: z.string().max(300).nullable(),
    createdAt: Timestamp,
    resolvedAt: Timestamp.nullable(),
  })
  .superRefine((g, ctx) => {
    if ((g.status === 'open') !== (g.resolvedAt === null)) {
      ctx.addIssue({ code: 'custom', path: ['resolvedAt'], message: 'resolvedAt is set exactly for resolved gaps' });
    }
  });
export type ResearchGap = z.infer<typeof ResearchGap>;

/**
 * Findings and artifacts: what the user finally reads.
 *
 * The rule: a report never contains model-generated facts. Facts appear only as claim statements
 * (rendered by code). Model-written text appears only as findings labelled analysis or inference,
 * and every finding cites the claims it rests on:
 *   Artifact -> Finding -> Claim -> Evidence -> SourceSnapshot -> exact quote span
 */
import { z } from 'zod';
import {
  ArtifactId,
  ClaimId,
  CompanyId,
  ExecutionId,
  FindingId,
  GapId,
  PersonId,
  RunId,
  Sha256Hex,
  Timestamp,
  WorkspaceId,
} from './common';

export const FindingKind = z.enum(['score', 'analysis', 'inference', 'recommendation', 'risk']);
export type FindingKind = z.infer<typeof FindingKind>;

/** fact_derived: assembled by code from claims. analysis / inference: written by a model, always labelled. */
export const FindingLabel = z.enum(['fact_derived', 'analysis', 'inference']);
export type FindingLabel = z.infer<typeof FindingLabel>;

export const FindingSubject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('company'), companyId: CompanyId }),
  z.object({ kind: z.literal('person'), personId: PersonId }),
  z.object({ kind: z.literal('run') }),
]);

export const ClaimRef = z.object({ claimId: ClaimId, role: z.enum(['basis', 'context']) });

export const ScoreComponent = z.object({
  criterion: z.string().min(1).max(60),
  weight: z.number().min(0).max(1),
  value: z.number().min(0).max(1),
  claimIds: z.array(ClaimId).max(20),
});

export const Author = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('code'), module: z.string().min(1).max(100), version: z.string().min(1).max(40) }),
  z.object({ kind: z.literal('model'), executionId: ExecutionId }),
]);
export type Author = z.infer<typeof Author>;

export const Finding = z
  .object({
    id: FindingId,
    workspaceId: WorkspaceId,
    runId: RunId,
    subject: FindingSubject,
    kind: FindingKind,
    label: FindingLabel,
    statement: z.string().min(5).max(1200),
    claimRefs: z.array(ClaimRef).min(1).max(30),
    score: z
      .object({
        total: z.number().min(0).max(1),
        components: z.array(ScoreComponent).min(1).max(12),
        scoringVersion: z.string().min(1).max(40),
      })
      .nullable(),
    author: Author,
    createdAt: Timestamp,
  })
  .superRefine((f, ctx) => {
    if ((f.kind === 'score') !== (f.score !== null)) {
      ctx.addIssue({ code: 'custom', path: ['score'], message: 'score details exist exactly for score findings' });
    }
    if (f.kind === 'score' && f.author.kind !== 'code') {
      ctx.addIssue({ code: 'custom', path: ['author'], message: 'scores are computed by code' });
    }
    if ((f.label === 'fact_derived') !== (f.author.kind === 'code')) {
      ctx.addIssue({
        code: 'custom',
        path: ['label'],
        message: 'code produces fact_derived findings; models produce labelled analysis or inference',
      });
    }
    if (!f.claimRefs.some((r) => r.role === 'basis')) {
      ctx.addIssue({ code: 'custom', path: ['claimRefs'], message: 'a finding needs at least one basis claim' });
    }
  });
export type Finding = z.infer<typeof Finding>;

export const ArtifactKind = z.enum(['prospect_report', 'outreach_draft']);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/** Versions are immutable. Editing an artifact creates a new version, which needs its own approval. */
export const ArtifactStatus = z.enum(['draft', 'pending_approval', 'approved', 'rejected', 'superseded', 'final']);
export type ArtifactStatus = z.infer<typeof ArtifactStatus>;

export const OutreachDraftContent = z.object({
  kind: z.literal('outreach_draft'),
  companyId: CompanyId,
  personId: PersonId,
  channel: z.enum(['email', 'linkedin_message']),
  subjectLine: z.string().max(150).nullable(),
  body: z.string().min(50).max(3000),
  /** Every personal detail in the body, with the verified claims it comes from. Checked by code. */
  personalization: z
    .array(z.object({ text: z.string().min(5).max(300), claimIds: z.array(ClaimId).min(1).max(5) }))
    .min(1)
    .max(6),
});

export const ReportContent = z.object({
  kind: z.literal('prospect_report'),
  generatedAt: Timestamp,
  companies: z
    .array(
      z.object({
        companyId: CompanyId,
        rank: z.int().positive(),
        scoreFindingId: FindingId,
        claimIds: z.array(ClaimId).max(100),
        findingIds: z.array(FindingId).max(30),
        gapIds: z.array(GapId).max(30),
        outreachArtifactIds: z.array(ArtifactId).max(6),
      }),
    )
    .max(25),
  excluded: z
    .array(z.object({ companyId: CompanyId, reason: z.string().min(1).max(300), claimIds: z.array(ClaimId).max(20) }))
    .max(50),
});

export const ArtifactContent = z.discriminatedUnion('kind', [OutreachDraftContent, ReportContent]);

export const Artifact = z
  .object({
    id: ArtifactId,
    workspaceId: WorkspaceId,
    runId: RunId,
    kind: ArtifactKind,
    version: z.int().positive(),
    previousVersionId: ArtifactId.nullable(),
    status: ArtifactStatus,
    content: ArtifactContent,
    contentHash: Sha256Hex,
    /** Flattened references for integrity checks and joins. */
    references: z.object({ claimIds: z.array(ClaimId).max(500), findingIds: z.array(FindingId).max(200) }),
    author: Author,
    createdAt: Timestamp,
  })
  .superRefine((a, ctx) => {
    if (a.content.kind !== a.kind) {
      ctx.addIssue({ code: 'custom', path: ['content', 'kind'], message: 'content.kind must equal kind' });
    }
    if ((a.version === 1) !== (a.previousVersionId === null)) {
      ctx.addIssue({ code: 'custom', path: ['previousVersionId'], message: 'only version 1 has no previous version' });
    }
  });
export type Artifact = z.infer<typeof Artifact>;

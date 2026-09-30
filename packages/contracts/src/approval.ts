/**
 * Approval: a human decision on a frozen snapshot. The snapshot is hashed (SHA-256 over RFC 8785
 * canonical JSON), stored, shown to the user, and the decision must quote the hash it saw.
 * If the underlying data changes, the approval is invalidated and a new one is requested.
 */
import { z } from 'zod';
import {
  ApprovalId,
  ArtifactId,
  ClaimId,
  EvidenceId,
  RunId,
  Sha256Hex,
  TaskId,
  Timestamp,
  UsdMicros,
  UserId,
  WorkspaceId,
} from './common';
import { ClaimStatus, ConfidenceLevel } from './claim';
import { Assumption, Budget, InterpretedCriteria, Spend } from './run';

export const ApprovalType = z.enum(['plan', 'outreach_draft', 'budget_extension']);
export type ApprovalType = z.infer<typeof ApprovalType>;

export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'invalidated']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const ApprovalTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('plan'), runId: RunId, briefRevision: z.int().positive() }),
  z.object({ type: z.literal('outreach_draft'), artifactId: ArtifactId, artifactVersion: z.int().positive() }),
  z.object({ type: z.literal('budget_extension'), runId: RunId }),
]);
export type ApprovalTarget = z.infer<typeof ApprovalTarget>;

// ---------------------------------------------------------------------------
// Snapshots: exactly what the user sees and approves. Hash input = canonical JSON of the snapshot.
// ---------------------------------------------------------------------------
export const PlanSnapshot = z.object({
  kind: z.literal('plan'),
  objective: z.string().min(10).max(4000),
  criteria: InterpretedCriteria,
  assumptions: z.array(Assumption).max(20),
  budget: Budget,
  estimate: z.object({ costUsdMicrosLow: UsdMicros, costUsdMicrosHigh: UsdMicros }),
  workflowVersion: z.int().positive(),
});

export const OutreachSnapshot = z.object({
  kind: z.literal('outreach_draft'),
  artifactId: ArtifactId,
  artifactVersion: z.int().positive(),
  contentHash: Sha256Hex,
  channel: z.enum(['email', 'linkedin_message']),
  subjectLine: z.string().max(150).nullable(),
  body: z.string().min(50).max(3000),
  /** The cited claims as they were at snapshot time. A later status change invalidates the approval. */
  citedClaims: z
    .array(
      z.object({
        claimId: ClaimId,
        statement: z.string().min(5).max(400),
        status: ClaimStatus,
        confidence: ConfidenceLevel.nullable(),
        evidenceIds: z.array(EvidenceId).min(1).max(20),
      }),
    )
    .min(1)
    .max(20),
});

export const BudgetSnapshot = z.object({
  kind: z.literal('budget_extension'),
  current: Budget,
  spent: Spend,
  requested: Budget,
  reason: z.string().min(1).max(500),
});

export const ApprovalSnapshot = z.discriminatedUnion('kind', [PlanSnapshot, OutreachSnapshot, BudgetSnapshot]);
export type ApprovalSnapshot = z.infer<typeof ApprovalSnapshot>;

export const ApprovalDecision = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    actorId: UserId,
    decidedAt: Timestamp,
    /** Must equal Approval.snapshotHash, otherwise the decision is refused as stale. */
    snapshotHashSeen: Sha256Hex,
    reason: z.string().trim().max(2000).nullable(),
  })
  .refine((d) => d.decision === 'approved' || (d.reason !== null && d.reason.length > 0), {
    error: 'A rejection needs a reason',
    path: ['reason'],
  });
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const Approval = z
  .object({
    id: ApprovalId,
    workspaceId: WorkspaceId,
    runId: RunId,
    taskId: TaskId.nullable(),
    type: ApprovalType,
    target: ApprovalTarget,
    snapshot: ApprovalSnapshot,
    snapshotHash: Sha256Hex,
    snapshotSchemaVersion: z.int().positive(),
    status: ApprovalStatus,
    requestedAt: Timestamp,
    decision: ApprovalDecision.nullable(),
    invalidation: z
      .object({
        invalidatedAt: Timestamp,
        reason: z.enum(['target_changed', 'cited_claims_changed', 'run_cancelled', 'superseded']),
        detail: z.string().max(500),
        replacedBy: ApprovalId.nullable(),
      })
      .nullable(),
  })
  .superRefine((a, ctx) => {
    if (a.target.type !== a.type || a.snapshot.kind !== a.type) {
      ctx.addIssue({ code: 'custom', path: ['type'], message: 'type, target.type and snapshot.kind must agree' });
    }
    // An approved item can later be invalidated; it keeps the decision that was made.
    const decided = a.status === 'approved' || a.status === 'rejected';
    if ((decided && a.decision === null) || (a.status === 'pending' && a.decision !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['decision'],
        message: 'approved and rejected approvals have a decision; pending ones do not',
      });
    }
    if (decided && a.decision !== null && a.decision.decision !== a.status) {
      ctx.addIssue({ code: 'custom', path: ['status'], message: 'status must match the decision' });
    }
    if (a.decision !== null && a.decision.snapshotHashSeen !== a.snapshotHash) {
      ctx.addIssue({
        code: 'custom',
        path: ['decision', 'snapshotHashSeen'],
        message: 'decision was made on a different snapshot',
      });
    }
    if ((a.status === 'invalidated') !== (a.invalidation !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['invalidation'],
        message: 'invalidation details exist exactly for invalidated approvals',
      });
    }
  });
export type Approval = z.infer<typeof Approval>;

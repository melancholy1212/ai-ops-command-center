/**
 * Domain commands: the only way a user changes workflow state. Server actions validate these,
 * check the caller's workspace role, then run the transition in one database transaction.
 */
import { z } from 'zod';
import { ApprovalId, HttpUrl, ProjectId, RunId, Sha256Hex, type WorkspaceRole } from './common';
import { Budget } from './run';

export const CreateRunCommand = z.strictObject({
  projectId: ProjectId,
  objective: z.string().trim().min(10).max(4000),
  budget: Budget.optional(),
  /** Pages the user points the research at. They become fetchable in the run with a user_provided origin. */
  seedUrls: z.array(HttpUrl).max(20).optional(),
});
export type CreateRunCommand = z.infer<typeof CreateRunCommand>;

export const StartRunCommand = z.strictObject({ runId: RunId });
export type StartRunCommand = z.infer<typeof StartRunCommand>;

export const DecideApprovalCommand = z
  .strictObject({
    approvalId: ApprovalId,
    decision: z.enum(['approved', 'rejected']),
    /** The hash of the snapshot the user was shown. Refused if it no longer matches. */
    snapshotHashSeen: Sha256Hex,
    reason: z.string().trim().max(2000).nullable(),
  })
  .refine((c) => c.decision === 'approved' || (c.reason !== null && c.reason.length > 0), {
    error: 'A rejection needs a reason',
    path: ['reason'],
  });
export type DecideApprovalCommand = z.infer<typeof DecideApprovalCommand>;

export const CancelRunCommand = z.strictObject({ runId: RunId, reason: z.string().trim().max(500).nullable() });
export type CancelRunCommand = z.infer<typeof CancelRunCommand>;

export const PauseRunCommand = z.strictObject({ runId: RunId });
export type PauseRunCommand = z.infer<typeof PauseRunCommand>;

export const ResumeRunCommand = z.strictObject({ runId: RunId });
export type ResumeRunCommand = z.infer<typeof ResumeRunCommand>;

export type CommandName = 'createRun' | 'startRun' | 'decideApproval' | 'cancelRun' | 'pauseRun' | 'resumeRun';

/** Minimum workspace role per command. Viewers can read everything in their workspace and change nothing. */
export const COMMAND_MIN_ROLE = {
  createRun: 'member',
  startRun: 'member',
  decideApproval: 'member',
  cancelRun: 'member',
  pauseRun: 'member',
  resumeRun: 'member',
} as const satisfies Record<CommandName, WorkspaceRole>;

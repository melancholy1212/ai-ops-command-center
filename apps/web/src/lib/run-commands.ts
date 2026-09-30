/**
 * The web side of the domain commands (docs/security.md#backend-authorisation): the caller resolves the user
 * from the verified session; packages/core checks membership and role and performs the transition in one
 * transaction. Kept free of Next.js imports so it is tested against the database directly.
 */
import type { ApprovalId, RunId, UserId, WorkspaceId } from '@aoc/contracts';
import { cancelRun, createRun, decideApproval, DomainError, startRun } from '@aoc/core';
import type { Database } from '@aoc/db';
import type { DecisionInput, NewRunInput } from './run-forms';

export async function createAndStartRun(
  db: Database,
  userId: UserId,
  workspaceId: WorkspaceId,
  input: NewRunInput,
): Promise<RunId> {
  const runId = await createRun(db, { userId }, workspaceId, {
    projectId: input.projectId,
    objective: input.objective,
    ...(input.seedUrls.length > 0 ? { seedUrls: input.seedUrls } : {}),
  });
  // If starting fails the run stays a draft, and its page offers to start it.
  await startRun(db, { userId }, workspaceId, { runId });
  return runId;
}

export async function startDraftRun(db: Database, userId: UserId, workspaceId: WorkspaceId, runId: RunId) {
  await startRun(db, { userId }, workspaceId, { runId });
}

export async function cancelRunFor(db: Database, userId: UserId, workspaceId: WorkspaceId, runId: RunId) {
  await cancelRun(db, { userId }, workspaceId, { runId, reason: null });
}

export async function decide(db: Database, userId: UserId, workspaceId: WorkspaceId, input: DecisionInput) {
  await decideApproval(db, { userId }, workspaceId, {
    approvalId: input.approvalId as ApprovalId,
    decision: input.decision,
    snapshotHashSeen: input.snapshotHash,
    reason: input.reason,
  });
}

/** Domain errors carry messages written for users; anything else is logged and reported generically. */
export function commandErrorMessage(error: unknown): string {
  if (error instanceof DomainError) return error.message;
  console.error(
    JSON.stringify({ service: 'web', msg: 'command failed', err: error instanceof Error ? error.message : 'unknown' }),
  );
  return 'The command could not be completed. Try again in a moment.';
}

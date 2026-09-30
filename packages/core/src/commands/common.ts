import { COMMAND_MIN_ROLE, type Actor, type CommandName, type UserId, type WorkspaceRole } from '@aoc/contracts';
import { toJson, type WorkspaceTransaction } from '@aoc/db';
import type { z } from 'zod';
import { DomainError } from '../errors';

export interface UserActor {
  userId: UserId;
}

export function actorOf(user: UserActor): Actor {
  return { kind: 'user', userId: user.userId };
}

/** Parses command input; invalid input is a user-facing validation error, never a crash. */
export function parseCommand<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    throw new DomainError('VALIDATION', detail);
  }
  return result.data;
}

const RANK: Record<WorkspaceRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** The caller must be a member of the workspace with at least the command's minimum role. */
export async function authorize(tx: WorkspaceTransaction, user: UserActor, workspaceId: string, command: CommandName) {
  const membership = await tx
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', user.userId)
    .executeTakeFirst();
  if (!membership) throw new DomainError('FORBIDDEN', 'You are not a member of this workspace.');
  const required = COMMAND_MIN_ROLE[command];
  if (RANK[membership.role as WorkspaceRole] < RANK[required]) {
    throw new DomainError('FORBIDDEN', `This action needs the ${required} role.`);
  }
}

export async function audit(
  tx: WorkspaceTransaction,
  workspaceId: string,
  actor: Actor,
  action: string,
  target: { type: string; id: string },
  metadata: Record<string, unknown> = {},
) {
  await tx
    .insertInto('audit_logs')
    .values({
      workspace_id: workspaceId,
      actor: toJson(actor),
      action,
      target_type: target.type,
      target_id: target.id,
      metadata: toJson(metadata),
    })
    .execute();
}

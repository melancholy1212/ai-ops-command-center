import type { WorkspaceId } from '@aoc/contracts';
import { sql, type Transaction } from 'kysely';
import type { Database } from './client';
import type { DB, Json } from './generated';

export type WorkspaceTransaction = Transaction<DB>;

/**
 * Run `fn` in one transaction that acts as `app_backend`, scoped to one workspace (ADR-0005).
 * Row-level security then confines every query to that workspace, even if the code forgets a
 * filter. Both settings are transaction-local, so nothing leaks to the next user of the
 * pooled connection.
 */
export async function withWorkspace<T>(
  db: Database,
  workspaceId: WorkspaceId,
  fn: (tx: WorkspaceTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`set local role app_backend`.execute(tx);
    await sql`select set_config('app.workspace_id', ${workspaceId}, true)`.execute(tx);
    return fn(tx);
  });
}

/**
 * A transaction as `app_backend` with no workspace: row-level security returns nothing, and only the
 * two cross-workspace SECURITY DEFINER functions (claim a task, reap expired leases) do anything.
 */
export async function withBackend<T>(db: Database, fn: (tx: WorkspaceTransaction) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`set local role app_backend`.execute(tx);
    return fn(tx);
  });
}

/** Converts a domain value to a JSON column value (drops undefined fields, keeps the shape). */
export function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { DB } from './generated';

export type Database = Kysely<DB>;

export interface DbOptions {
  /** Shown in pg_stat_activity, so connections can be traced to a service. */
  applicationName: string;
  maxConnections?: number;
}

/**
 * Backend services connect as `aoc_service`, which has no table privileges of its own:
 * every query must run inside `withWorkspace` (or a SECURITY DEFINER function it may call).
 */
export function createDb(connectionString: string, options: DbOptions): Database {
  const pool = new pg.Pool({
    connectionString,
    application_name: options.applicationName,
    max: options.maxConnections ?? 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/** Cheap connectivity check for health endpoints. Needs no table privileges. */
export async function ping(db: Database): Promise<void> {
  await sql`select 1`.execute(db);
}

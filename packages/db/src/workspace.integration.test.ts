// Runs against the local Supabase stack (`pnpm db:start`), connected as the real login role.
import { randomBytes, randomUUID } from 'node:crypto';
import type { WorkspaceId } from '@aoc/contracts';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, ping, type Database } from './client';
import { withWorkspace } from './workspace';

// Local-only admin credentials (Supabase CLI defaults); CI runs the same local stack.
const ADMIN_URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

const admin = new pg.Client({ connectionString: ADMIN_URL });
const alice = randomUUID();
const bob = randomUUID();
let service: Database;
let aliceWs: WorkspaceId;
let bobWs: WorkspaceId;

beforeAll(async () => {
  await admin.connect();
  // A throwaway password for the login role, generated per run and never stored.
  const password = randomBytes(24).toString('hex');
  await admin.query(`alter role aoc_service password '${password}'`);

  for (const [id, name] of [
    [alice, 'alice'],
    [bob, 'bob'],
  ] as const) {
    await admin.query(
      `insert into auth.users (id, aud, role, email) values ($1, 'authenticated', 'authenticated', $2)`,
      [id, `${name}-${id}@example.test`],
    );
  }
  const { rows } = await admin.query<{ user_id: string; workspace_id: WorkspaceId }>(
    'select user_id, workspace_id from public.workspace_members where user_id = any($1)',
    [[alice, bob]],
  );
  aliceWs = rows.find((r) => r.user_id === alice)!.workspace_id;
  bobWs = rows.find((r) => r.user_id === bob)!.workspace_id;

  const url = new URL(ADMIN_URL);
  url.username = 'aoc_service';
  url.password = password;
  // One connection, so the leak test below provably reuses the same physical connection.
  service = createDb(url.toString(), { applicationName: 'db-integration-test', maxConnections: 1 });
});

afterAll(async () => {
  await service.destroy();
  await admin.query('delete from public.workspaces where id = any($1)', [[aliceWs, bobWs]]);
  await admin.query('delete from auth.users where id = any($1)', [[alice, bob]]);
  await admin.end();
});

describe('withWorkspace, connected as aoc_service', () => {
  it('reaches the database without any table privileges', async () => {
    await expect(ping(service)).resolves.toBeUndefined();
  });

  it('cannot read tenant tables outside a workspace transaction', async () => {
    await expect(service.selectFrom('workspaces').selectAll().execute()).rejects.toThrow(/permission denied/);
  });

  it('sees only the scoped workspace', async () => {
    const rows = await withWorkspace(service, aliceWs, (tx) => tx.selectFrom('workspaces').select('id').execute());
    expect(rows.map((r) => r.id)).toEqual([aliceWs]);
  });

  it('writes inside the scoped workspace', async () => {
    const created = await withWorkspace(service, aliceWs, (tx) =>
      tx
        .insertInto('projects')
        .values({ workspace_id: aliceWs, name: 'Integration project' })
        .returning('workspace_id')
        .executeTakeFirstOrThrow(),
    );
    expect(created.workspace_id).toBe(aliceWs);
  });

  it('cannot write into another workspace', async () => {
    await expect(
      withWorkspace(service, aliceWs, (tx) =>
        tx.insertInto('projects').values({ workspace_id: bobWs, name: 'Intrusion' }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('does not leak its role or scope to the next use of the pooled connection', async () => {
    await withWorkspace(service, aliceWs, (tx) => tx.selectFrom('workspaces').select('id').execute());
    const { rows } = await sql<{ role: string; scope: string | null }>`
      select current_user as role, nullif(current_setting('app.workspace_id', true), '') as scope
    `.execute(service);
    expect(rows[0]).toEqual({ role: 'aoc_service', scope: null });
  });

  it('rolls everything back when the callback throws', async () => {
    await expect(
      withWorkspace(service, aliceWs, async (tx) => {
        await tx.insertInto('projects').values({ workspace_id: aliceWs, name: 'Rolled back' }).execute();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await withWorkspace(service, aliceWs, (tx) =>
      tx.selectFrom('projects').select('name').where('name', '=', 'Rolled back').execute(),
    );
    expect(rows).toEqual([]);
  });
});

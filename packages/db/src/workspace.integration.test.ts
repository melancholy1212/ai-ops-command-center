// Runs against the local Supabase stack (`pnpm db:start`). It connects as a throwaway login role configured
// exactly like aoc_service (asserted below), so tests never change the credentials local development uses.
import { randomBytes, randomUUID } from 'node:crypto';
import type { WorkspaceId } from '@aoc/contracts';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, ping, type Database } from './client';
import { toJson, withWorkspace } from './workspace';

// Local-only admin credentials (Supabase CLI defaults); CI runs the same local stack.
const ADMIN_URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

const admin = new pg.Client({ connectionString: ADMIN_URL });
const testRole = `aoc_it_${randomBytes(6).toString('hex')}`;
const alice = randomUUID();
const bob = randomUUID();
let service: Database;
let aliceWs: WorkspaceId;
let bobWs: WorkspaceId;

// The attributes that make aoc_service safe: login, no inheritance, no RLS bypass, SET-only membership.
const ROLE_SHAPE = `
  select r.rolcanlogin, r.rolinherit, r.rolbypassrls, m.inherit_option, m.set_option, m.admin_option
  from pg_roles r
  join pg_auth_members m on m.member = r.oid
  join pg_roles g on g.oid = m.roleid and g.rolname = 'app_backend'
  where r.rolname = $1`;

beforeAll(async () => {
  await admin.connect();
  // Roles left behind by an interrupted earlier run.
  const stale = await admin.query<{ rolname: string }>(
    "select rolname from pg_roles where rolname like 'aoc\\_it\\_%'",
  );
  for (const { rolname } of stale.rows) await admin.query(`drop role if exists "${rolname}"`);

  // Generated per run and never stored.
  const password = randomBytes(24).toString('hex');
  await admin.query(`create role ${testRole} login noinherit nobypassrls password '${password}'`);
  await admin.query(`grant app_backend to ${testRole} with inherit false, set true`);

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
  url.username = testRole;
  url.password = password;
  // One connection, so the leak test below provably reuses the same physical connection.
  service = createDb(url.toString(), { applicationName: 'db-integration-test', maxConnections: 1 });
});

afterAll(async () => {
  await service.destroy();
  await admin.query('delete from public.workspaces where id = any($1)', [[aliceWs, bobWs]]);
  await admin.query('delete from auth.users where id = any($1)', [[alice, bob]]);
  await admin.query(`drop role if exists ${testRole}`);
  await admin.end();
});

describe('withWorkspace, connected as a login role identical to aoc_service', () => {
  it('uses a role configured exactly like aoc_service', async () => {
    const real = await admin.query(ROLE_SHAPE, ['aoc_service']);
    const test = await admin.query(ROLE_SHAPE, [testRole]);
    expect(real.rows).toHaveLength(1);
    expect(test.rows).toEqual(real.rows);
  });

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
    expect(rows[0]).toEqual({ role: testRole, scope: null });
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

describe('toJson', () => {
  it('sends arrays, strings, objects and null as valid JSON parameters', async () => {
    const values: unknown[] = [
      [{ a: 1 }, 'two', 3],
      'plain text',
      { nested: { list: [1, 2] }, skipped: undefined },
      null,
      42,
    ];
    for (const value of values) {
      const { rows } = await sql<{ v: unknown }>`select ${toJson(value)}::jsonb as v`.execute(service);
      expect(rows[0]?.v).toEqual(JSON.parse(JSON.stringify(value ?? null)));
    }
  });
});

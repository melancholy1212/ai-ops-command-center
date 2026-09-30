// Shared harness for integration tests against the local Supabase stack. Not used in production code.
// Connects as a throwaway login role configured exactly like aoc_service, so tests exercise the real
// isolation mechanism without touching the credentials local development uses.
import { randomBytes, randomUUID } from 'node:crypto';
import type { ProjectId, UserId, WorkspaceId } from '@aoc/contracts';
import pg from 'pg';
import { createDb, type Database } from './client';

export const LOCAL_ADMIN_URL = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

export interface TestTenant {
  userId: UserId;
  workspaceId: WorkspaceId;
  projectId: ProjectId;
  email: string;
}

export interface TestHarness {
  admin: pg.Client;
  roleName: string;
  serviceUrl: string;
  /** A connection pool as the throwaway service role. Create more with `connect()` for multi-worker tests. */
  db: Database;
  connect(applicationName: string, maxConnections?: number): Database;
  createTenant(label: string): Promise<TestTenant>;
  close(): Promise<void>;
}

export async function createTestHarness(): Promise<TestHarness> {
  const adminUrl = process.env.SUPABASE_DB_URL ?? LOCAL_ADMIN_URL;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();

  // Leftovers of runs that were interrupted more than an hour ago. Role names carry their creation
  // time, so a harness never drops the role of another test run that is still going.
  const cutoff = Math.floor(Date.now() / 1000) - 3600;
  const stale = await admin.query<{ rolname: string }>(
    "select rolname from pg_roles where rolname ~ '^aoc_it_[0-9]+_'",
  );
  for (const { rolname } of stale.rows) {
    if (Number(rolname.split('_')[2]) < cutoff)
      await admin.query(`drop role if exists "${rolname}"`).catch(() => undefined);
  }
  await admin.query(
    `delete from public.workspaces where id in (
       select m.workspace_id from public.workspace_members m join auth.users u on u.id = m.user_id
       where u.email like '%@example.test' and u.created_at < now() - interval '1 hour')`,
  );
  await admin.query(
    `delete from auth.users where email like '%@example.test' and created_at < now() - interval '1 hour'`,
  );

  const roleName = `aoc_it_${String(Math.floor(Date.now() / 1000))}_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  await admin.query(`create role ${roleName} login noinherit nobypassrls password '${password}'`);
  await admin.query(`grant app_backend to ${roleName} with inherit false, set true`);

  const url = new URL(adminUrl);
  url.username = roleName;
  url.password = password;
  const serviceUrl = url.toString();

  const pools: Database[] = [];
  const connect = (applicationName: string, maxConnections = 5) => {
    const db = createDb(serviceUrl, { applicationName, maxConnections });
    pools.push(db);
    return db;
  };
  const db = connect('integration-test');
  const users: string[] = [];
  const workspaces: string[] = [];

  return {
    admin,
    roleName,
    serviceUrl,
    db,
    connect,
    async createTenant(label) {
      const userId = randomUUID() as UserId;
      const email = `${label}-${userId}@example.test`;
      await admin.query(
        `insert into auth.users (id, aud, role, email) values ($1, 'authenticated', 'authenticated', $2)`,
        [userId, email],
      );
      const { rows } = await admin.query<{ workspace_id: WorkspaceId; project_id: ProjectId }>(
        `select m.workspace_id, p.id as project_id from public.workspace_members m
         join public.projects p on p.workspace_id = m.workspace_id where m.user_id = $1`,
        [userId],
      );
      const row = rows[0];
      if (!row) throw new Error('signup trigger did not create a workspace');
      users.push(userId);
      workspaces.push(row.workspace_id);
      return { userId, workspaceId: row.workspace_id, projectId: row.project_id, email };
    },
    async close() {
      await Promise.all(pools.map((pool) => pool.destroy()));
      if (workspaces.length > 0) await admin.query('delete from public.workspaces where id = any($1)', [workspaces]);
      if (users.length > 0) await admin.query('delete from auth.users where id = any($1)', [users]);
      await admin.query(`drop role if exists ${roleName}`);
      await admin.end();
    },
  };
}

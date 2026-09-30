/**
 * Worker process. Phase 1 skeleton: validates its environment, keeps a live database check,
 * serves /healthz, and shuts down cleanly on SIGTERM. The scheduler (claim, lease, heartbeat,
 * reap, expand) arrives in Phase 2; until then this process does not execute tasks.
 */
import { createLogger } from '@aoc/config/logger';
import { createDb, ping } from '@aoc/db';
import { loadEnv } from './env';
import { healthReport, startHealthServer, type HealthState } from './health';

const env = loadEnv();
const log = createLogger('worker', env.LOG_LEVEL);
const db = createDb(env.DATABASE_URL, { applicationName: `worker:${env.WORKER_ID}`, maxConnections: 5 });

const state: HealthState = {
  service: 'worker',
  instanceId: env.WORKER_ID,
  startedAt: Date.now(),
  database: { ok: false, checkedAt: null },
};

async function checkDatabase(): Promise<void> {
  try {
    await ping(db);
    if (!state.database.ok) log.info({ workerId: env.WORKER_ID }, 'database reachable');
    state.database = { ok: true, checkedAt: Date.now() };
  } catch (error) {
    state.database = { ok: false, checkedAt: Date.now() };
    log.error({ workerId: env.WORKER_ID, err: error }, 'database check failed');
  }
}

const server = startHealthServer(env.HEALTH_PORT, () => healthReport(state, Date.now(), env.HEARTBEAT_INTERVAL_MS * 3));
await checkDatabase();
const timer = setInterval(() => void checkDatabase(), env.HEARTBEAT_INTERVAL_MS);
log.info({ workerId: env.WORKER_ID, healthPort: env.HEALTH_PORT }, 'worker started (no task processing until Phase 2)');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  clearInterval(timer);
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  await db.destroy();
  log.info('stopped');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

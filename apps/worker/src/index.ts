/**
 * Worker process: validates its environment, keeps a live database check for /healthz, and runs the
 * scheduler (claim, lease, heartbeat, lease recovery). SIGTERM stops claiming, lets running handlers
 * finish within the grace period and hands the rest back to the queue.
 */
import { createLogger } from '@aoc/config/logger';
import { createDb, ping } from '@aoc/db';
import { loadEnv } from './env';
import { handlers } from './handlers';
import { healthReport, startHealthServer, type HealthState } from './health';
import { createScheduler } from './scheduler';

const env = loadEnv();
const log = createLogger('worker', env.LOG_LEVEL);
// One connection per concurrent task, plus the claim loop, heartbeats and the reaper.
const db = createDb(env.DATABASE_URL, {
  applicationName: `worker:${env.WORKER_ID}`,
  maxConnections: env.WORKER_CONCURRENCY + 3,
});

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

const scheduler = createScheduler({
  db,
  workerId: env.WORKER_ID,
  handlers,
  log,
  concurrency: env.WORKER_CONCURRENCY,
  leaseSeconds: env.TASK_LEASE_SECONDS,
  heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
});
if (Object.keys(handlers).length === 0) {
  log.warn('no task handlers are registered yet: this worker only recovers expired leases');
}
scheduler.start();
log.info({ workerId: env.WORKER_ID, healthPort: env.HEALTH_PORT }, 'worker started');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  const forceExit = setTimeout(() => process.exit(1), 20_000);
  forceExit.unref();
  await scheduler.stop();
  clearInterval(timer);
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

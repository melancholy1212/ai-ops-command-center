// Child process for the crash-recovery test: claims one profile_company task, heartbeats, and never
// finishes, so the test can kill it with SIGKILL mid-task. Not part of the worker build.
import { createLogger } from '@aoc/config/logger';
import { createDb } from '@aoc/db';
import { createScheduler } from '../scheduler';

const url = process.env.DATABASE_URL;
const workerId = process.env.WORKER_ID;
if (!url || !workerId) throw new Error('DATABASE_URL and WORKER_ID are required');

const db = createDb(url, { applicationName: workerId, maxConnections: 4 });
createScheduler({
  db,
  workerId,
  log: createLogger('crash-worker', 'silent'),
  concurrency: 1,
  leaseSeconds: 2,
  heartbeatIntervalMs: 1_000,
  idlePollMs: 100,
  handlers: { profile_company: () => new Promise(() => undefined) },
}).start();

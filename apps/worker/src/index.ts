/**
 * Worker process: validates its environment, keeps a live database check for /healthz, and runs the
 * scheduler (claim, lease, heartbeat, lease recovery). SIGTERM stops claiming, lets running handlers
 * finish within the grace period and hands the rest back to the queue.
 */
import { createLogger } from '@aoc/config/logger';
import { createDb, ping } from '@aoc/db';
import { loadEnv } from './env';
import { createAnthropicProvider, createOpenAiCompatibleProvider, LlmRouter, type LlmProvider } from '@aoc/llm';
import { createTokenMinter } from './agents/tokens';
import { connectMcp } from './agents/tool-client';
import { createHandlers } from './handlers';
import type { HandlerRegistry } from './scheduler';
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

// Agents need a model provider, the MCP server and the token signing key; without them nothing is claimed
// but lease recovery still runs.
const providers: LlmProvider[] = [];
if (env.ANTHROPIC_API_KEY) providers.push(createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY }));
if (env.EARTHRUNTIME_API_KEY) {
  providers.push(
    createOpenAiCompatibleProvider({
      apiKey: env.EARTHRUNTIME_API_KEY,
      baseURL: env.EARTHRUNTIME_BASE_URL,
      account: 'earthruntime',
    }),
  );
}
const missing = [
  providers.length === 0 ? 'a model provider key (EARTHRUNTIME_API_KEY or ANTHROPIC_API_KEY)' : null,
  env.MCP_URL ? null : 'MCP_URL',
  env.CAPABILITY_PRIVATE_JWK ? null : 'CAPABILITY_PRIVATE_JWK',
].filter((m): m is string => m !== null);
let handlers: HandlerRegistry = {};
if (missing.length === 0 && env.MCP_URL && env.CAPABILITY_PRIVATE_JWK) {
  const mcpUrl = env.MCP_URL;
  handlers = createHandlers({
    router: new LlmRouter({ providers }),
    mintToken: await createTokenMinter(env.CAPABILITY_PRIVATE_JWK),
    connectTools: (token) => connectMcp(mcpUrl, token),
  });
} else {
  log.warn({ missing }, 'agent handlers disabled until configured: this worker only recovers expired leases');
}

const scheduler = createScheduler({
  db,
  workerId: env.WORKER_ID,
  handlers,
  log,
  concurrency: env.WORKER_CONCURRENCY,
  leaseSeconds: env.TASK_LEASE_SECONDS,
  heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
});
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

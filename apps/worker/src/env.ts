import { hostname } from 'node:os';
import { LogLevel, NodeEnv, parseEnv, Port, PostgresUrl } from '@aoc/config/env';
import { z } from 'zod';

const WorkerEnv = z.object({
  NODE_ENV: NodeEnv,
  LOG_LEVEL: LogLevel,
  /** Connection as aoc_service (docs/deployment.md). */
  DATABASE_URL: PostgresUrl,
  WORKER_ID: z
    .string()
    .min(1)
    .max(100)
    .default(() => `${hostname()}-${String(process.pid)}`),
  HEALTH_PORT: Port.default(8081),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
});
export type WorkerEnv = z.infer<typeof WorkerEnv>;

export function loadEnv(source?: Readonly<Record<string, string | undefined>>): WorkerEnv {
  return parseEnv('worker', WorkerEnv, source);
}

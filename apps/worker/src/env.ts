import { hostname } from 'node:os';
import { LogLevel, NodeEnv, parseEnv, Port, PostgresUrl } from '@aoc/config/env';
import { z } from 'zod';

const WorkerEnv = z
  .object({
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
    /** Also the interval of the database health check. */
    HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
    TASK_LEASE_SECONDS: z.coerce.number().int().min(10).max(3_600).default(60),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    /** The MCP server's endpoint for agent tool calls. */
    MCP_URL: z.url({ protocol: /^https?$/ }).optional(),
    /** Ed25519 private key (JWK) that signs capability tokens. Only the worker holds it. */
    CAPABILITY_PRIVATE_JWK: z.string().min(20).optional(),
    /** Model providers: the router uses whichever are configured (docs/llm.md#credentials). */
    ANTHROPIC_API_KEY: z.string().min(10).optional(),
    EARTHRUNTIME_API_KEY: z.string().min(10).optional(),
    EARTHRUNTIME_BASE_URL: z.url({ protocol: /^https$/ }).default('https://api.earthruntime.com/v1'),
  })
  .refine((env) => env.HEARTBEAT_INTERVAL_MS * 2 <= env.TASK_LEASE_SECONDS * 1000, {
    error: 'HEARTBEAT_INTERVAL_MS must be at most half of TASK_LEASE_SECONDS',
    path: ['HEARTBEAT_INTERVAL_MS'],
  });
export type WorkerEnv = z.infer<typeof WorkerEnv>;

export function loadEnv(source?: Readonly<Record<string, string | undefined>>): WorkerEnv {
  return parseEnv('worker', WorkerEnv, source);
}

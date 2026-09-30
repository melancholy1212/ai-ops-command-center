import { LogLevel, NodeEnv, parseEnv, Port, PostgresUrl } from '@aoc/config/env';
import { z } from 'zod';

const McpEnv = z.object({
  NODE_ENV: NodeEnv,
  LOG_LEVEL: LogLevel,
  /** Serves /healthz and the authenticated MCP endpoint POST /mcp. */
  PORT: Port.default(8082),
  /** Connection as aoc_service (docs/deployment.md). */
  DATABASE_URL: PostgresUrl,
  /** The worker's Ed25519 public key as a JWK. Verification only: this service cannot mint tokens. */
  CAPABILITY_PUBLIC_JWK: z.string().min(20),
  /** Search provider key. Without it web_search reports PROVIDER_UNAVAILABLE. */
  TAVILY_API_KEY: z.string().min(10).optional(),
  /** Extra comma-separated domains the fetcher refuses, on top of the built-in denylist. */
  FETCH_DENYLIST: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
});
export type McpEnv = z.infer<typeof McpEnv>;

export function loadEnv(source?: Readonly<Record<string, string | undefined>>): McpEnv {
  return parseEnv('mcp-server', McpEnv, source);
}

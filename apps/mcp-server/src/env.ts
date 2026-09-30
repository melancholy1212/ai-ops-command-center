import { LogLevel, NodeEnv, parseEnv, Port } from '@aoc/config/env';
import { z } from 'zod';

const McpEnv = z.object({
  NODE_ENV: NodeEnv,
  LOG_LEVEL: LogLevel,
  HEALTH_PORT: Port.default(8082),
});
export type McpEnv = z.infer<typeof McpEnv>;

export function loadEnv(source?: Readonly<Record<string, string | undefined>>): McpEnv {
  return parseEnv('mcp-server', McpEnv, source);
}

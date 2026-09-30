/**
 * HTTP entry point. Phase 1 serves /healthz only. The Streamable HTTP MCP endpoint (/mcp) is added in
 * Phase 3 with authentication; an unauthenticated MCP endpoint is never exposed, even without tools.
 */
import { createServer } from 'node:http';
import { createLogger } from '@aoc/config/logger';
import { loadEnv } from './env';
import { SERVER_INFO } from './server';

const env = loadEnv();
const log = createLogger('mcp-server', env.LOG_LEVEL);
const startedAt = Date.now();

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(
      JSON.stringify({
        status: 'ok',
        service: 'mcp-server',
        server: SERVER_INFO,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        tools: 0,
      }),
    );
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});
server.listen(env.HEALTH_PORT, () => {
  log.info({ healthPort: env.HEALTH_PORT }, 'mcp-server started (no tools until Phase 3)');
});

function shutdown(signal: string): void {
  log.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});

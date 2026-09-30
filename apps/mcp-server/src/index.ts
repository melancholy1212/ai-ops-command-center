/**
 * MCP server process: /healthz plus the authenticated Streamable HTTP endpoint POST /mcp. Provider keys live
 * here and nowhere else; model credentials never do.
 */
import { createServer } from 'node:http';
import { createLogger } from '@aoc/config/logger';
import { createDb } from '@aoc/db';
import { createTokenVerifier } from './auth';
import { loadEnv } from './env';
import { createHttpHandler } from './http';
import { createServices } from './services';

const env = loadEnv();
const log = createLogger('mcp-server', env.LOG_LEVEL);
const db = createDb(env.DATABASE_URL, { applicationName: 'mcp-server', maxConnections: 10 });
const services = createServices({ db, log, tavilyApiKey: env.TAVILY_API_KEY, denylist: env.FETCH_DENYLIST });
if (!services.search) log.warn('TAVILY_API_KEY is not set: web_search will report PROVIDER_UNAVAILABLE');
const handler = createHttpHandler({ verify: await createTokenVerifier(env.CAPABILITY_PUBLIC_JWK), services, log });

const server = createServer((req, res) => {
  handler(req, res).catch((error: unknown) => {
    log.error({ err: error }, 'unhandled request error');
    if (!res.headersSent) res.writeHead(500).end();
  });
});
server.listen(env.PORT, () => {
  log.info({ port: env.PORT }, 'mcp-server listening');
});

function shutdown(signal: string): void {
  log.info({ signal }, 'shutting down');
  server.close(() => {
    void db.destroy().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});

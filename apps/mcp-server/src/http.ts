/**
 * HTTP surface: GET /healthz, and POST /mcp (Streamable HTTP, stateless, JSON responses). Every /mcp request
 * must carry a valid capability token; the token, not the request body, decides the workspace, run and tools.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@aoc/config/logger';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { AuthError, type TokenVerifier } from './auth';
import { createMcpServer, SERVER_INFO } from './server';
import type { ToolServices } from './tools/context';

const MAX_BODY_BYTES = 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RangeError('body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export function createHttpHandler(options: {
  verify: TokenVerifier;
  services: ToolServices;
  log: Logger;
  startedAt?: number;
}) {
  const startedAt = options.startedAt ?? Date.now();
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/healthz') {
      json(res, 200, {
        status: 'ok',
        service: 'mcp-server',
        server: SERVER_INFO,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        searchConfigured: options.services.search !== null,
      });
      return;
    }
    if (path !== '/mcp') {
      json(res, 404, { error: 'not_found' });
      return;
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      return;
    }
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    let scope;
    try {
      if (!token) throw new AuthError('missing capability token');
      scope = await options.verify(token);
    } catch (error) {
      const message = error instanceof AuthError ? error.message : 'authentication failed';
      json(res, 401, { error: 'unauthenticated', message }, { 'www-authenticate': 'Bearer realm="aoc-mcp"' });
      return;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (error) {
      json(res, error instanceof RangeError ? 413 : 400, { error: 'invalid_body' });
      return;
    }

    const server = createMcpServer({ scope, services: options.services });
    // Stateless: no session id generator. JSON responses: every call is one request, one response.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      // The SDK's transport class declares optional members that exactOptionalPropertyTypes reads strictly.
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      options.log.error({ err: error, executionId: scope.executionId }, 'MCP request failed');
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    }
  };
}

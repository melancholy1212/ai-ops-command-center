/**
 * stdio entry point for local MCP clients (MCP Inspector, Claude Code). stdout carries the protocol, so logs
 * go to stderr. It advertises no tools until workspace API keys exist (docs/mcp.md#standalone-use): nothing
 * is served without authorisation.
 */
import { createLogger } from '@aoc/config/logger';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server';

const log = createLogger('mcp-server', process.env.LOG_LEVEL ?? 'info', process.stderr);
const server = createMcpServer();
await server.connect(new StdioServerTransport());
log.info('mcp-server listening on stdio');

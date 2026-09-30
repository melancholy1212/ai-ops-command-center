/**
 * stdio entry point for local MCP clients (MCP Inspector, Claude Code). stdout carries the protocol,
 * so logs go to stderr.
 */
import { createLogger } from '@aoc/config/logger';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadEnv } from './env';
import { createMcpServer } from './server';

const env = loadEnv();
const log = createLogger('mcp-server', env.LOG_LEVEL, process.stderr);
const server = createMcpServer();
await server.connect(new StdioServerTransport());
log.info('mcp-server listening on stdio');

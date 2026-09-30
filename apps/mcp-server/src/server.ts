import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const SERVER_INFO = { name: 'aoc-mcp', version: '0.1.0' } as const;

/**
 * The MCP server. Phase 1 registers no tools: the six capability tools (docs/mcp.md) arrive in
 * Phase 3 together with capability-token and API-key authentication, so nothing is ever served
 * without authorisation.
 */
export function createMcpServer(): McpServer {
  return new McpServer(SERVER_INFO, {
    instructions:
      'AI Operations Command Center research tools. Tools are not available yet; see docs/mcp.md for the planned contract.',
  });
}

import { TOOL_CONTRACTS } from '@aoc/contracts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { isToolName, runTool, TOOL_DESCRIPTIONS, TOOL_HANDLERS } from './pipeline';
import type { ToolScope, ToolServices } from './tools/context';

export const SERVER_INFO = { name: 'aoc-mcp', version: '0.2.0' } as const;

/** The key under `_meta` where the worker passes the model's own id for the call, to join audit and conversation. */
export const MODEL_TOOL_CALL_ID_META = 'aoc/modelToolCallId';

function jsonSchema(schema: z.ZodType, io: 'input' | 'output') {
  const json = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as { type: 'object'; [key: string]: unknown };
  delete json.$schema;
  return json;
}

/**
 * One MCP server per authenticated request (stateless HTTP) or per stdio session. Without a scope no tools are
 * advertised: nothing is ever served without authorisation. With one, only the tools in the capability token
 * that this server implements are listed and callable.
 */
export function createMcpServer(context?: { scope: ToolScope; services: ToolServices }): McpServer {
  if (!context) {
    return new McpServer(SERVER_INFO, {
      capabilities: {},
      instructions: 'AI Operations Command Center research tools. Authenticate with a capability token to use them.',
    });
  }
  const { scope, services } = context;
  const available = scope.tools.filter((t) => TOOL_HANDLERS[t] !== undefined);
  // Our own list/call handlers on the underlying server: validation, audit and error shapes are the pipeline's.
  const mcp = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions:
      'Research tools with provenance: fetch_page only accepts URLs that came from a search result or a fetched page, and every fetched page is saved as a citable source.',
  });

  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: available.map((name) => ({
      name,
      description: TOOL_DESCRIPTIONS[name],
      inputSchema: jsonSchema(TOOL_CONTRACTS[name].input, 'input'),
      outputSchema: jsonSchema(TOOL_CONTRACTS[name].output, 'output'),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: TOOL_CONTRACTS[name].openWorld,
      },
    })),
  }));

  mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    if (!isToolName(name) || !available.includes(name)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    const metaId = request.params._meta?.[MODEL_TOOL_CALL_ID_META];
    const result = await runTool(
      services,
      scope,
      name,
      request.params.arguments ?? {},
      typeof metaId === 'string' ? metaId : null,
      extra.signal,
    );
    if (result.ok) {
      return {
        content: [{ type: 'text' as const, text: result.text }],
        structuredContent: result.output as Record<string, unknown>,
      };
    }
    // The ToolError travels as JSON text: MCP clients validate structuredContent against the tool's output
    // schema even on errors, so it cannot carry a different shape.
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result.error) }] };
  });

  return mcp;
}

/**
 * The agent's side of the MCP boundary. The loop sees tool specs and typed outcomes; tool errors come back
 * as data the model can read and adapt to, never as exceptions (docs/mcp.md#errors).
 */
import { ToolError, type ToolErrorCode } from '@aoc/contracts';
import type { ToolSpec } from '@aoc/llm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

/** Must match the MCP server's key (apps/mcp-server/src/server.ts). */
export const MODEL_TOOL_CALL_ID_META = 'aoc/modelToolCallId';

export type ToolOutcome =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; error: { code: ToolErrorCode; message: string; retryable: boolean; retryAfterMs: number | null } };

export interface ToolClient {
  readonly tools: readonly ToolSpec[];
  call(name: string, args: unknown, modelToolCallId: string, signal: AbortSignal): Promise<ToolOutcome>;
  close(): Promise<void>;
}

export async function connectMcp(url: string, token: string): Promise<ToolClient> {
  const client = new Client({ name: 'aoc-worker', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  // The SDK's transport declares optional members that exactOptionalPropertyTypes reads strictly.
  await client.connect(transport as unknown as Transport);
  const { tools } = await client.listTools();
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      inputSchema: t.inputSchema,
    })),
    async call(name, args, modelToolCallId, signal) {
      try {
        const result = await client.callTool(
          { name, arguments: args as Record<string, unknown>, _meta: { [MODEL_TOOL_CALL_ID_META]: modelToolCallId } },
          undefined,
          { signal, timeout: 60_000 },
        );
        if (result.isError) {
          const content = result.content as { type: string; text?: string }[];
          const parsed = ToolError.safeParse(JSON.parse(content[0]?.text ?? '{}'));
          return parsed.success
            ? { ok: false, error: parsed.data }
            : {
                ok: false,
                error: { code: 'INTERNAL', message: 'The tool failed.', retryable: false, retryAfterMs: null },
              };
        }
        return { ok: true, output: (result.structuredContent ?? {}) as Record<string, unknown> };
      } catch (error) {
        // A protocol error (e.g. an unknown tool) is the model's to see; transport failures fail the attempt.
        if (error instanceof McpError) {
          return {
            ok: false,
            error: {
              code: 'TOOL_NOT_PERMITTED',
              message: error.message.slice(0, 300),
              retryable: false,
              retryAfterMs: null,
            },
          };
        }
        throw error;
      }
    },
    close: () => client.close(),
  };
}

/**
 * The request pipeline every tool call goes through (docs/mcp.md#request-pipeline): authorise against the
 * capability token, validate input, rate limit, execute under the tool's timeout, validate output, audit,
 * respond. The network phase holds no database transaction; writes, the audit row and the run's spend are
 * committed together, so a call is either fully recorded or recorded as the error it was.
 */
import { randomUUID } from 'node:crypto';
import { TOOL_CONTRACTS, ToolName, type ToolError, type ToolErrorCode } from '@aoc/contracts';
import { recordSpendInTx } from '@aoc/core';
import { toJson, withWorkspace, withBackend, type WorkspaceTransaction } from '@aoc/db';
import { sql } from 'kysely';
import { sha256Hex } from './egress/url';
import { ProviderError } from './search/types';
import { ToolFailure, type Prepared, type ToolHandler, type ToolScope, type ToolServices } from './tools/context';
import { fetchPage } from './tools/fetch-page';
import { getSource } from './tools/get-source';
import { webSearch } from './tools/web-search';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each handler is typed by its own contract
export const TOOL_HANDLERS: Partial<Record<ToolName, ToolHandler<any, any>>> = {
  web_search: webSearch,
  fetch_page: fetchPage,
  get_source: getSource,
};

export const DEFAULT_RATE_LIMITS: Record<ToolName, number> = {
  web_search: 30,
  fetch_page: 60,
  lookup_company: 30,
  find_company_people: 30,
  search_knowledge: 120,
  get_source: 120,
};

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  web_search:
    'Search the web or news. Every result URL becomes fetchable with fetch_page. Use recencyDays for recent events.',
  fetch_page:
    'Fetch a URL that came from a search result or a fetched page, and read its text (paged by offset). The page is saved as a source whose sourceId you cite as evidence.',
  lookup_company: 'Resolve a company to registry-backed records.',
  find_company_people: 'Officers and executives of a company from authoritative registries.',
  search_knowledge: "Search this workspace's known companies, people and claims.",
  get_source: 'Re-read a saved source by sourceId, paged by offset. Never re-fetches the live page.',
};

export type ToolCallResult =
  { ok: true; toolCallId: string; output: unknown; text: string } | { ok: false; toolCallId: string; error: ToolError };

const SYSTEM = { kind: 'system' } as const;
const MAX_STORED_ARGUMENT_CHARS = 20_000;

function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`)
    .join('; ')
    .slice(0, 480);
}

function toToolFailure(error: unknown, signal: AbortSignal): ToolFailure {
  if (error instanceof ToolFailure) return error;
  if (error instanceof ProviderError)
    return new ToolFailure(error.code, error.message, error.retryable, error.retryAfterMs);
  if (signal.aborted) return new ToolFailure('TIMEOUT', 'The tool took too long.', true);
  return new ToolFailure('INTERNAL', 'The tool failed unexpectedly.', true);
}

interface AuditFields {
  toolCallId: string;
  tool: ToolName;
  modelToolCallId: string | null;
  args: unknown;
  started: Date;
  latencyMs: number;
  prepared: Omit<Prepared<unknown>, 'data'> | null;
  errorCode: ToolErrorCode | null;
  createdSourceIds: string[];
}

async function audit(tx: WorkspaceTransaction, scope: ToolScope, fields: AuditFields) {
  const serialised = JSON.stringify(fields.args ?? null);
  await tx
    .insertInto('tool_calls')
    .values({
      id: fields.toolCallId,
      workspace_id: scope.workspaceId,
      run_id: scope.runId,
      task_id: scope.taskId,
      execution_id: scope.executionId,
      tool: fields.tool,
      model_tool_call_id: fields.modelToolCallId?.slice(0, 200) ?? null,
      arguments_hash: sha256Hex(serialised),
      arguments:
        serialised.length > MAX_STORED_ARGUMENT_CHARS ? toJson({ truncated: true }) : toJson(fields.args ?? null),
      status: fields.errorCode ? 'error' : 'ok',
      error_code: fields.errorCode,
      provider: fields.prepared?.provider ?? null,
      cache_hit: fields.prepared?.cacheHit ?? false,
      latency_ms: fields.latencyMs,
      upstream_latency_ms: fields.prepared?.upstreamLatencyMs ?? null,
      cost_usd_micros: fields.prepared?.costUsdMicros ?? 0,
      created_source_ids: fields.createdSourceIds.slice(0, 20),
      started_at: fields.started,
    })
    .execute();
  await recordSpendInTx(tx, scope.runId, { toolCalls: 1, costUsdMicros: fields.prepared?.costUsdMicros ?? 0 }, SYSTEM);
}

export async function runTool(
  services: ToolServices,
  scope: ToolScope,
  tool: ToolName,
  args: unknown,
  modelToolCallId: string | null,
  requestSignal: AbortSignal,
): Promise<ToolCallResult> {
  const toolCallId = randomUUID();
  const started = services.now();
  const clock = performance.now();
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(TOOL_CONTRACTS[tool].timeoutMs)]);
  const handler = TOOL_HANDLERS[tool];
  let prepared: Prepared<unknown> | null = null;
  let storedArgs: unknown = args;

  try {
    if (!scope.tools.includes(tool) || !handler) {
      throw new ToolFailure('TOOL_NOT_PERMITTED', `The tool ${tool} is not available to this agent.`);
    }
    const used = await withWorkspace(services.db, scope.workspaceId, (tx) =>
      tx
        .selectFrom('tool_calls')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('execution_id', '=', scope.executionId)
        .executeTakeFirstOrThrow(),
    );
    if (Number(used.n) >= scope.maxToolCalls) {
      throw new ToolFailure(
        'BUDGET_EXCEEDED',
        `This execution has used all ${String(scope.maxToolCalls)} of its tool calls.`,
      );
    }
    const parsed = TOOL_CONTRACTS[tool].input.safeParse(args);
    if (!parsed.success) throw new ToolFailure('INVALID_ARGUMENT', describeIssues(parsed.error.issues));
    storedArgs = parsed.data;

    const limit = services.rateLimits[tool] ?? DEFAULT_RATE_LIMITS[tool];
    const waitMs = await withBackend(services.db, async (tx) => {
      const result = await sql<{ wait: number }>`
        select private.take_rate_limit(${`ws:${scope.workspaceId}:tool:${tool}`}, ${limit}, 60) as wait
      `.execute(tx);
      return result.rows[0]?.wait ?? 0;
    });
    if (waitMs > 0) throw new ToolFailure('RATE_LIMITED', 'Too many calls to this tool; wait and retry.', true, waitMs);

    prepared = await handler.prepare(parsed.data, scope, services, signal);
    const current = prepared;
    const result = await withWorkspace(services.db, scope.workspaceId, async (tx) => {
      const { output, createdSourceIds } = await handler.persist(tx, current.data, { scope, toolCallId, now: started });
      const checked = TOOL_CONTRACTS[tool].output.safeParse(output);
      if (!checked.success) {
        services.log.error(
          { tool, toolCallId, issues: checked.error.issues.slice(0, 5) },
          'tool output failed its schema',
        );
        throw new ToolFailure('INTERNAL', 'The tool produced an invalid result.', true);
      }
      await audit(tx, scope, {
        toolCallId,
        tool,
        modelToolCallId,
        args: storedArgs,
        started,
        latencyMs: Math.round(performance.now() - clock),
        prepared: current,
        errorCode: null,
        createdSourceIds,
      });
      return checked.data;
    });
    return { ok: true, toolCallId, output: result, text: handler.render(result as never) };
  } catch (error) {
    const failure = toToolFailure(error, signal);
    if (failure.code === 'INTERNAL') services.log.error({ err: error, tool, toolCallId }, 'tool call failed');
    try {
      await withWorkspace(services.db, scope.workspaceId, (tx) =>
        audit(tx, scope, {
          toolCallId,
          tool,
          modelToolCallId,
          args: storedArgs,
          started,
          latencyMs: Math.round(performance.now() - clock),
          prepared,
          errorCode: failure.code,
          createdSourceIds: [],
        }),
      );
    } catch (auditError) {
      services.log.error({ err: auditError, tool, toolCallId }, 'could not audit a failed tool call');
    }
    return {
      ok: false,
      toolCallId,
      error: {
        code: failure.code,
        message: failure.message.slice(0, 500),
        retryable: failure.retryable,
        retryAfterMs: failure.retryAfterMs,
        toolCallId: toolCallId as ToolError['toolCallId'],
      },
    };
  }
}

export function isToolName(name: string): name is ToolName {
  return ToolName.safeParse(name).success;
}

import type { Logger } from '@aoc/config/logger';
import type {
  AgentType,
  ExecutionId,
  RunId,
  TaskId,
  ToolErrorCode,
  ToolName,
  UrlOrigin,
  WorkspaceId,
} from '@aoc/contracts';
import { toJson, type Database, type WorkspaceTransaction } from '@aoc/db';
import type { PageFetcher } from '../egress/fetcher';
import { urlHash } from '../egress/url';
import type { SearchProvider } from '../search/types';

/** Who is calling: taken from a verified capability token, never from the request body. */
export interface ToolScope {
  workspaceId: WorkspaceId;
  runId: RunId;
  taskId: TaskId;
  executionId: ExecutionId;
  agent: AgentType;
  tools: readonly ToolName[];
  maxToolCalls: number;
}

export interface ToolServices {
  db: Database;
  search: SearchProvider | null;
  fetcher: PageFetcher;
  now: () => Date;
  log: Logger;
  /** Calls per minute per workspace and tool. */
  rateLimits: Partial<Record<ToolName, number>>;
}

/** A tool failure the model may read: a typed code and a safe message, no internals. */
export class ToolFailure extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly retryable = false,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ToolFailure';
  }
}

/** The result of a tool's network phase, persisted and audited in one transaction by the pipeline. */
export interface Prepared<T> {
  data: T;
  provider: string | null;
  cacheHit: boolean;
  costUsdMicros: number;
  upstreamLatencyMs: number | null;
}

export interface ToolHandler<I, T> {
  /** Network and reads; no writes. Runs under the tool's timeout. */
  prepare(input: I, scope: ToolScope, services: ToolServices, signal: AbortSignal): Promise<Prepared<T>>;
  /** Writes inside the audit transaction; returns the tool output and the snapshots it created. */
  persist(
    tx: WorkspaceTransaction,
    data: T,
    context: { scope: ToolScope; toolCallId: string; now: Date },
  ): Promise<{ output: unknown; createdSourceIds: string[] }>;
  render(output: never): string;
}

/**
 * Records that a URL may be fetched in this run. The first origin wins: rediscovering a URL keeps the reason
 * it was first allowed. Returns the discovered URL's id either way.
 */
export async function recordDiscoveredUrl(
  tx: WorkspaceTransaction,
  scope: ToolScope,
  url: string,
  normalizedUrl: string,
  origin: UrlOrigin,
): Promise<string> {
  const hash = urlHash(normalizedUrl);
  const inserted = await tx
    .insertInto('discovered_urls')
    .values({
      workspace_id: scope.workspaceId,
      run_id: scope.runId,
      url: url.slice(0, 2048),
      normalized_url: normalizedUrl,
      normalized_url_hash: hash,
      origin_kind: origin.kind,
      origin: toJson(origin),
    })
    .onConflict((oc) => oc.columns(['run_id', 'normalized_url_hash']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) return inserted.id;
  const existing = await tx
    .selectFrom('discovered_urls')
    .select('id')
    .where('run_id', '=', scope.runId)
    .where('normalized_url_hash', '=', hash)
    .executeTakeFirstOrThrow();
  return existing.id;
}

export function textWindow(text: string, offset: number, maxChars: number) {
  const window = text.slice(offset, offset + maxChars);
  return { text: window, offset, totalChars: text.length, hasMore: offset + window.length < text.length };
}

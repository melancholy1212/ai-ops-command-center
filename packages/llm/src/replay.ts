/**
 * Recording and replay of model calls for evals (docs/evaluation.md). A request is normalised (telemetry ids
 * removed) and hashed; the response is stored under that hash. In replay a request without a recording is a
 * hard failure, so a changed prompt must be re-recorded deliberately, never answered with stale data.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LlmProviderKind } from '@aoc/contracts';
import { LlmCallError, type LlmProvider, type LlmRequest, type LlmResponse } from './types';

/** Deterministic JSON: object keys sorted, so equal requests always hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Replaces every UUID with a placeholder numbered by first appearance. Ids minted during a run (sources,
 * discovered URLs, tool calls) differ on every replay; their positions in the conversation do not.
 */
export function normaliseIds(text: string): { text: string; ids: string[] } {
  const ids: string[] = [];
  const normalised = text.replace(UUID, (id) => {
    const lower = id.toLowerCase();
    let index = ids.indexOf(lower);
    if (index < 0) index = ids.push(lower) - 1;
    return `<id:${String(index)}>`;
  });
  return { text: normalised, ids };
}

function normalisedRequest(request: LlmRequest): { text: string; ids: string[] } {
  const { telemetry, ...rest } = request;
  return normaliseIds(stableStringify({ ...rest, promptVersion: telemetry.promptVersion, route: telemetry.route }));
}

/** The request hash recorded on every llm_calls row and used as the recording key. */
export function requestHash(request: LlmRequest): string {
  return createHash('sha256').update(normalisedRequest(request).text).digest('hex');
}

/** Rewrites a response's ids that appeared in the request into placeholders (for storage) or back. */
function toPlaceholders(value: unknown, ids: readonly string[]): unknown {
  const text = JSON.stringify(value).replace(UUID, (id) => {
    const index = ids.indexOf(id.toLowerCase());
    return index < 0 ? id : `<id:${String(index)}>`;
  });
  return JSON.parse(text) as unknown;
}

function fromPlaceholders(value: unknown, ids: readonly string[]): unknown {
  const text = JSON.stringify(value).replace(
    /<id:(\d+)>/g,
    (placeholder, index: string) => ids[Number(index)] ?? placeholder,
  );
  return JSON.parse(text) as unknown;
}

export interface Recording {
  hash: string;
  recordedAt: string;
  providerAccount: string;
  model: string;
  response: Omit<LlmResponse, 'latencyMs' | 'retryCount'>;
}

export interface RecordingFile {
  version: 1;
  /** Marks recordings made against synthetic tool fixtures rather than real sources. */
  synthetic: boolean;
  recordings: Recording[];
}

export async function loadRecordings(path: string): Promise<RecordingFile> {
  return JSON.parse(await readFile(path, 'utf8')) as RecordingFile;
}

export async function saveRecordings(path: string, file: RecordingFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const sorted = { ...file, recordings: [...file.recordings].sort((a, b) => a.hash.localeCompare(b.hash)) };
  await writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`);
}

/** Serves recorded responses; any unrecorded request fails with `fixture_miss`. */
export function createReplayProvider(file: RecordingFile, account: string, kind: LlmProviderKind): LlmProvider {
  const byHash = new Map(file.recordings.map((r) => [r.hash, r]));
  return {
    kind,
    account,
    generate(request: LlmRequest): Promise<LlmResponse> {
      const { text, ids } = normalisedRequest(request);
      const hash = createHash('sha256').update(text).digest('hex');
      const recording = byHash.get(hash);
      if (!recording) {
        return Promise.reject(
          new LlmCallError('fixture_miss', `No recorded model response for request ${hash} (${request.binding.model})`),
        );
      }
      const response = fromPlaceholders(recording.response, ids) as Recording['response'];
      return Promise.resolve({ ...response, latencyMs: 0, retryCount: 0 });
    },
  };
}

/** Wraps a live provider and collects every response under its request hash. */
export function createRecordingProvider(inner: LlmProvider, sink: Recording[], now = () => new Date()): LlmProvider {
  return {
    kind: inner.kind,
    account: inner.account,
    async generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      const response = await inner.generate(request, signal);
      const stored: Recording['response'] = {
        text: response.text,
        toolCalls: response.toolCalls,
        stopReason: response.stopReason,
        usage: response.usage,
        cacheStatus: response.cacheStatus,
        providerContent: response.providerContent,
      };
      const { ids } = normalisedRequest(request);
      sink.push({
        hash: requestHash(request),
        recordedAt: now().toISOString(),
        providerAccount: inner.account,
        model: request.binding.model,
        response: toPlaceholders(stored, ids) as Recording['response'],
      });
      return response;
    },
  };
}

import { LlmCallError } from './types';

/** In-call retries (docs/state-machines.md#retries): honour retry-after up to 60 s, else 1 s, 4 s, 10 s. */
export const IN_CALL_BACKOFF_MS = [1_000, 4_000, 10_000] as const;
const MAX_RETRY_AFTER_MS = 60_000;

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new LlmCallError('aborted', 'The call was aborted.'));
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(new LlmCallError('aborted', 'The call was aborted.'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Runs `attempt`, retrying availability failures (rate limits, provider errors). Returns the value and how
 * many retries it took; a final failure carries the retry count too, so telemetry stays exact.
 */
export async function withInCallRetries<T>(
  attempt: () => Promise<T>,
  classify: (error: unknown) => LlmCallError,
  signal: AbortSignal,
  wait: Sleep = sleep,
): Promise<{ value: T; retryCount: number }> {
  for (let retries = 0; ; retries += 1) {
    try {
      return { value: await attempt(), retryCount: retries };
    } catch (error) {
      const failure = classify(error);
      if (!failure.availability || retries >= IN_CALL_BACKOFF_MS.length || signal.aborted) {
        throw new LlmCallError(failure.kind, failure.message, failure.retryAfterMs, retries);
      }
      const delay =
        failure.retryAfterMs !== null
          ? Math.min(failure.retryAfterMs, MAX_RETRY_AFTER_MS)
          : (IN_CALL_BACKOFF_MS[retries] ?? 10_000);
      await wait(delay, signal);
    }
  }
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Maps an HTTP status to a failure kind; shared by both adapters. */
export function kindForStatus(status: number | undefined): LlmCallError['kind'] {
  if (status === undefined) return 'unavailable';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 409 || status >= 500) return 'unavailable';
  return 'invalid_request';
}

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  jitterMs: number;
}

/** Production retry timing (docs/state-machines.md): 30 s doubling per attempt, capped at 10 minutes. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = { baseMs: 30_000, maxMs: 600_000, jitterMs: 10_000 };

/** Delay before the next attempt, after `attempt` attempts have failed. Jitter spreads retries apart. */
export function retryDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const delay = Math.min(policy.baseMs * 2 ** exponent, policy.maxMs);
  return delay + Math.floor(random() * policy.jitterMs);
}

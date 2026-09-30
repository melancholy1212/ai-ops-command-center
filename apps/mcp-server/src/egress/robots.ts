/**
 * robots.txt per RFC 9309: fetched through the same egress policy, cached per origin for 24 h.
 * 2xx: rules apply. 4xx (including 404): everything is allowed. 5xx, timeouts and network errors:
 * the site is treated as fully disallowed (cached for 10 minutes, then retried).
 */
import robotsParser from 'robots-parser';
import {
  createSafeFetcher,
  FetchError,
  ROBOTS_TOKEN,
  type PageFetcher,
  type RobotsPolicy,
  type SafeFetcherOptions,
} from './fetcher';

const DAY_MS = 24 * 60 * 60 * 1000;
const UNREACHABLE_TTL_MS = 10 * 60 * 1000;

type Rules = { kind: 'allow_all' } | { kind: 'disallow_all' } | { kind: 'rules'; isAllowed: (url: string) => boolean };

export function createRobotsCache(
  options: Omit<SafeFetcherOptions, 'robots' | 'contentTypes' | 'limits'> & {
    fetcher?: PageFetcher;
    now?: () => number;
  } = {},
): RobotsPolicy {
  const fetcher =
    options.fetcher ??
    createSafeFetcher({
      ...options,
      contentTypes: ['*'],
      limits: { maxWireBytes: 512 * 1024, maxDecodedBytes: 512 * 1024 },
    });
  const now = options.now ?? Date.now;
  const cache = new Map<string, { rules: Rules; expires: number }>();

  async function load(origin: string, signal: AbortSignal): Promise<Rules> {
    const robotsUrl = `${origin}/robots.txt`;
    try {
      const page = await fetcher.fetch(robotsUrl, signal);
      const robots = robotsParser(robotsUrl, page.body.toString('utf8'));
      return { kind: 'rules', isAllowed: (url) => robots.isAllowed(url, ROBOTS_TOKEN) !== false };
    } catch (error) {
      if (error instanceof FetchError && error.code === 'NOT_FOUND') return { kind: 'allow_all' };
      if (error instanceof FetchError && error.code === 'UPSTREAM_ERROR' && !error.retryable)
        return { kind: 'allow_all' };
      return { kind: 'disallow_all' };
    }
  }

  return {
    async isAllowed(url: URL, signal: AbortSignal): Promise<boolean> {
      const origin = url.origin;
      let entry = cache.get(origin);
      if (!entry || entry.expires <= now()) {
        const rules = await load(origin, signal);
        entry = { rules, expires: now() + (rules.kind === 'disallow_all' ? UNREACHABLE_TTL_MS : DAY_MS) };
        cache.set(origin, entry);
      }
      const { rules } = entry;
      if (rules.kind === 'allow_all') return true;
      if (rules.kind === 'disallow_all') return false;
      return rules.isAllowed(url.href);
    },
  };
}

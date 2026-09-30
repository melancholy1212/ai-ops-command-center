import type { Logger } from '@aoc/config/logger';
import { withBackend, type Database } from '@aoc/db';
import { sql } from 'kysely';
import { createSafeFetcher, type PageFetcher } from './egress/fetcher';
import { createRobotsCache } from './egress/robots';
import { createTavilyProvider } from './search/tavily';
import type { SearchProvider } from './search/types';
import type { ToolServices } from './tools/context';

/** 1 request per second per host, shared by every server instance through Postgres. Waits rather than fails. */
export function createHostThrottle(db: Database) {
  return async (host: string, signal: AbortSignal): Promise<void> => {
    for (;;) {
      const wait = await withBackend(db, async (tx) => {
        const result = await sql<{
          wait: number;
        }>`select private.take_rate_limit(${`host:${host}`}, 1, 1) as wait`.execute(tx);
        return result.rows[0]?.wait ?? 0;
      });
      if (wait === 0) return;
      if (signal.aborted) throw signal.reason;
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 1000)));
    }
  };
}

export function createServices(options: {
  db: Database;
  log: Logger;
  tavilyApiKey?: string | undefined;
  denylist?: readonly string[];
  search?: SearchProvider | null;
  fetcher?: PageFetcher;
  now?: () => Date;
}): ToolServices {
  const throttle = createHostThrottle(options.db);
  const denylist = options.denylist ?? [];
  const fetcher =
    options.fetcher ?? createSafeFetcher({ denylist, throttle, robots: createRobotsCache({ denylist, throttle }) });
  const search =
    options.search !== undefined
      ? options.search
      : options.tavilyApiKey
        ? createTavilyProvider({ apiKey: options.tavilyApiKey })
        : null;
  return { db: options.db, log: options.log, search, fetcher, now: options.now ?? (() => new Date()), rateLimits: {} };
}

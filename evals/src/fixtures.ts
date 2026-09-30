/**
 * Tool edges for evals, at the MCP server's provider layer, so the real pipeline (provenance, egress policy,
 * extraction, snapshots, audit) runs on every case. The replayed fetcher still applies the URL policy: a
 * fixture cannot smuggle a private address past it.
 */
import {
  checkUrl,
  FetchError,
  normalizeUrl,
  type FetchedPage,
  type PageFetcher,
  type SearchProvider,
} from '@aoc/mcp-server/eval';
import type { ToolFixtures } from './case';

/** Cost charged per replayed search: the live list price, so cost metrics mean the same in every mode. */
const SEARCH_COST_USD_MICROS = 8_000;

export function fixtureSearch(fixtures: ToolFixtures): SearchProvider {
  return {
    name: 'fixture',
    search: (query) =>
      Promise.resolve({
        provider: 'fixture',
        hits: fixtures.search.slice(0, query.maxResults),
        costUsdMicros: SEARCH_COST_USD_MICROS,
        upstreamLatencyMs: 0,
      }),
  };
}

export function fixtureFetcher(fixtures: ToolFixtures): PageFetcher {
  const pages = new Map(Object.entries(fixtures.pages).map(([url, page]) => [normalizeUrl(url) ?? url, page]));
  return {
    fetch(url: string): Promise<FetchedPage> {
      const verdict = checkUrl(url);
      if (!verdict.ok)
        return Promise.reject(new FetchError('URL_BLOCKED', `Blocked by the egress policy: ${verdict.reason}.`));
      const page = pages.get(normalizeUrl(url) ?? url);
      if (!page) return Promise.reject(new FetchError('NOT_FOUND', 'The page returned HTTP 404.'));
      if (page.status >= 400)
        return Promise.reject(
          new FetchError(
            page.status === 404 ? 'NOT_FOUND' : 'UPSTREAM_ERROR',
            `The page returned HTTP ${String(page.status)}.`,
          ),
        );
      const body = Buffer.from(page.body);
      return Promise.resolve({
        requestedUrl: url,
        finalUrl: url,
        redirectChain: [],
        status: page.status,
        contentType: page.contentType,
        contentLength: body.length,
        etag: null,
        lastModified: null,
        resolvedIp: '192.0.2.1',
        body,
      });
    },
  };
}

/** Wraps live edges and keeps what they returned, to save as a new fixture (live mode with --record). */
export function recordingEdges(search: SearchProvider | null, fetcher: PageFetcher) {
  const recorded: ToolFixtures = { synthetic: false, search: [], pages: {} };
  const seen = new Set<string>();
  return {
    recorded,
    search: search && {
      name: search.name,
      async search(query: Parameters<SearchProvider['search']>[0], signal: AbortSignal) {
        const response = await search.search(query, signal);
        for (const hit of response.hits) {
          if (!seen.has(hit.url)) recorded.search.push(hit);
          seen.add(hit.url);
        }
        return response;
      },
    },
    fetcher: {
      async fetch(url: string, signal: AbortSignal) {
        const page = await fetcher.fetch(url, signal);
        recorded.pages[url] = { status: page.status, contentType: page.contentType, body: page.body.toString('utf8') };
        return page;
      },
    } satisfies PageFetcher,
  };
}

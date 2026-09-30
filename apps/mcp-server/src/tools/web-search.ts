import { type WebSearchInput, type WebSearchOutput, type ToolCallId } from '@aoc/contracts';
import type { z } from 'zod';
import { normalizeUrl } from '../egress/url';
import type { SearchResponse } from '../search/types';
import { recordDiscoveredUrl, ToolFailure, type ToolHandler } from './context';

type Input = z.infer<typeof WebSearchInput>;
type Output = z.infer<typeof WebSearchOutput>;

/** Search the web; every result URL becomes fetchable in this run, with the search as its origin. */
export const webSearch: ToolHandler<Input, { input: Input; response: SearchResponse }> = {
  async prepare(input, _scope, services, signal) {
    if (!services.search) {
      throw new ToolFailure('PROVIDER_UNAVAILABLE', 'No search provider is configured on this server.');
    }
    const response = await services.search.search(
      {
        query: input.query,
        mode: input.mode,
        maxResults: input.maxResults,
        ...(input.recencyDays !== undefined ? { recencyDays: input.recencyDays } : {}),
        ...(input.includeDomains ? { includeDomains: input.includeDomains } : {}),
        ...(input.excludeDomains ? { excludeDomains: input.excludeDomains } : {}),
      },
      signal,
    );
    return {
      data: { input, response },
      provider: response.provider,
      cacheHit: false,
      costUsdMicros: response.costUsdMicros,
      upstreamLatencyMs: response.upstreamLatencyMs,
    };
  },

  async persist(tx, { input, response }, { scope, toolCallId, now }) {
    const results: Output['results'] = [];
    for (const [rank, hit] of response.hits.entries()) {
      const normalized = normalizeUrl(hit.url);
      if (!normalized) continue;
      const discoveredUrlId = await recordDiscoveredUrl(tx, scope, hit.url, normalized, {
        kind: 'search_result',
        toolCallId: toolCallId as ToolCallId,
        provider: response.provider,
        query: input.query,
        rank,
      });
      results.push({
        url: normalized,
        title: hit.title,
        snippet: hit.snippet,
        publishedAt: hit.publishedAt,
        rank,
        discoveredUrlId: discoveredUrlId as Output['results'][number]['discoveredUrlId'],
      });
    }
    const output: Output = {
      results,
      provenance: {
        toolCallId: toolCallId as ToolCallId,
        provider: response.provider,
        retrievedAt: now.toISOString(),
        cached: false,
      },
    };
    return { output, createdSourceIds: [] };
  },

  render(output: Output) {
    if (output.results.length === 0) return 'No results.';
    return output.results
      .map(
        (r) =>
          `${String(r.rank + 1)}. ${r.title}\n   ${r.url}${r.publishedAt ? ` (${r.publishedAt.slice(0, 10)})` : ''}\n   ${r.snippet}`,
      )
      .join('\n');
  },
};

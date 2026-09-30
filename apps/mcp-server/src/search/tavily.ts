/**
 * Tavily search (https://docs.tavily.com/documentation/api-reference/endpoint/search, checked 2026-09-30).
 * Basic depth costs 1 credit; pay-as-you-go is $0.008 per credit, which is what the budget is charged even
 * while free-plan credits last, so budgets stay conservative.
 */
import { ProviderError, type SearchProvider, type SearchQuery, type SearchResponse } from './types';

export const TAVILY_CREDIT_USD_MICROS = 8_000;

interface TavilyResult {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  published_date?: unknown;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function createTavilyProvider(options: {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}): SearchProvider {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  return {
    name: 'tavily',
    async search(query: SearchQuery, signal: AbortSignal): Promise<SearchResponse> {
      const startDate =
        query.recencyDays === undefined
          ? undefined
          : new Date(now().getTime() - query.recencyDays * 86_400_000).toISOString().slice(0, 10);
      const started = performance.now();
      let response: Response;
      try {
        response = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          signal,
          headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            query: query.query,
            topic: query.mode,
            search_depth: 'basic',
            max_results: query.maxResults,
            include_published_date: true,
            include_usage: true,
            ...(startDate ? { start_date: startDate } : {}),
            ...(query.includeDomains?.length ? { include_domains: query.includeDomains } : {}),
            ...(query.excludeDomains?.length ? { exclude_domains: query.excludeDomains } : {}),
          }),
        });
      } catch (error) {
        if (signal.aborted) throw new ProviderError('TIMEOUT', 'The search provider did not respond in time.', true);
        throw new ProviderError(
          'PROVIDER_UNAVAILABLE',
          `The search provider could not be reached (${String(error)}).`,
          true,
        );
      }
      const upstreamLatencyMs = Math.round(performance.now() - started);
      if (!response.ok) {
        const status = response.status;
        await response.body?.cancel();
        if (status === 429) {
          const after = Number(response.headers.get('retry-after'));
          throw new ProviderError(
            'RATE_LIMITED',
            'The search provider is rate limiting us.',
            true,
            Number.isFinite(after) ? after * 1000 : 10_000,
          );
        }
        if (status === 432 || status === 433)
          throw new ProviderError('QUOTA_EXCEEDED', 'The search plan limit is reached.', false);
        if (status === 401 || status === 403) {
          throw new ProviderError('PROVIDER_UNAVAILABLE', 'The search provider rejected our credentials.', false);
        }
        if (status >= 500)
          throw new ProviderError('PROVIDER_UNAVAILABLE', `The search provider failed (HTTP ${String(status)}).`, true);
        throw new ProviderError(
          'UPSTREAM_ERROR',
          `The search provider refused the query (HTTP ${String(status)}).`,
          false,
        );
      }
      const body = (await response.json()) as { results?: TavilyResult[]; usage?: { credits?: unknown } };
      const credits = typeof body.usage?.credits === 'number' ? body.usage.credits : 1;
      const hits = (body.results ?? [])
        .filter((r): r is TavilyResult & { url: string } => typeof r.url === 'string')
        .slice(0, query.maxResults)
        .map((r) => ({
          url: r.url,
          title: typeof r.title === 'string' ? r.title.slice(0, 500) : '',
          snippet: typeof r.content === 'string' ? r.content.slice(0, 1000) : '',
          publishedAt: isoDate(r.published_date),
        }));
      return { provider: 'tavily', hits, costUsdMicros: credits * TAVILY_CREDIT_USD_MICROS, upstreamLatencyMs };
    },
  };
}

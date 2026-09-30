import { describe, expect, it } from 'vitest';
import { createTavilyProvider, TAVILY_CREDIT_USD_MICROS } from './search/tavily';
import { ProviderError } from './search/types';

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }),
    );
  };
  return { fetch, requests };
}

const now = () => new Date('2026-09-30T12:00:00Z');
const query = { query: 'climate software seed round Sweden', mode: 'news' as const, maxResults: 3, recencyDays: 30 };

describe('Tavily provider', () => {
  it('sends the documented request and maps results, dates and credits', async () => {
    const { fetch, requests } = fakeFetch(200, {
      results: [
        {
          url: 'https://news.example/a',
          title: 'Northwind raises',
          content: 'Seed round',
          published_date: 'Thu, 12 Mar 2026 08:00:00 GMT',
        },
        { title: 'no url' },
      ],
      usage: { credits: 1 },
    });
    const response = await createTavilyProvider({ apiKey: 'tvly-test', fetch, now }).search(
      query,
      AbortSignal.timeout(5000),
    );
    const sent = requests[0];
    expect(sent?.url).toBe('https://api.tavily.com/search');
    expect((sent?.init.headers as Record<string, string>).authorization).toBe('Bearer tvly-test');
    expect(JSON.parse(sent?.init.body as string)).toEqual({
      query: query.query,
      topic: 'news',
      search_depth: 'basic',
      max_results: 3,
      include_published_date: true,
      include_usage: true,
      start_date: '2026-08-31',
    });
    expect(response).toMatchObject({
      provider: 'tavily',
      costUsdMicros: TAVILY_CREDIT_USD_MICROS,
      hits: [
        {
          url: 'https://news.example/a',
          title: 'Northwind raises',
          snippet: 'Seed round',
          publishedAt: '2026-03-12T08:00:00.000Z',
        },
      ],
    });
  });

  it.each([
    [429, { 'retry-after': '7' }, 'RATE_LIMITED', true],
    [432, {}, 'QUOTA_EXCEEDED', false],
    [401, {}, 'PROVIDER_UNAVAILABLE', false],
    [502, {}, 'PROVIDER_UNAVAILABLE', true],
    [400, {}, 'UPSTREAM_ERROR', false],
  ])('maps HTTP %i to %s', async (status, headers, code, retryable) => {
    const { fetch } = fakeFetch(status, { detail: 'x' }, headers);
    const error = await createTavilyProvider({ apiKey: 'tvly-test', fetch, now })
      .search(query, AbortSignal.timeout(5000))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code, retryable });
    if (status === 429) expect((error as ProviderError).retryAfterMs).toBe(7000);
  });
});

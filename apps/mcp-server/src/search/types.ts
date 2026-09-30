export interface SearchQuery {
  query: string;
  mode: 'general' | 'news';
  recencyDays?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  maxResults: number;
}

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  publishedAt: string | null;
}

export interface SearchResponse {
  provider: string;
  hits: SearchHit[];
  costUsdMicros: number;
  upstreamLatencyMs: number;
}

/** Behind this interface so the provider can change without touching agents (docs/mcp.md). */
export interface SearchProvider {
  readonly name: string;
  search(query: SearchQuery, signal: AbortSignal): Promise<SearchResponse>;
}

export class ProviderError extends Error {
  constructor(
    readonly code: 'PROVIDER_UNAVAILABLE' | 'RATE_LIMITED' | 'QUOTA_EXCEEDED' | 'UPSTREAM_ERROR' | 'TIMEOUT',
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

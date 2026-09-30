/**
 * Provenance: where a URL came from, what was retrieved, and the exact quote a claim rests on.
 * Chain: DiscoveredUrl (authorises a fetch) -> SourceSnapshot (what we saved) -> Evidence (quote + span).
 */
import { z } from 'zod';
import {
  ClaimId,
  Count,
  DiscoveredUrlId,
  EvidenceId,
  ExecutionId,
  HttpUrl,
  LlmCallId,
  McpSessionId,
  RunId,
  Sha256Hex,
  SourceId,
  Timestamp,
  ToolCallId,
  UserId,
  WorkspaceId,
} from './common';

/** How a URL became fetchable. A model can never introduce a URL on its own. */
export const UrlOrigin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user_provided'), providedBy: UserId }),
  z.object({
    kind: z.literal('search_result'),
    toolCallId: ToolCallId,
    provider: z.string().min(1).max(60),
    query: z.string().max(400),
    rank: Count,
  }),
  z.object({ kind: z.literal('page_link'), fromSourceId: SourceId, anchorText: z.string().max(300).nullable() }),
  z.object({
    kind: z.literal('provider_record'),
    toolCallId: ToolCallId,
    provider: z.string().min(1).max(60),
    field: z.string().min(1).max(60),
  }),
]);
export type UrlOrigin = z.infer<typeof UrlOrigin>;

/** A run (app workflow) or an MCP session (external client). URLs are authorised per scope. */
export const ProvenanceScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run'), runId: RunId }),
  z.object({ kind: z.literal('mcp_session'), sessionId: McpSessionId }),
]);
export type ProvenanceScope = z.infer<typeof ProvenanceScope>;

export const DiscoveredUrl = z.object({
  id: DiscoveredUrlId,
  workspaceId: WorkspaceId,
  scope: ProvenanceScope,
  url: HttpUrl,
  normalizedUrl: HttpUrl,
  normalizedUrlHash: Sha256Hex,
  origin: UrlOrigin,
  discoveredAt: Timestamp,
});
export type DiscoveredUrl = z.infer<typeof DiscoveredUrl>;

export const SourceType = z.enum([
  'company_website',
  'press_release',
  'news_article',
  'registry_record',
  'knowledge_base',
  'blog',
  'other',
]);
export type SourceType = z.infer<typeof SourceType>;

/** A = authoritative for what it states (registry, the company itself), B = reputable press, C = other web, D = user-generated. */
export const SourceTier = z.enum(['A', 'B', 'C', 'D']);
export type SourceTier = z.infer<typeof SourceTier>;

export const SourceFlag = z.enum([
  'suspected_prompt_injection',
  'paywall_suspected',
  'thin_content',
  'machine_translated',
]);
export type SourceFlag = z.infer<typeof SourceFlag>;

export const ExtractionMethod = z.enum(['readability_html', 'plain_text', 'provider_api']);
export const PublishedAtMethod = z.enum(['html_meta', 'json_ld', 'time_element', 'url_path', 'provider_field', 'none']);

export const HttpMetadata = z.object({
  status: z.int().min(100).max(599),
  contentType: z.string().max(200),
  contentLength: Count.nullable(),
  etag: z.string().max(200).nullable(),
  lastModified: z.string().max(100).nullable(),
  /** Every hop was re-validated against the egress policy before it was followed. */
  redirectChain: z.array(HttpUrl).max(5),
  resolvedIp: z.union([z.ipv4(), z.ipv6()]),
});

/** What we saved. Quotes are only ever checked against `text`, never against a live page. */
export const SourceSnapshot = z
  .object({
    id: SourceId,
    workspaceId: WorkspaceId,
    requestedUrl: HttpUrl,
    finalUrl: HttpUrl,
    /** From the page's rel=canonical. Used for display and dedupe only, never for authorisation. */
    canonicalUrl: HttpUrl.nullable(),
    host: z.string().min(1).max(253),
    registrableDomain: z.string().min(1).max(253),
    publisher: z.string().max(200).nullable(),
    sourceType: SourceType,
    tier: SourceTier,
    origin: UrlOrigin,
    discoveredUrlId: DiscoveredUrlId.nullable(),
    retrievedAt: Timestamp,
    http: HttpMetadata.nullable(),
    publishedAt: Timestamp.nullable(),
    publishedAtMethod: PublishedAtMethod,
    rawSha256: Sha256Hex,
    contentSha256: Sha256Hex,
    text: z.string().max(400_000),
    textLength: Count,
    truncated: z.boolean(),
    extraction: z.object({
      method: ExtractionMethod,
      extractorVersion: z.string().min(1).max(40),
      title: z.string().max(500).nullable(),
      language: z.string().max(10).nullable(),
    }),
    flags: z.array(SourceFlag).max(4),
    fetchedByToolCallId: ToolCallId,
  })
  .superRefine((s, ctx) => {
    const fetchedPage = s.extraction.method !== 'provider_api';
    if (fetchedPage !== (s.http !== null)) {
      ctx.addIssue({ code: 'custom', path: ['http'], message: 'HTTP metadata is present exactly for fetched pages' });
    }
    // A fetched page references the discovered URL that authorised it. Snapshots outlive runs, so the
    // reference is null once that run is deleted; `origin` keeps the reason.
    if (!fetchedPage && s.discoveredUrlId !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['discoveredUrlId'],
        message: 'provider records are not authorised by a discovered URL',
      });
    }
    if (!fetchedPage && s.origin.kind !== 'provider_record') {
      ctx.addIssue({ code: 'custom', path: ['origin'], message: 'provider API records have a provider_record origin' });
    }
  });
export type SourceSnapshot = z.infer<typeof SourceSnapshot>;

/** exact: byte match. normalized: match after Unicode/whitespace/quote normalisation. elided_segments: "a ... b" with every segment found in order. */
export const GroundingResult = z.enum(['exact', 'normalized', 'elided_segments', 'not_found']);
export type GroundingResult = z.infer<typeof GroundingResult>;

export const TextSpan = z.object({ start: Count, end: z.int().positive() }).refine((s) => s.end > s.start, {
  error: 'end must be greater than start',
});

export const JudgeVerdict = z.enum(['supports', 'partially_supports', 'does_not_support', 'contradicts']);
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

export const Evidence = z
  .object({
    id: EvidenceId,
    workspaceId: WorkspaceId,
    claimId: ClaimId,
    sourceId: SourceId,
    /** As the agent cited it. The grounding check locates it in the snapshot and records the spans. */
    quote: z.string().min(20).max(1200),
    quoteSha256: Sha256Hex,
    grounding: GroundingResult,
    spans: z.array(TextSpan).max(5),
    /** Whether the claimed value (amount, date, round...) appears in the quote. Null when it has no detectable surface form. */
    valueInQuote: z.boolean().nullable(),
    stance: z.enum(['supports', 'contradicts']),
    judge: z.object({ verdict: JudgeVerdict, reason: z.string().min(1).max(500), llmCallId: LlmCallId }).nullable(),
    sourcePublishedAt: Timestamp.nullable(),
    sourceRetrievedAt: Timestamp,
    extractedByExecutionId: ExecutionId,
    createdAt: Timestamp,
  })
  .superRefine((e, ctx) => {
    if ((e.grounding === 'not_found') !== (e.spans.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['spans'],
        message: 'spans are empty exactly when the quote was not found',
      });
    }
    if (e.grounding === 'not_found' && e.judge !== null) {
      ctx.addIssue({ code: 'custom', path: ['judge'], message: 'ungrounded quotes never reach the judge' });
    }
  });
export type Evidence = z.infer<typeof Evidence>;

import { type FetchPageInput, type FetchPageOutput, UrlOrigin, type SourceFlag, type ToolCallId } from '@aoc/contracts';
import { toJson, withWorkspace, type DB } from '@aoc/db';
import type { Selectable } from 'kysely';
import type { z } from 'zod';
import { classifySource, registrableDomain, sourceFlags } from '../classify';
import { FetchError, type FetchedPage } from '../egress/fetcher';
import { normalizeUrl, sha256Hex, urlHash } from '../egress/url';
import { EXTRACTOR_VERSION, extractPage, type ExtractedPage } from '../extract';
import { recordDiscoveredUrl, textWindow, ToolFailure, type ToolHandler } from './context';

type Input = z.infer<typeof FetchPageInput>;
type Output = z.infer<typeof FetchPageOutput>;
type SourceRow = Selectable<DB['sources']>;

/** A snapshot this run saved recently is served again instead of re-fetching (paging through a long page). */
const REUSE_WITHIN_MS = 24 * 60 * 60 * 1000;

type Data =
  | { kind: 'cached'; input: Input; source: SourceRow; links: { url: string; text: string; id: string }[] }
  | {
      kind: 'fetched';
      input: Input;
      discovered: { id: string; origin: unknown };
      page: FetchedPage;
      extracted: ExtractedPage;
      flags: SourceFlag[];
    };

function toFailure(error: unknown): never {
  if (error instanceof FetchError) throw new ToolFailure(error.code, error.message, error.retryable);
  throw error;
}

export const fetchPage: ToolHandler<Input, Data> = {
  async prepare(input, scope, services, signal) {
    const normalized = normalizeUrl(input.url);
    if (!normalized) throw new ToolFailure('INVALID_ARGUMENT', 'Only http and https URLs can be fetched.');
    const hash = urlHash(normalized);

    // Provenance rule: the URL must have an origin in this run (docs/provenance.md#fetch-authorisation).
    const known = await withWorkspace(services.db, scope.workspaceId, async (tx) => {
      const discovered = await tx
        .selectFrom('discovered_urls')
        .select(['id', 'origin'])
        .where('run_id', '=', scope.runId)
        .where('normalized_url_hash', '=', hash)
        .executeTakeFirst();
      if (!discovered) return null;
      const source = await tx
        .selectFrom('sources')
        .selectAll()
        .where('discovered_url_id', '=', discovered.id)
        .where('retrieved_at', '>', new Date(services.now().getTime() - REUSE_WITHIN_MS))
        .orderBy('retrieved_at', 'desc')
        .executeTakeFirst();
      if (!source) return { discovered, cached: null };
      const links = await tx
        .selectFrom('discovered_urls')
        .select(['id', 'normalized_url as url', 'origin'])
        .where('run_id', '=', scope.runId)
        .where('origin_kind', '=', 'page_link')
        .where((eb) => eb(eb.fn('jsonb_extract_path_text', [eb.ref('origin'), eb.val('fromSourceId')]), '=', source.id))
        .orderBy('discovered_at')
        .limit(100)
        .execute();
      return { discovered, cached: { source, links } };
    });
    if (!known) {
      throw new ToolFailure(
        'URL_NOT_PERMITTED',
        'This URL has no origin in this run: only URLs from search results, fetched pages or provider records can be fetched.',
      );
    }
    if (known.cached) {
      const links = known.cached.links.map((l) => {
        const origin = UrlOrigin.safeParse(l.origin);
        const text = origin.success && origin.data.kind === 'page_link' ? (origin.data.anchorText ?? '') : '';
        return { id: l.id, url: l.url, text };
      });
      return {
        data: { kind: 'cached', input, source: known.cached.source, links },
        provider: null,
        cacheHit: true,
        costUsdMicros: 0,
        upstreamLatencyMs: null,
      };
    }

    const started = performance.now();
    const page = await services.fetcher.fetch(normalized, signal).catch(toFailure);
    const upstreamLatencyMs = Math.round(performance.now() - started);
    const extracted = extractPage(page.body, page.contentType, page.finalUrl, services.now());
    const flags = sourceFlags(extracted.text, extracted.hadInvisibleCharacters);
    return {
      data: { kind: 'fetched', input, discovered: known.discovered, page, extracted, flags },
      provider: null,
      cacheHit: false,
      costUsdMicros: 0,
      upstreamLatencyMs,
    };
  },

  async persist(tx, data, { scope, toolCallId, now }) {
    const { offset, maxChars } = data.input;
    const provenance = {
      toolCallId: toolCallId as ToolCallId,
      provider: null,
      retrievedAt: now.toISOString(),
      cached: data.kind === 'cached',
    };

    if (data.kind === 'cached') {
      const s = data.source;
      const output: Output = {
        sourceId: s.id as Output['sourceId'],
        finalUrl: s.final_url,
        canonicalUrl: s.canonical_url,
        title: s.title,
        publishedAt: s.published_at?.toISOString() ?? null,
        retrievedAt: s.retrieved_at.toISOString(),
        contentSha256: s.content_sha256,
        tier: s.tier as Output['tier'],
        flags: s.flags as Output['flags'],
        ...textWindow(s.text, offset, maxChars),
        links: data.links.map((l) => ({
          url: l.url,
          text: l.text,
          discoveredUrlId: l.id as Output['links'][number]['discoveredUrlId'],
        })),
        provenance,
      };
      return { output, createdSourceIds: [] };
    }

    const { page, extracted, flags, discovered } = data;
    const finalHost = new URL(page.finalUrl).hostname;
    const { sourceType, tier } = classifySource(finalHost);
    const contentSha256 = sha256Hex(extracted.text);
    const finalUrlHash = urlHash(normalizeUrl(page.finalUrl) ?? page.finalUrl);
    const inserted = await tx
      .insertInto('sources')
      .values({
        workspace_id: scope.workspaceId,
        requested_url: page.requestedUrl,
        final_url: page.finalUrl,
        final_url_hash: finalUrlHash,
        canonical_url: extracted.canonicalUrl,
        host: finalHost,
        registrable_domain: registrableDomain(finalHost),
        publisher: extracted.publisher,
        source_type: sourceType,
        tier,
        origin: toJson(discovered.origin),
        discovered_url_id: discovered.id,
        retrieved_at: now,
        http: toJson({
          status: page.status,
          contentType: page.contentType,
          contentLength: page.contentLength,
          etag: page.etag,
          lastModified: page.lastModified,
          redirectChain: page.redirectChain,
          resolvedIp: page.resolvedIp,
        }),
        published_at: extracted.publishedAt ? new Date(extracted.publishedAt) : null,
        published_at_method: extracted.publishedAtMethod,
        raw_sha256: sha256Hex(page.body),
        content_sha256: contentSha256,
        text: extracted.text,
        text_length: extracted.textLength,
        truncated: extracted.truncated,
        extraction_method: extracted.method,
        extractor_version: EXTRACTOR_VERSION,
        title: extracted.title,
        language: extracted.language,
        flags,
        fetched_by_tool_call_id: toolCallId,
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'final_url_hash', 'content_sha256']).doNothing())
      .returningAll()
      .executeTakeFirst();
    // Identical content at the same final URL is one snapshot: reuse the one already saved.
    const source =
      inserted ??
      (await tx
        .selectFrom('sources')
        .selectAll()
        .where('workspace_id', '=', scope.workspaceId)
        .where('final_url_hash', '=', finalUrlHash)
        .where('content_sha256', '=', contentSha256)
        .executeTakeFirstOrThrow());

    const links: Output['links'] = [];
    for (const link of extracted.links) {
      const normalized = normalizeUrl(link.url);
      if (!normalized) continue;
      const id = await recordDiscoveredUrl(tx, scope, link.url, normalized, {
        kind: 'page_link',
        fromSourceId: source.id as Output['sourceId'],
        anchorText: link.text || null,
      });
      links.push({
        url: normalized,
        text: link.text,
        discoveredUrlId: id as Output['links'][number]['discoveredUrlId'],
      });
    }

    const output: Output = {
      sourceId: source.id as Output['sourceId'],
      finalUrl: source.final_url,
      canonicalUrl: source.canonical_url,
      title: source.title,
      publishedAt: source.published_at?.toISOString() ?? null,
      retrievedAt: source.retrieved_at.toISOString(),
      contentSha256: source.content_sha256,
      tier: source.tier as Output['tier'],
      flags: source.flags as Output['flags'],
      ...textWindow(source.text, offset, maxChars),
      links,
      provenance,
    };
    return { output, createdSourceIds: [source.id] };
  },

  render(output: Output) {
    const header = [
      `Source ${output.sourceId}: ${output.title ?? output.finalUrl}`,
      `URL: ${output.finalUrl}`,
      output.publishedAt ? `Published: ${output.publishedAt.slice(0, 10)}` : null,
      output.flags.length > 0 ? `Flags: ${output.flags.join(', ')}` : null,
      `Characters ${String(output.offset)}-${String(output.offset + output.text.length)} of ${String(output.totalChars)}${output.hasMore ? ' (more available)' : ''}`,
    ].filter(Boolean);
    return `${header.join('\n')}\n\n${output.text}`;
  },
};

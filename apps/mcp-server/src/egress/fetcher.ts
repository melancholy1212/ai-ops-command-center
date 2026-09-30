/**
 * The only way the system reaches the web (docs/provenance.md#egress-policy-ssrf):
 *  - every hop is checked by `checkUrl` (scheme, port, credentials, address literals, denylist);
 *  - host names are resolved by our own lookup, every returned address must pass the IP blocklist, and the
 *    socket connects to that validated address (DNS pinning), so a rebinding answer cannot sneak in;
 *  - redirects are followed by hand, at most 5, each hop re-validated;
 *  - connect 5 s, first byte 10 s, total 20 s; 5 MB on the wire, 10 MB decompressed; html/xhtml/text only;
 *  - robots.txt is honoured and each host is throttled; environment proxies are never used.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Agent, request } from 'undici';
import { addressLiteral, isBlockedAddress } from './address';
import { checkUrl, type UrlPolicyOptions } from './policy';

export const USER_AGENT = 'AOC-ResearchBot/0.1 (+https://github.com/melancholy1212/ai-ops-command-center)';
export const ROBOTS_TOKEN = 'AOC-ResearchBot';
export const PAGE_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'] as const;

export interface FetchLimits {
  maxRedirects: number;
  connectTimeoutMs: number;
  headersTimeoutMs: number;
  totalTimeoutMs: number;
  maxWireBytes: number;
  maxDecodedBytes: number;
}

export const DEFAULT_LIMITS: FetchLimits = {
  maxRedirects: 5,
  connectTimeoutMs: 5_000,
  headersTimeoutMs: 10_000,
  totalTimeoutMs: 20_000,
  maxWireBytes: 5 * 1024 * 1024,
  maxDecodedBytes: 10 * 1024 * 1024,
};

export type FetchErrorCode =
  | 'URL_BLOCKED'
  | 'ROBOTS_DISALLOWED'
  | 'TIMEOUT'
  | 'CONTENT_TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'NOT_FOUND'
  | 'UPSTREAM_ERROR';

export class FetchError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  /** Every URL followed after the first, each validated before it was requested. */
  redirectChain: string[];
  status: number;
  contentType: string;
  contentLength: number | null;
  etag: string | null;
  lastModified: string | null;
  resolvedIp: string;
  body: Buffer;
}

/** What the fetch_page tool depends on; evals swap in a recorded implementation. */
export interface PageFetcher {
  fetch(url: string, signal: AbortSignal): Promise<FetchedPage>;
}

export interface RobotsPolicy {
  isAllowed(url: URL, signal: AbortSignal): Promise<boolean>;
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface SafeFetcherOptions extends UrlPolicyOptions {
  userAgent?: string;
  limits?: Partial<FetchLimits>;
  contentTypes?: readonly string[];
  robots?: RobotsPolicy;
  /** Waits until the host may be requested again (1 request/s per host, shared across instances). */
  throttle?: (host: string, signal: AbortSignal) => Promise<void>;
  resolve?: Resolver;
}

const defaultResolve: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export function createSafeFetcher(options: SafeFetcherOptions = {}): PageFetcher {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const contentTypes = options.contentTypes ?? PAGE_CONTENT_TYPES;
  const resolve = options.resolve ?? defaultResolve;
  const isBlocked = options.isBlocked ?? isBlockedAddress;

  return {
    async fetch(requestedUrl: string, outer: AbortSignal): Promise<FetchedPage> {
      const signal = AbortSignal.any([outer, AbortSignal.timeout(limits.totalTimeoutMs)]);
      const resolved = new Map<string, string>();
      const blocked = new Set<string>();
      // Our lookup: every address must be public; the socket then connects to the one we validated.
      const lookup = ((
        hostname: string,
        opts: { all?: boolean; family?: number },
        callback: (...args: unknown[]) => void,
      ) => {
        resolve(hostname)
          .then((all) => {
            const addresses =
              opts.family === 4 || opts.family === 6 ? all.filter((a) => a.family === opts.family) : all;
            if (all.length === 0 || addresses.length === 0)
              throw Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' });
            if (all.some((a) => isBlocked(a.address))) {
              blocked.add(hostname);
              throw Object.assign(new Error(`${hostname} resolves to a blocked address`), { code: 'EBLOCKED' });
            }
            const first = addresses[0] as { address: string; family: number };
            resolved.set(hostname, first.address);
            if (opts.all) callback(null, addresses);
            else callback(null, first.address, first.family);
          })
          .catch((error: unknown) => {
            callback(error);
          });
      }) as unknown as LookupFunction;
      const agent = new Agent({ connect: { lookup, timeout: limits.connectTimeoutMs }, connections: 2 });

      try {
        const redirectChain: string[] = [];
        let current = requestedUrl;
        for (let hop = 0; ; hop += 1) {
          const verdict = checkUrl(current, options);
          if (!verdict.ok) throw new FetchError('URL_BLOCKED', `Blocked by the egress policy: ${verdict.reason}.`);
          const url = verdict.url;
          if (options.robots && !(await options.robots.isAllowed(url, signal))) {
            throw new FetchError('ROBOTS_DISALLOWED', 'robots.txt disallows fetching this URL.');
          }
          await options.throttle?.(url.hostname, signal);

          let response;
          try {
            response = await request(url, {
              dispatcher: agent,
              method: 'GET',
              signal,
              headersTimeout: limits.headersTimeoutMs,
              bodyTimeout: limits.headersTimeoutMs,
              headers: {
                'user-agent': options.userAgent ?? USER_AGENT,
                accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
                'accept-encoding': 'gzip, deflate, br',
              },
            });
          } catch (error) {
            if (blocked.has(url.hostname)) {
              throw new FetchError('URL_BLOCKED', 'Blocked by the egress policy: address not publicly routable.');
            }
            throw toFetchError(error, signal);
          }

          const { statusCode, headers, body } = response;
          const header = (name: string) => {
            const value = headers[name];
            return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
          };
          if (statusCode >= 300 && statusCode < 400 && header('location')) {
            await body.dump();
            if (hop >= limits.maxRedirects) throw new FetchError('UPSTREAM_ERROR', 'Too many redirects.');
            current = new URL(header('location') ?? '', url).href;
            redirectChain.push(current);
            continue;
          }
          if (statusCode === 404 || statusCode === 410) {
            await body.dump();
            throw new FetchError('NOT_FOUND', `The page returned HTTP ${String(statusCode)}.`);
          }
          if (statusCode >= 400) {
            await body.dump();
            const retryable = statusCode === 429 || statusCode >= 500;
            throw new FetchError('UPSTREAM_ERROR', `The page returned HTTP ${String(statusCode)}.`, retryable);
          }
          const contentType = (header('content-type') ?? '').toLowerCase();
          const mediaType = contentType.split(';')[0]?.trim() ?? '';
          if (!contentTypes.includes(mediaType) && !contentTypes.includes('*')) {
            await body.dump();
            throw new FetchError(
              'UNSUPPORTED_CONTENT_TYPE',
              `Content type ${mediaType || 'unknown'} is not supported.`,
            );
          }
          const declared = Number(header('content-length'));
          if (Number.isFinite(declared) && declared > limits.maxWireBytes) {
            await body.dump();
            throw new FetchError('CONTENT_TOO_LARGE', 'The page is larger than the fetch limit.');
          }
          const decoded = await readLimited(body, (header('content-encoding') ?? '').toLowerCase(), limits, signal);
          return {
            requestedUrl,
            finalUrl: url.href,
            redirectChain,
            status: statusCode,
            contentType: mediaType,
            contentLength: Number.isFinite(declared) ? declared : null,
            etag: header('etag'),
            lastModified: header('last-modified'),
            resolvedIp: addressLiteral(url.hostname) ?? resolved.get(url.hostname) ?? '0.0.0.0',
            body: decoded,
          };
        }
      } finally {
        await agent.close().catch(() => undefined);
      }
    },
  };
}

async function readLimited(
  body: Readable,
  encoding: string,
  limits: FetchLimits,
  signal: AbortSignal,
): Promise<Buffer> {
  let wire = 0;
  let decodedBytes = 0;
  const chunks: Buffer[] = [];
  const countWire = async function* (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      wire += chunk.length;
      if (wire > limits.maxWireBytes)
        throw new FetchError('CONTENT_TOO_LARGE', 'The page is larger than the fetch limit.');
      yield chunk;
    }
  };
  const collect = async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) {
      decodedBytes += chunk.length;
      if (decodedBytes > limits.maxDecodedBytes) {
        throw new FetchError('CONTENT_TOO_LARGE', 'The page is larger than the fetch limit once decompressed.');
      }
      chunks.push(chunk);
    }
  };
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
          ? createBrotliDecompress()
          : null;
  try {
    if (decoder) await pipeline(body, countWire, decoder, collect, { signal });
    else await pipeline(body, countWire, collect, { signal });
  } catch (error) {
    throw toFetchError(error, signal);
  }
  return Buffer.concat(chunks);
}

function toFetchError(error: unknown, signal: AbortSignal): FetchError {
  if (error instanceof FetchError) return error;
  if (signal.aborted) return new FetchError('TIMEOUT', 'The fetch took too long.', true);
  const code = (error as { code?: string }).code ?? '';
  if (code.includes('TIMEOUT')) return new FetchError('TIMEOUT', 'The site did not respond in time.', true);
  if (code === 'ENOTFOUND') return new FetchError('NOT_FOUND', 'The host name does not resolve.');
  if (code.startsWith('Z_') || code.startsWith('ERR__') || code.includes('BROTLI')) {
    return new FetchError('UPSTREAM_ERROR', 'The page could not be decompressed.');
  }
  return new FetchError('UPSTREAM_ERROR', 'The site could not be reached.', true);
}

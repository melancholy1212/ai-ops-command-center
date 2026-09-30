/**
 * Page text and metadata extraction for snapshots (docs/provenance.md#snapshots). The saved text is what
 * quotes are later checked against, so it is deterministic for a given input and extractor version.
 */
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { SourceSnapshot } from '@aoc/contracts';

type PublishedAtMethod = SourceSnapshot['publishedAtMethod'];

export const EXTRACTOR_VERSION = 'extract@1';
export const MAX_TEXT_CHARS = 400_000;
const MAX_LINKS = 100;

/** Unicode tag characters, zero-width runs and bidi controls: invisible to readers, visible to models. */
const INVISIBLE = /[\u{E0000}-\u{E007F}\u200B-\u200D\u2060\uFEFF\u180E\u202A-\u202E\u2066-\u2069]/gu;

export interface ExtractedPage {
  title: string | null;
  text: string;
  textLength: number;
  truncated: boolean;
  method: 'readability_html' | 'plain_text';
  canonicalUrl: string | null;
  language: string | null;
  publisher: string | null;
  publishedAt: string | null;
  publishedAtMethod: PublishedAtMethod;
  links: { url: string; text: string }[];
  /** Invisible characters were present (and removed): an injection signal. */
  hadInvisibleCharacters: boolean;
}

export function decodeBody(body: Buffer, contentType: string): string {
  const declared = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim();
  const sniffed = /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 2048).toString('latin1'))?.[1];
  for (const label of [declared, sniffed, 'utf-8']) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(body);
    } catch {
      // Unknown label: try the next one.
    }
  }
  return body.toString('utf8');
}

const BLOCK = new Set([
  'P',
  'DIV',
  'LI',
  'UL',
  'OL',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BR',
  'TR',
  'TD',
  'TH',
  'SECTION',
  'ARTICLE',
  'BLOCKQUOTE',
  'PRE',
  'HEADER',
  'FOOTER',
  'FIGCAPTION',
  'TABLE',
  'DD',
  'DT',
  'HR',
]);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME']);

interface DomNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
}

/** Text with paragraph structure kept: block elements become line breaks, runs of spaces collapse. */
function blockText(root: DomNode): string {
  const parts: string[] = [];
  const walk = (node: DomNode) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    if (SKIP.has(node.nodeName)) return;
    const block = BLOCK.has(node.nodeName);
    if (block) parts.push('\n');
    for (const child of Array.from(node.childNodes)) walk(child);
    if (block) parts.push('\n');
  };
  walk(root);
  return tidy(parts.join(''));
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function finalise(raw: string): { text: string; truncated: boolean; hadInvisible: boolean } {
  const hadInvisible = INVISIBLE.test(raw);
  INVISIBLE.lastIndex = 0;
  const clean = raw.replace(INVISIBLE, '').normalize('NFC');
  const truncated = clean.length > MAX_TEXT_CHARS;
  return { text: truncated ? clean.slice(0, MAX_TEXT_CHARS) : clean, truncated, hadInvisible };
}

function absoluteUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function validDate(value: string | null | undefined, now: Date): string | null {
  if (!value) return null;
  const time = Date.parse(value.trim());
  if (Number.isNaN(time)) return null;
  if (time < Date.UTC(1990, 0, 1) || time > now.getTime() + 24 * 60 * 60 * 1000) return null;
  return new Date(time).toISOString();
}

function jsonLdObjects(document: Document): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const parsed = JSON.parse(script.textContent) as unknown;
      const queue: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      while (queue.length > 0) {
        const item = queue.shift();
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          out.push(record);
          if (Array.isArray(record['@graph'])) queue.push(...(record['@graph'] as unknown[]));
        }
      }
    } catch {
      // Malformed JSON-LD is common; ignore it.
    }
  }
  return out;
}

function publishedDate(
  document: Document,
  ld: Record<string, unknown>[],
  finalUrl: string,
  now: Date,
): { at: string | null; method: PublishedAtMethod } {
  for (const item of ld) {
    const at = validDate(typeof item.datePublished === 'string' ? item.datePublished : null, now);
    if (at) return { at, method: 'json_ld' };
  }
  for (const selector of [
    'meta[property="article:published_time"]',
    'meta[name="article:published_time"]',
    'meta[name="date"]',
    'meta[name="pubdate"]',
    'meta[name="publish-date"]',
    'meta[itemprop="datePublished"]',
  ]) {
    const at = validDate(document.querySelector(selector)?.getAttribute('content'), now);
    if (at) return { at, method: 'html_meta' };
  }
  const time = validDate(document.querySelector('time[datetime]')?.getAttribute('datetime'), now);
  if (time) return { at: time, method: 'time_element' };
  const path = /\/(20\d{2}|19\d{2})\/(0[1-9]|1[0-2])\/([0-2]\d|3[01])\//.exec(new URL(finalUrl).pathname);
  if (path) {
    const at = validDate(`${path[1] ?? ''}-${path[2] ?? ''}-${path[3] ?? ''}T00:00:00Z`, now);
    if (at) return { at, method: 'url_path' };
  }
  return { at: null, method: 'none' };
}

function links(document: Document, finalUrl: string): { url: string; text: string }[] {
  const seen = new Set<string>();
  const out: { url: string; text: string }[] = [];
  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
    if (out.length >= MAX_LINKS) break;
    let url: URL;
    try {
      url = new URL(anchor.getAttribute('href') ?? '', finalUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    if (url.href === finalUrl || seen.has(url.href)) continue;
    seen.add(url.href);
    out.push({
      url: url.href,
      text: tidy(anchor.textContent).replace(INVISIBLE, '').slice(0, 300),
    });
  }
  return out;
}

export function extractPage(body: Buffer, contentType: string, finalUrl: string, now = new Date()): ExtractedPage {
  const decoded = decodeBody(body, contentType);
  if (contentType === 'text/plain') {
    const { text, truncated, hadInvisible } = finalise(tidy(decoded));
    return {
      title: null,
      text,
      textLength: text.length,
      truncated,
      method: 'plain_text',
      canonicalUrl: null,
      language: null,
      publisher: null,
      publishedAt: null,
      publishedAtMethod: 'none',
      links: [],
      hadInvisibleCharacters: hadInvisible,
    };
  }

  const { document } = parseHTML(decoded);
  const ld = jsonLdObjects(document);
  const meta = (selector: string) => {
    const value = document.querySelector(selector)?.getAttribute('content')?.trim();
    if (!value) return null;
    return value;
  };
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
  const canonicalUrl = canonical ? absoluteUrl(canonical, finalUrl) : null;
  const published = publishedDate(document, ld, finalUrl, now);
  const pageLinks = links(document, finalUrl);
  const ldPublisher = ld
    .map((item) => item.publisher)
    .find((p): p is { name: string } => typeof (p as { name?: unknown } | undefined)?.name === 'string');

  // Readability mutates the document it reads, so it gets its own copy.
  const article = new Readability(parseHTML(decoded).document).parse();
  let raw = '';
  if (article?.content) raw = blockText(parseHTML(`<html><body>${article.content}</body></html>`).document);
  if (raw.length < 200) raw = blockText(document.body);
  const { text, truncated, hadInvisible } = finalise(raw);
  const title = (article?.title ?? document.querySelector('title')?.textContent ?? '').replace(INVISIBLE, '').trim();

  return {
    title: title ? title.slice(0, 500) : null,
    text,
    textLength: text.length,
    truncated,
    method: 'readability_html',
    canonicalUrl,
    language: (document.documentElement.getAttribute('lang') ?? '').slice(0, 10) || null,
    publisher: (meta('meta[property="og:site_name"]') ?? ldPublisher?.name ?? null)?.slice(0, 200) ?? null,
    publishedAt: published.at,
    publishedAtMethod: published.method,
    links: pageLinks,
    hadInvisibleCharacters: hadInvisible,
  };
}

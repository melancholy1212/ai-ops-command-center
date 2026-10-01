/**
 * Grounding (docs/provenance.md#verification, step 2): is the cited quote really in the saved snapshot?
 *   exact            found verbatim
 *   normalized       found after normalisation (dash, quote, whitespace, case, NFKC, invisible characters)
 *   elided_segments  the quote uses "..." and every segment (>= 20 characters) appears in order, each within
 *                    1,500 characters of the previous one
 *   not_found        none of the above: the claim is rejected with QUOTE_NOT_FOUND
 * Quotes of fewer than 4 words are rejected with QUOTE_TOO_SHORT: a bare name is a match, not evidence.
 * Spans are code point offsets into the snapshot text.
 */
import type { GroundingResult } from '@aoc/contracts';
import { codePointIndex, ELLIPSIS, indexOfNormalized, normalizeForMatch, words } from './text';

export const MIN_QUOTE_WORDS = 4;
export const MIN_SEGMENT_CHARS = 20;
export const MAX_SEGMENT_GAP = 1500;
const MAX_SEGMENTS = 5;

export interface Span {
  start: number;
  end: number;
}

export interface GroundingOutcome {
  result: GroundingResult;
  spans: Span[];
  /** Set when the quote is rejected before or during matching. */
  problem: 'QUOTE_TOO_SHORT' | 'QUOTE_NOT_FOUND' | null;
}

const WRAPPING_QUOTES = new Set([
  '"',
  "'",
  String.fromCodePoint(0x201c),
  String.fromCodePoint(0x201d),
  String.fromCodePoint(0x2018),
  String.fromCodePoint(0x2019),
]);

/** Removes quotation marks wrapping the whole quote. */
export function unwrapQuote(quote: string): string {
  let q = quote.trim();
  while (q.length > 2 && WRAPPING_QUOTES.has(q[0] ?? '') && WRAPPING_QUOTES.has(q.at(-1) ?? ''))
    q = q.slice(1, -1).trim();
  return q;
}

/** The parts of a quote between ellipses, normalised; one part for a quote without an ellipsis. */
function segmentsOf(quote: string): string[] {
  return quote
    .split(new RegExp(`\\.\\.\\.|${ELLIPSIS}`))
    .map((s) => normalizeForMatch(s).text.trim())
    .filter((s) => s.length > 0);
}

/**
 * What is wrong with a quote whatever the source says: too few words, or elided segments too short or too
 * many to ground. The agent loop checks this before accepting a result, so the model can fix the quote
 * instead of losing the claim at grounding. Null when the shape is fine.
 */
export function quoteShapeProblem(rawQuote: string): string | null {
  const quote = unwrapQuote(rawQuote);
  const count = words(quote).length;
  if (count < MIN_QUOTE_WORDS)
    return `has ${String(count)} word(s); quote at least ${String(MIN_QUOTE_WORDS)} words, a whole sentence where possible`;
  const segments = segmentsOf(quote);
  if (segments.length > MAX_SEGMENTS)
    return `has ${String(segments.length)} parts; join at most ${String(MAX_SEGMENTS)}`;
  if (segments.length > 1 && segments.some((s) => Array.from(s).length < MIN_SEGMENT_CHARS))
    return `has a part between "..." shorter than ${String(MIN_SEGMENT_CHARS)} characters; quote whole phrases`;
  return null;
}

export function groundQuote(sourceText: string, rawQuote: string): GroundingOutcome {
  const quote = unwrapQuote(rawQuote);
  if (words(quote).length < MIN_QUOTE_WORDS) return { result: 'not_found', spans: [], problem: 'QUOTE_TOO_SHORT' };

  const verbatim = sourceText.indexOf(quote);
  if (verbatim >= 0) {
    const start = codePointIndex(sourceText, verbatim);
    return { result: 'exact', spans: [{ start, end: start + Array.from(quote).length }], problem: null };
  }

  const source = normalizeForMatch(sourceText);
  const spanOf = (from: number, length: number): Span => ({
    start: source.map[from] ?? 0,
    end: (source.map[from + length - 1] ?? 0) + 1,
  });

  const segments = segmentsOf(quote);
  if (segments.length === 1) {
    const needle = segments[0] ?? '';
    const at = indexOfNormalized(source, needle);
    if (at >= 0) return { result: 'normalized', spans: [spanOf(at, Array.from(needle).length)], problem: null };
    return { result: 'not_found', spans: [], problem: 'QUOTE_NOT_FOUND' };
  }

  // Elided quote: every segment long enough to mean something, in order, close to the previous one.
  if (segments.length > MAX_SEGMENTS || segments.some((s) => Array.from(s).length < MIN_SEGMENT_CHARS)) {
    return { result: 'not_found', spans: [], problem: 'QUOTE_NOT_FOUND' };
  }
  const spans: Span[] = [];
  let cursor = 0;
  for (const [i, segment] of segments.entries()) {
    const at = indexOfNormalized(source, segment, cursor);
    if (at < 0 || (i > 0 && at - cursor > MAX_SEGMENT_GAP))
      return { result: 'not_found', spans: [], problem: 'QUOTE_NOT_FOUND' };
    const length = Array.from(segment).length;
    spans.push(spanOf(at, length));
    cursor = at + length;
  }
  return { result: 'elided_segments', spans, problem: null };
}

/** The sentence(s) around a span, for value checks and the judge's context window. */
export function contextAround(sourceText: string, span: Span, radius = 300): string {
  const chars = Array.from(sourceText);
  return chars.slice(Math.max(0, span.start - radius), Math.min(chars.length, span.end + radius)).join('');
}

/** The sentence containing the span: from the previous sentence end to the next one. */
export function sentenceAround(sourceText: string, span: Span): string {
  const chars = Array.from(sourceText);
  let start = span.start;
  while (start > 0 && !/[.!?\n]/.test(chars[start - 1] ?? '')) start -= 1;
  let end = span.end;
  while (end < chars.length && !/[.!?\n]/.test(chars[end] ?? '')) end += 1;
  return chars.slice(start, Math.min(chars.length, end + 1)).join('');
}

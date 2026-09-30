/**
 * Text normalisation for quote matching (docs/provenance.md#verification): NFKC, dash and hyphen variants to
 * "-", typographic quotes to ASCII, whitespace collapsed, invisible characters removed, case folded. Every
 * normalised character keeps the index of the original character it came from, so a match found in
 * normalised text maps back to an exact span of the saved snapshot. Indices are Unicode code points, the
 * unit Postgres uses for text length.
 */
const DASHES = new Set([0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe58, 0xfe63, 0xff0d]);
const SINGLE_QUOTES = new Set([0x2018, 0x2019, 0x201a, 0x201b, 0x2032, 0xff07]);
const DOUBLE_QUOTES = new Set([0x201c, 0x201d, 0x201e, 0x201f, 0x2033, 0xff02, 0x00ab, 0x00bb]);
export const ELLIPSIS = String.fromCodePoint(0x2026);

function invisible(cp: number): boolean {
  return (
    (cp >= 0xe0000 && cp <= 0xe007f) ||
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0x2060 ||
    cp === 0xfeff ||
    cp === 0x00ad
  );
}

export interface NormalizedText {
  text: string;
  /** Normalised characters (code points). */
  chars: string[];
  /** map[i]: index in the original text (code points) of the character normalised character i came from. */
  map: number[];
}

export function normalizeForMatch(original: string): NormalizedText {
  const chars: string[] = [];
  const map: number[] = [];
  let pendingSpace = false;
  let index = 0;
  for (const ch of original) {
    const cp = ch.codePointAt(0) ?? 0;
    const i = index;
    index += 1;
    if (invisible(cp)) continue;
    if (/\s/u.test(ch)) {
      if (chars.length > 0) pendingSpace = true;
      continue;
    }
    const replaced = DASHES.has(cp)
      ? '-'
      : SINGLE_QUOTES.has(cp)
        ? "'"
        : DOUBLE_QUOTES.has(cp)
          ? '"'
          : ch.normalize('NFKC').toLowerCase();
    if (pendingSpace) {
      chars.push(' ');
      map.push(i);
      pendingSpace = false;
    }
    for (const c of replaced) {
      if (/\s/u.test(c)) continue;
      chars.push(c);
      map.push(i);
    }
  }
  return { text: chars.join(''), chars, map };
}

/** Code point index of a UTF-16 index in a string. */
export function codePointIndex(text: string, utf16Index: number): number {
  let count = 0;
  for (let i = 0; i < utf16Index; i += 1) {
    const unit = text.charCodeAt(i);
    // A high surrogate starts a pair: the pair is one code point.
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < utf16Index) i += 1;
    count += 1;
  }
  return count;
}

/** Finds `needle` in normalised text from a code point position; returns the code point index or -1. */
export function indexOfNormalized(haystack: NormalizedText, needle: string, fromChar = 0): number {
  // Map the code point position to the UTF-16 position in the joined normalised text.
  let fromUnit = 0;
  for (let i = 0; i < fromChar && i < haystack.chars.length; i += 1) fromUnit += haystack.chars[i]?.length ?? 1;
  const unit = haystack.text.indexOf(needle, fromUnit);
  return unit < 0 ? -1 : codePointIndex(haystack.text, unit);
}

/** Words for shingling and length checks: lower-case alphanumeric runs. */
export function words(text: string): string[] {
  return normalizeForMatch(text)
    .text.split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Company identity and claim fingerprints (docs/provenance.md#verification, step 6; docs/domain-model.md). */
import type { ClaimAssertion } from '@aoc/contracts';
import { getDomain } from 'tldts';
import { canonicalJson, sha256Hex } from '../canonical-json';

const LEGAL_SUFFIXES = new Set([
  'ab',
  'as',
  'asa',
  'aps',
  'a/s',
  'oy',
  'oyj',
  'ehf',
  'hf',
  'ltd',
  'limited',
  'plc',
  'llc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'gmbh',
  'ag',
  'sa',
  'sas',
  'sarl',
  'bv',
  'nv',
  'srl',
  'spa',
  'oü',
  'ou',
  'uab',
  'sia',
  'group',
  'holding',
  'holdings',
]);

/** "Northwind Climate AB" and "northwind climate" resolve to the same normalised name. */
/**
 * A person's name for matching: case, accents, punctuation and spacing ignored ("Åsa  Lindqvist-Berg" and
 * "asa lindqvist berg" match). Matching on the name alone is never enough: people are resolved within a company.
 */
export function normalizePersonName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .slice(0, 120);
}

export function normalizeCompanyName(name: string): string {
  const tokens = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/ ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens.at(-1) ?? '')) tokens.pop();
  return tokens.join(' ').slice(0, 200) || name.toLowerCase().slice(0, 200);
}

/** The registrable domain of a URL or a bare host name ("www.northwind.example/about" -> "northwind.example"). */
export function registrableDomainOf(hostOrUrl: string | null | undefined): string | null {
  if (!hostOrUrl) return null;
  const trimmed = hostOrUrl.trim().toLowerCase();
  let host: string;
  try {
    host = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return null;
  }
  return getDomain(host) ?? null;
}

/** The value in canonical form: strings trimmed, string lists sorted and case-folded, so equal claims hash equally. */
export function canonicalValue(assertion: ClaimAssertion): unknown {
  const value = assertion.value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'string') out[key] = key === 'url' ? v.trim() : v.trim().toLowerCase();
    else if (Array.isArray(v)) {
      out[key] = (v as unknown[]).map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : x)).sort();
    } else out[key] = v;
  }
  return out;
}

/** sha256(subject, attribute, canonical value): the claim's idempotency key within a run. */
export function claimFingerprint(companyId: string, assertion: ClaimAssertion): string {
  return sha256Hex(
    canonicalJson({ subject: companyId, attribute: assertion.attribute, value: canonicalValue(assertion) }),
  );
}

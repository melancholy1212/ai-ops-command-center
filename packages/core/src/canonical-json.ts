import { createHash } from 'node:crypto';

/**
 * RFC 8785 (JSON Canonicalization Scheme) for the JSON values this system produces: object keys
 * sorted by UTF-16 code units, no insignificant whitespace, and numbers and strings serialised
 * exactly as ECMAScript's JSON.stringify does (which is what RFC 8785 specifies).
 * Used to hash approval snapshots, so the same content always yields the same hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite numbers have no JSON representation');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new TypeError(`Unsupported value of type ${typeof value}`);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The hash stored on an approval and quoted back by the person who decides it. */
export function snapshotHash(snapshot: unknown): string {
  return sha256Hex(canonicalJson(snapshot));
}

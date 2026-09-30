import { createHash } from 'node:crypto';

/** Shared with the rest of the system: one normalisation for recording and lookup. */
export { normalizeUrl } from '@aoc/contracts';

export function sha256Hex(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

export function urlHash(normalizedUrl: string): string {
  return sha256Hex(normalizedUrl);
}

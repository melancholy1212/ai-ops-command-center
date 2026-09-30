import { getDomain } from 'tldts';
import { addressLiteral, isBlockedAddress } from './address';

/** Login-walled networks: fetching them yields sign-in pages, not evidence. */
export const GLOBAL_DENYLIST = [
  'linkedin.com',
  'x.com',
  'twitter.com',
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'threads.net',
] as const;

export type PolicyVerdict = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Checks a URL before any connection: scheme and port allowlist, no embedded credentials, address literals
 * against the IP blocklist, and the domain denylist. Names are checked again at connect time, against every
 * address DNS returns (see fetcher.ts).
 */
export interface UrlPolicyOptions {
  denylist?: readonly string[];
  /** Defaults to 80 and 443. Only tests widen it, to reach their local server. */
  allowedPorts?: readonly string[];
  /** Defaults to the public-unicast-only blocklist. Only tests replace it. */
  isBlocked?: (address: string) => boolean;
}

export function checkUrl(input: string, options: UrlPolicyOptions = {}): PolicyVerdict {
  const extraDenylist = options.denylist ?? [];
  const allowedPorts = options.allowedPorts ?? ['80', '443'];
  const blockedAddress = options.isBlocked ?? isBlockedAddress;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'only http and https' };
  if (url.port !== '' && !allowedPorts.includes(url.port)) return { ok: false, reason: 'only ports 80 and 443' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials in the URL' };
  const literal = addressLiteral(url.hostname);
  if (literal !== null) {
    return blockedAddress(literal) ? { ok: false, reason: 'address not publicly routable' } : { ok: true, url };
  }
  if (!url.hostname.includes('.')) return { ok: false, reason: 'not a public host name' };
  const domain = getDomain(url.hostname) ?? url.hostname;
  const denied = [...GLOBAL_DENYLIST, ...extraDenylist].some(
    (d) => domain === d || url.hostname === d || url.hostname.endsWith(`.${d}`),
  );
  return denied ? { ok: false, reason: 'domain is on the denylist' } : { ok: true, url };
}

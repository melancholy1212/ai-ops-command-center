const TRACKING_PARAMS = new Set(['gclid', 'fbclid', 'mc_cid', 'mc_eid']);

/**
 * The one URL normalisation, used both to record a discovered URL and to look it up before a fetch
 * (docs/provenance.md#fetch-authorisation). WHATWG parsing (non-transitional UTS #46, so "ß" is not folded
 * to "ss") lowercases scheme and host and drops default ports; the fragment and tracking parameters are
 * dropped too, other query parameters kept in order. Returns null for anything but http(s).
 */
export function normalizeUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  const kept = [...url.searchParams.entries()].filter(
    ([key]) => !key.toLowerCase().startsWith('utm_') && !TRACKING_PARAMS.has(key.toLowerCase()),
  );
  url.search = kept.length > 0 ? `?${new URLSearchParams(kept).toString()}` : '';
  return url.href;
}

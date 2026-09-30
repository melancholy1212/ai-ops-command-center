import ipaddr from 'ipaddr.js';

/**
 * The IP blocklist of the egress policy (docs/provenance.md#egress-policy-ssrf). Only globally routable
 * unicast addresses pass: loopback, private, link-local (cloud metadata), CGNAT, multicast, reserved,
 * documentation and benchmarking ranges are all refused. IPv4-mapped and NAT64 IPv6 addresses are judged by
 * the IPv4 address they embed; other transition ranges (6to4, Teredo) are refused outright.
 */
export function isBlockedAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return true;
  const parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv4') return parsed.range() !== 'unicast';
  const v6 = parsed as ipaddr.IPv6;
  const range = v6.range();
  if (range === 'ipv4Mapped' || range === 'rfc6052') {
    const bytes = v6.toByteArray().slice(-4);
    return ipaddr.fromByteArray(bytes).range() !== 'unicast';
  }
  return range !== 'unicast';
}

/** Strips IPv6 brackets from a URL hostname; returns null when the host is a name, not an address literal. */
export function addressLiteral(hostname: string): string | null {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return ipaddr.isValid(bare) ? bare : null;
}

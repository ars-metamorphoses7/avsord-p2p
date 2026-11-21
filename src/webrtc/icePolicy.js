// Field calls between houses ran "host ↔ host": both peers have a Radmin VPN
// (26.0.0.0/8 and IPv6 fdfd::/16) or Hamachi (25.0.0.0/8, 2620:9b::/48)
// adapter, and ICE ranks host candidates above the direct internet (srflx)
// path, so the screen stream rode the VPN tunnel and topped out near 4-6 Mb/s
// with packet loss and freezes. Advertise and accept VPN host candidates below
// srflx (still above TURN relay): ICE keeps them as the automatic fallback
// when CGNAT/symmetric NAT blocks a direct path, but prefers direct internet.
const VPN_RANGES = [
  { name: 'radmin', test: (a) => a === 26 },
  { name: 'hamachi', test: (a) => a === 25 },
  { name: 'cgnat', test: (a, b) => a === 100 && b >= 64 && b <= 127 },
];
const IPV6_VPN_PATTERNS = [
  { name: 'radmin', test: /^fdfd:/i },
  { name: 'hamachi', test: /^2620:0{0,2}9b:/i },
  { name: 'tailscale', test: /^fd7a:115c:a1e0:/i },
];
const DEPRIORITIZED_VPNS = new Set(['radmin', 'hamachi', 'tailscale']);
const PRIVATE_RANGES = [
  (a) => a === 10,
  (a, b) => a === 172 && b >= 16 && b <= 31,
  (a, b) => a === 192 && b === 168,
  (a) => a === 127,
];
// ICE type preference just above TURN relay (0-2) and far below srflx (100).
const VPN_TYPE_PREFERENCE = 3;

/** 'radmin' | 'hamachi' | 'tailscale' | 'cgnat' | 'lan' | 'internet' | 'mdns' | '' */
export function classifyCandidateAddress(address) {
  const value = String(address || '').trim().replace(/^\[|\]$/g, '');
  if (!value) return '';
  if (/\.local$/i.test(value)) return 'mdns';
  const ipv4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(value);
  if (!ipv4) {
    const vpn6 = IPV6_VPN_PATTERNS.find((entry) => entry.test.test(value));
    if (vpn6) return vpn6.name;
    return /^(?:f[cd][0-9a-f]{0,2}:|fe[89ab][0-9a-f]:|::1$)/i.test(value) ? 'lan' : 'internet';
  }
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  const vpn = VPN_RANGES.find((range) => range.test(a, b));
  if (vpn) return vpn.name;
  return PRIVATE_RANGES.some((test) => test(a, b)) ? 'lan' : 'internet';
}

function deprioritizeCandidateLine(line) {
  const raw = String(line || '');
  const fields = raw.split(' ');
  // candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
  if (fields.length < 8 || fields[6] !== 'typ' || fields[7] !== 'host') return raw;
  const network = classifyCandidateAddress(fields[4]);
  if (!DEPRIORITIZED_VPNS.has(network)) return raw;
  const priority = Number(fields[3]);
  const component = Number(fields[1]) || 1;
  if (!Number.isFinite(priority)) return raw;
  const localPreference = (priority >> 8) & 0xffff;
  fields[3] = String(VPN_TYPE_PREFERENCE * 2 ** 24 + localPreference * 2 ** 8 + (256 - component));
  return fields.join(' ');
}

/**
 * Returns an RTCIceCandidateInit with a lowered priority when it is a host
 * candidate on a VPN adapter (IPv4 or IPv6). Used both when signaling local
 * candidates and when ingesting remote candidates from older clients.
 */
export function signaledCandidate(candidate) {
  const init = typeof candidate?.toJSON === 'function' ? candidate.toJSON() : { ...candidate };
  if (!init.candidate) return init;
  const rewritten = deprioritizeCandidateLine(init.candidate);
  return rewritten === init.candidate ? init : { ...init, candidate: rewritten };
}

/**
 * Lowers the priority of inline VPN host `a=candidate:` attributes in an SDP
 * offer/answer (e.g. during renegotiations or from older clients) while keeping
 * them available as fallback candidates.
 */
export function deprioritizeVpnSdp(sdp) {
  const text = String(sdp || '');
  if (!text.includes('a=candidate:')) return text;
  return text.replace(/(^|\r?\n)a=(candidate:[^\r\n]+)/g, (_match, prefix, candidate) => (
    `${prefix}a=${deprioritizeCandidateLine(candidate)}`
  ));
}

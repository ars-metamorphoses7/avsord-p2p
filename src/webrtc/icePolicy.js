// Field calls between houses ran "host ↔ host": both peers have a Radmin VPN
// (26.0.0.0/8) or Hamachi (25.0.0.0/8) adapter, and ICE ranks host candidates
// above the direct internet (srflx) path, so the screen stream rode the VPN
// tunnel and topped out near 10 Mb/s with constant packet loss. Advertise VPN
// candidates below srflx (still above TURN relay): ICE keeps them as the
// fallback when no direct path connects, but prefers the direct one.
const VPN_RANGES = [
  { name: 'radmin', test: (a) => a === 26 },
  { name: 'hamachi', test: (a) => a === 25 },
  { name: 'cgnat', test: (a, b) => a === 100 && b >= 64 && b <= 127 },
];
const PRIVATE_RANGES = [
  (a) => a === 10,
  (a, b) => a === 172 && b >= 16 && b <= 31,
  (a, b) => a === 192 && b === 168,
  (a) => a === 127,
];
// ICE type preference just above TURN relay (0-2) and far below srflx (100).
const VPN_TYPE_PREFERENCE = 3;

/** 'radmin' | 'hamachi' | 'cgnat' | 'lan' | 'internet' | 'mdns' | '' */
export function classifyCandidateAddress(address) {
  const value = String(address || '');
  if (!value) return '';
  if (/\.local$/i.test(value)) return 'mdns';
  const ipv4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(value);
  if (!ipv4) return /^f[cd]/i.test(value) ? 'lan' : 'internet';
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  const vpn = VPN_RANGES.find((range) => range.test(a, b));
  if (vpn) return vpn.name;
  return PRIVATE_RANGES.some((test) => test(a, b)) ? 'lan' : 'internet';
}

/**
 * Returns the RTCIceCandidateInit to signal for a local candidate, with a
 * lowered priority when it is a host candidate on a VPN adapter.
 */
export function signaledCandidate(candidate) {
  const init = typeof candidate?.toJSON === 'function' ? candidate.toJSON() : { ...candidate };
  const fields = String(init.candidate || '').split(' ');
  // candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
  if (fields.length < 8 || fields[6] !== 'typ' || fields[7] !== 'host') return init;
  const network = classifyCandidateAddress(fields[4]);
  if (!['radmin', 'hamachi'].includes(network)) return init;
  const priority = Number(fields[3]);
  const component = Number(fields[1]) || 1;
  if (!Number.isFinite(priority)) return init;
  const localPreference = (priority >> 8) & 0xffff;
  fields[3] = String(VPN_TYPE_PREFERENCE * 2 ** 24 + localPreference * 2 ** 8 + (256 - component));
  return { ...init, candidate: fields.join(' ') };
}

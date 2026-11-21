import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCandidateAddress, deprioritizeVpnSdp, signaledCandidate } from '../src/webrtc/icePolicy.js';

test('candidate addresses are classified by network (IPv4 and IPv6)', () => {
  assert.equal(classifyCandidateAddress('26.244.128.12'), 'radmin');
  assert.equal(classifyCandidateAddress('fdfd::1af4:800c'), 'radmin');
  assert.equal(classifyCandidateAddress('FDFD:0:0:0::1'), 'radmin');
  assert.equal(classifyCandidateAddress('25.1.2.3'), 'hamachi');
  assert.equal(classifyCandidateAddress('2620:9b::1901:203'), 'hamachi');
  assert.equal(classifyCandidateAddress('fd7a:115c:a1e0::1'), 'tailscale');
  assert.equal(classifyCandidateAddress('100.101.1.1'), 'cgnat');
  assert.equal(classifyCandidateAddress('192.168.0.53'), 'lan');
  assert.equal(classifyCandidateAddress('fd12:3456::1'), 'lan');
  assert.equal(classifyCandidateAddress('fe80::1'), 'lan');
  assert.equal(classifyCandidateAddress('177.10.20.30'), 'internet');
  assert.equal(classifyCandidateAddress('2804:14d:1234::1'), 'internet');
  assert.equal(classifyCandidateAddress('3b2c-1.local'), 'mdns');
});

test('VPN host candidates (IPv4 and IPv6) are advertised below the direct internet path', () => {
  const priority = (init) => Number(init.candidate.split(' ')[3]);
  const radmin = signaledCandidate({ candidate: 'candidate:1 1 udp 2122260223 26.244.128.12 50000 typ host generation 0', sdpMid: '0', sdpMLineIndex: 0 });
  const radminV6 = signaledCandidate({ candidate: 'candidate:4 1 udp 2122262783 fdfd::1af4:800c 50002 typ host generation 0', sdpMid: '0', sdpMLineIndex: 0 });
  const srflx = { candidate: 'candidate:2 1 udp 1686052607 177.10.20.30 50001 typ srflx raddr 192.168.0.53 rport 50001', sdpMid: '0', sdpMLineIndex: 0 };
  const relay = 'candidate:3 1 udp 41885439 1.2.3.4 3478 typ relay raddr 0.0.0.0 rport 0';
  assert.ok(priority(radmin) < priority(srflx));
  assert.ok(priority(radmin) > Number(relay.split(' ')[3]));
  assert.ok(priority(radminV6) < priority(srflx));
  assert.ok(priority(radminV6) > Number(relay.split(' ')[3]));
  assert.equal(radmin.sdpMid, '0');
  assert.match(radmin.candidate, / 26\.244\.128\.12 50000 typ host generation 0$/);
  assert.match(radminV6.candidate, / fdfd::1af4:800c 50002 typ host generation 0$/);
});

test('inline SDP VPN candidates are deprioritized while LAN and srflx stay untouched', () => {
  const sdp = [
    'v=0',
    'a=candidate:1 1 udp 2122262783 fdfd::1af4:800c 50000 typ host generation 0',
    'a=candidate:2 1 udp 2122260223 26.244.128.12 50001 typ host generation 0',
    'a=candidate:3 1 udp 2122194687 192.168.0.53 50002 typ host generation 0',
    'a=candidate:4 1 udp 1686052607 177.10.20.30 50003 typ srflx raddr 192.168.0.53 rport 50002',
    '',
  ].join('\r\n');
  const rewritten = deprioritizeVpnSdp(sdp);
  const lines = rewritten.split('\r\n');
  const prio = (line) => Number(line.split(' ')[3]);
  assert.ok(prio(lines[1]) < prio(lines[4]));
  assert.ok(prio(lines[2]) < prio(lines[4]));
  assert.equal(lines[3], 'a=candidate:3 1 udp 2122194687 192.168.0.53 50002 typ host generation 0');
  assert.equal(lines[4], 'a=candidate:4 1 udp 1686052607 177.10.20.30 50003 typ srflx raddr 192.168.0.53 rport 50002');
});

test('other candidates are signaled unchanged', () => {
  const lan = { candidate: 'candidate:1 1 udp 2122260223 192.168.0.53 50000 typ host', sdpMid: '0' };
  assert.deepEqual(signaledCandidate(lan), lan);
  const lanV6 = { candidate: 'candidate:1 1 udp 2122262783 fd12:3456::1 50000 typ host', sdpMid: '0' };
  assert.deepEqual(signaledCandidate(lanV6), lanV6);
  const srflx = { candidate: 'candidate:2 1 udp 1686052607 26.1.1.1 50001 typ srflx raddr 26.244.128.12 rport 1', sdpMid: '0' };
  assert.deepEqual(signaledCandidate(srflx), srflx);
  const fromBrowser = { toJSON: () => ({ candidate: '', sdpMid: '0' }) };
  assert.deepEqual(signaledCandidate(fromBrowser), { candidate: '', sdpMid: '0' });
});

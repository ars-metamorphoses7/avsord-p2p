import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCandidateAddress, signaledCandidate } from '../src/webrtc/icePolicy.js';

test('candidate addresses are classified by network', () => {
  assert.equal(classifyCandidateAddress('26.244.128.12'), 'radmin');
  assert.equal(classifyCandidateAddress('25.1.2.3'), 'hamachi');
  assert.equal(classifyCandidateAddress('100.101.1.1'), 'cgnat');
  assert.equal(classifyCandidateAddress('192.168.0.53'), 'lan');
  assert.equal(classifyCandidateAddress('177.10.20.30'), 'internet');
  assert.equal(classifyCandidateAddress('3b2c-1.local'), 'mdns');
});

test('VPN host candidates are advertised below the direct internet path', () => {
  const priority = (init) => Number(init.candidate.split(' ')[3]);
  const radmin = signaledCandidate({ candidate: 'candidate:1 1 udp 2122260223 26.244.128.12 50000 typ host generation 0', sdpMid: '0', sdpMLineIndex: 0 });
  const srflx = { candidate: 'candidate:2 1 udp 1686052607 177.10.20.30 50001 typ srflx raddr 192.168.0.53 rport 50001', sdpMid: '0', sdpMLineIndex: 0 };
  const relay = 'candidate:3 1 udp 41885439 1.2.3.4 3478 typ relay raddr 0.0.0.0 rport 0';
  assert.ok(priority(radmin) < priority(srflx));
  assert.ok(priority(radmin) > Number(relay.split(' ')[3]));
  assert.equal(radmin.sdpMid, '0');
  assert.match(radmin.candidate, / 26\.244\.128\.12 50000 typ host generation 0$/);
});

test('other candidates are signaled unchanged', () => {
  const lan = { candidate: 'candidate:1 1 udp 2122260223 192.168.0.53 50000 typ host', sdpMid: '0' };
  assert.deepEqual(signaledCandidate(lan), lan);
  const srflx = { candidate: 'candidate:2 1 udp 1686052607 26.1.1.1 50001 typ srflx raddr 26.244.128.12 rport 1', sdpMid: '0' };
  assert.deepEqual(signaledCandidate(srflx), srflx);
  const fromBrowser = { toJSON: () => ({ candidate: '', sdpMid: '0' }) };
  assert.deepEqual(signaledCandidate(fromBrowser), { candidate: '', sdpMid: '0' });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSoftwareH264Encoder,
  screenShareCodecOrder,
} from '../src/media/screenShareProfiles.js';
import { meshCodecPolicyForLocalCapabilities } from '../src/webrtc/meshCodecPolicy.js';

const CODECS = ['video/H264', 'video/VP9', 'video/VP8'];
const PAYLOADS = { 'video/H264': 102, 'video/VP9': 98, 'video/VP8': 96 };

const hardwarePeer = {
  hardwareVideoEncoding: true,
  videoEncode: 'enabled',
};
const softwarePeer = {
  hardwareVideoEncoding: false,
  videoEncode: 'disabled_software',
  preferredSoftwareCodec: 'VP8',
};

function sdpForCodecOrder(codecOrder) {
  const primaryCodecs = codecOrder.filter((codec) => CODECS.includes(codec));
  return [
    `m=video 9 UDP/TLS/RTP/SAVPF ${primaryCodecs.map((codec) => PAYLOADS[codec]).join(' ')}`,
    ...primaryCodecs.map((codec) => `a=rtpmap:${PAYLOADS[codec]} ${codec.slice('video/'.length)}/90000`),
  ].join('\r\n');
}

function negotiate(offererCapabilities, answererCapabilities, answererDecodeCodecs = CODECS) {
  const offererOrder = screenShareCodecOrder('performance', offererCapabilities);
  const answererOrder = screenShareCodecOrder('performance', answererCapabilities);
  const negotiatedCodecs = answererOrder.filter((codec) => (
    offererOrder.includes(codec) && answererDecodeCodecs.includes(codec)
  ));
  return {
    offererPolicy: meshCodecPolicyForLocalCapabilities(offererCapabilities),
    answererPolicy: meshCodecPolicyForLocalCapabilities(answererCapabilities),
    offererOrder,
    answererOrder,
    offerSdp: sdpForCodecOrder(offererOrder),
    answerSdp: sdpForCodecOrder(negotiatedCodecs),
    negotiatedCodecs,
  };
}

test('directional mesh policy keeps local encoder choices independent', () => {
  const matrix = [
    { name: 'hardware + hardware', a: hardwarePeer, b: hardwarePeer, expectedA: 'video/H264', expectedB: 'video/H264' },
    { name: 'hardware + software-only', a: hardwarePeer, b: softwarePeer, expectedA: 'video/H264', expectedB: 'video/VP8' },
    { name: 'software-only + hardware', a: softwarePeer, b: hardwarePeer, expectedA: 'video/VP8', expectedB: 'video/H264' },
    { name: 'software-only + software-only', a: softwarePeer, b: softwarePeer, expectedA: 'video/VP8', expectedB: 'video/VP8' },
  ];

  for (const entry of matrix) {
    const aOrder = screenShareCodecOrder('performance', entry.a);
    const bOrder = screenShareCodecOrder('performance', entry.b);
    assert.equal(aOrder[0], entry.expectedA, entry.name);
    assert.equal(bOrder[0], entry.expectedB, entry.name);
  }
});

test('hardware A stays H264 when software-only B is the offerer', () => {
  const flow = negotiate(softwarePeer, hardwarePeer);
  const evidence = {
    policySentByA: meshCodecPolicyForLocalCapabilities(hardwarePeer),
    policySentByB: meshCodecPolicyForLocalCapabilities(softwarePeer),
    BSoftwareOfferToAHardwareAnswer: flow,
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  assert.equal(flow.offererOrder[0], 'video/VP8');
  assert.equal(flow.answererOrder[0], 'video/H264');
  assert.deepEqual(flow.negotiatedCodecs, ['video/H264', 'video/VP9', 'video/VP8']);
  assert.match(flow.answerSdp, /m=video 9 UDP\/TLS\/RTP\/SAVPF 102 98 96/);
});

test('a receiver that cannot decode H264 still gets SDP fallback without changing sender preference', () => {
  const flow = negotiate(hardwarePeer, hardwarePeer, ['video/VP8']);
  assert.equal(flow.offererOrder[0], 'video/H264');
  assert.equal(flow.answererOrder[0], 'video/H264');
  assert.deepEqual(flow.negotiatedCodecs, ['video/VP8']);
  assert.match(flow.answerSdp, /m=video 9 UDP\/TLS\/RTP\/SAVPF 96/);
});

test('runtime OpenH264/software fallback remains a local VP8 decision', () => {
  assert.equal(isSoftwareH264Encoder({
    codec: { mimeType: 'video/H264' },
    encoderImplementation: 'OpenH264',
    powerEfficientEncoder: false,
  }), true);
  assert.equal(screenShareCodecOrder('performance', softwarePeer)[0], 'video/VP8');
});

test('reused connections recompute policy from the local capabilities', () => {
  const policyHistory = [hardwarePeer, softwarePeer, hardwarePeer]
    .map((capabilities) => meshCodecPolicyForLocalCapabilities(capabilities));
  assert.deepEqual(policyHistory, [
    'hardware-or-unknown',
    'software-only:performance:vp8',
    'hardware-or-unknown',
  ]);
});

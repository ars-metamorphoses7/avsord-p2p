import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateScreenPlayback, setReceiverPlaybackBuffer } from '../src/media/screenPlaybackPolicy.js';
import { evaluateCaptureAdaptation, initialCaptureAdaptation, observeSoftwareH264Fallback, screenShareContentDemand, selectScreenShareSfuCodec } from '../src/media/screenShareProfiles.js';

const clean = { streamKey: 'one', jitterMs: 5, packetLossRatio: 0, freezeCount: 0, framesDropped: 0 };
test('source freezes and decoder drops do not inflate a clean network buffer', () => {
  let state = evaluateScreenPlayback(null, 'performance', clean, 'responsive');
  for (let n = 1; n <= 10; n++) state = evaluateScreenPlayback(state, 'performance',
    { ...clean, freezeCount: n, framesDropped: n * 3 }, 'responsive');
  assert.equal(state.targetMs, 50);
});

test('sustained network jitter is protected and clean delivery recovers within 23 seconds', () => {
  let state = evaluateScreenPlayback(null, 'performance', clean, 'responsive');
  const bad = { ...clean, jitterMs: 100, packetLossRatio: 0.03, freezeCount: 1 };
  state = evaluateScreenPlayback(state, 'performance', bad, 'responsive');
  assert.equal(state.targetMs, 50, 'one spike does not change the target');
  state = evaluateScreenPlayback(state, 'performance', bad, 'responsive');
  assert.equal(state.targetMs, 180);
  for (let n = 0; n < 15; n++) state = evaluateScreenPlayback(state, 'performance', clean, 'responsive');
  assert.equal(state.targetMs, 50);
});

test('missing network stats do not masquerade as stable delivery', () => {
  let state = evaluateScreenPlayback(null, 'quality', clean, 'responsive');
  state = { ...state, targetMs: 200 };
  for (let n = 0; n < 20; n++) state = evaluateScreenPlayback(state, 'quality', { streamKey: 'one' }, 'responsive');
  assert.equal(state.targetMs, 200);
  assert.equal(state.jitterMs, null);
});

test('stream, profile and policy changes reset accumulated receiver pressure', () => {
  const high = { ...evaluateScreenPlayback(null, 'performance', clean, 'responsive'), targetMs: 180 };
  assert.equal(evaluateScreenPlayback(high, 'performance', { ...clean, streamKey: 'two' }, 'responsive').targetMs, 50);
  assert.equal(evaluateScreenPlayback(high, 'quality', clean, 'responsive').targetMs, 80);
  assert.equal(evaluateScreenPlayback(high, 'performance', clean, 'auto').targetMs, null);
  assert.equal(evaluateScreenPlayback(high, 'performance', clean, 'legacy').targetMs, 140);
});

test('auto releases an explicit target and unsupported receivers remain usable', () => {
  const receiver = { jitterBufferTarget: 180 };
  assert.equal(setReceiverPlaybackBuffer(receiver, null), true);
  assert.equal(receiver.jitterBufferTarget, null);
  assert.equal(setReceiverPlaybackBuffer({}, 50), false);
  assert.equal(setReceiverPlaybackBuffer({ set jitterBufferTarget(value) { throw Error('unsupported'); } }, 50), false);
});

const healthy = { captureFps: 60, framesPerSecond: 60, sendBitrateBps: 3_000_000,
  averageEncodeTimeMs: 2, availableOutgoingBitrate: 5_500_000, qualityLimitationReason: 'none',
  packetLossRatio: 0, retransmissionRatio: 0, averagePacketSendDelayMs: 1, peerCount: 1 };

test('healthy 720p delivery below the ceiling does not trigger spatial degradation', () => {
  let state = initialCaptureAdaptation('performance');
  for (let n = 0; n < 30; n++) state = evaluateCaptureAdaptation(state, 'performance', healthy);
  assert.equal(state.level, 0);
  assert.equal(state.capacityPressure, false);
  assert.equal(state.requiredBitrate, 4_000_000);
});

test('content demand cannot hide bandwidth saturation, missing stats or delivery failure', () => {
  for (const diagnostics of [{}, { ...healthy, qualityLimitationReason: 'bandwidth' },
    { ...healthy, framesPerSecond: 20 }, { ...healthy, sendBitrateBps: null }]) {
    assert.equal(screenShareContentDemand('performance', 1, 1, diagnostics), 8_000_000);
  }
  let state = initialCaptureAdaptation('performance');
  for (let n = 0; n < 12; n++) state = evaluateCaptureAdaptation(state, 'performance', {
    ...healthy, availableOutgoingBitrate: 1_000_000, framesPerSecond: 25,
    qualityLimitationReason: 'bandwidth', packetLossRatio: 0.05,
  });
  assert.ok(state.level > 0);
});

test('quality preserves detail under moderate capacity pressure but reacts spatially to severe pressure', () => {
  const seed = { ...initialCaptureAdaptation('quality'), sampleCount: 20, networkSamples: 6 };
  const diagnostics = { ...healthy, captureFps: 30, framesPerSecond: 30,
    sendBitrateBps: null, availableOutgoingBitrate: 6_000_000 };
  const moderate = evaluateCaptureAdaptation(seed, 'quality', diagnostics);
  assert.equal(moderate.level, 0);
  assert.equal(moderate.temporalLevel, 1);
  const severe = evaluateCaptureAdaptation(seed, 'quality', { ...diagnostics, availableOutgoingBitrate: 1_000_000 });
  assert.equal(severe.level, 1);
});

test('temporary encoder reports cannot permanently switch the stream to software VP8', () => {
  const software = { codec: 'video/H264', encoderImplementation: 'OpenH264', framesEncoded: 10 };
  let state = observeSoftwareH264Fallback(null, { ...software, framesEncoded: 0 }, 'one');
  assert.equal(state.samples, 0);
  state = observeSoftwareH264Fallback(state, software, 'one');
  assert.equal(state.confirmed, false);
  state = observeSoftwareH264Fallback(state, { ...software, encoderImplementation: 'NVIDIA H.264 MFT' }, 'one');
  assert.equal(state.samples, 0);
  for (let n = 0; n < 3; n++) state = observeSoftwareH264Fallback(state, software, 'one');
  assert.equal(state.confirmed, true);
  assert.equal(observeSoftwareH264Fallback(state, software, 'two').confirmed, false);
});

test('SFU selects negotiated hardware-compatible Baseline and remains compatible with old routers', () => {
  const constrained = { mimeType: 'video/H264', parameters: { 'profile-level-id': '42e01f' } };
  const baseline = { mimeType: 'video/H264', parameters: { 'profile-level-id': '42001f' } };
  const vp8 = { mimeType: 'video/VP8' };
  assert.equal(selectScreenShareSfuCodec([vp8, constrained, baseline], 'video/h264'), baseline);
  assert.equal(selectScreenShareSfuCodec([vp8, constrained], 'video/h264'), constrained);
  assert.equal(selectScreenShareSfuCodec([vp8, baseline], 'video/vp8'), vp8);
  assert.equal(selectScreenShareSfuCodec([vp8], 'video/h264'), undefined);
});

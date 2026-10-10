import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateScreenPlayback, setReceiverPlaybackBuffer } from '../src/media/screenPlaybackPolicy.js';
import { observeSoftwareH264Fallback, selectScreenShareSfuCodec } from '../src/media/screenShareProfiles.js';

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

test('stream and policy changes reset accumulated receiver pressure', () => {
  const high = { ...evaluateScreenPlayback(null, 'performance', clean, 'responsive'), targetMs: 180 };
  assert.equal(evaluateScreenPlayback(high, 'performance', { ...clean, streamKey: 'two' }, 'responsive').targetMs, 50);
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

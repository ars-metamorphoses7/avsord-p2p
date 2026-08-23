import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adaptVideoSender,
  configureVideoSender,
  evaluateCaptureAdaptation,
  initialCaptureAdaptation,
  screenCaptureConstraints,
  screenSharePlaybackBuffer,
} from '../src/media/screenShareProfiles.js';

function fakeSender() {
  return {
    parameters: { encodings: [{}] },
    getParameters() { return structuredClone(this.parameters); },
    async setParameters(parameters) { this.parameters = parameters; },
  };
}

test('fluid profile requests 1080p60 and a motion-sized bitrate', async () => {
  const constraints = screenCaptureConstraints('fluid', 'window:123:0');
  assert.equal(constraints.mandatory.maxWidth, 1920);
  assert.equal(constraints.mandatory.maxHeight, 1080);
  assert.equal(constraints.mandatory.maxFrameRate, 60);

  const sender = fakeSender();
  assert.equal(await configureVideoSender(sender, 'fluid', 1), true);
  assert.equal(sender.parameters.encodings[0].maxBitrate, 10_000_000);
  assert.equal(sender.parameters.encodings[0].maxFramerate, 60);
  assert.equal(sender.parameters.degradationPreference, 'maintain-framerate');
});

test('adaptive sender preserves FPS by scaling when flashing content saturates bandwidth', async () => {
  const sender = fakeSender();
  assert.equal(await adaptVideoSender(sender, 'fluid', 1, {
    availableOutgoingBitrate: 4_000_000,
    framesPerSecond: 24,
    qualityLimitationReason: 'bandwidth',
    adaptationScale: 1.5,
  }), true);
  assert.equal(sender.parameters.encodings[0].maxBitrate, 3_280_000);
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 1.5);
  assert.equal(sender.parameters.encodings[0].maxFramerate, 60);
});

test('adaptive sender respects a genuinely constrained uplink instead of queueing above it', async () => {
  const sender = fakeSender();
  await adaptVideoSender(sender, 'fluid', 1, {
    availableOutgoingBitrate: 1_000_000,
    framesPerSecond: 12,
    qualityLimitationReason: 'bandwidth',
    adaptationScale: 1.5,
  });
  assert.equal(sender.parameters.encodings[0].maxBitrate, 820_000);
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 1.5);
});

test('capture controller requires repeated low-FPS samples before one stable downshift', () => {
  let state = initialCaptureAdaptation('fluid');
  const lowFps = {
    captureFps: 27,
    framesPerSecond: 26,
    averageEncodeTimeMs: 7,
    qualityLimitationReason: 'none',
  };
  state = evaluateCaptureAdaptation(state, 'fluid', lowFps);
  assert.equal(state.level, 0);
  state = evaluateCaptureAdaptation(state, 'fluid', lowFps);
  assert.equal(state.level, 1);
  assert.equal(state.scale, 1.25);
  assert.equal(state.reason, 'fps-severe');
});

test('capture controller recovers resolution slowly after sustained 60 FPS', () => {
  let state = { ...initialCaptureAdaptation('fluid'), level: 2, scale: 1.5 };
  for (let sample = 0; sample < 12; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'fluid', {
      captureFps: 60,
      framesPerSecond: 59,
      averageEncodeTimeMs: 4,
      qualityLimitationReason: 'none',
    });
  }
  assert.equal(state.level, 1);
  assert.equal(state.scale, 1.25);
});

test('stable profile has lower native pixel cost and more playout margin for GPU-heavy games', () => {
  const constraints = screenCaptureConstraints('competitive', 'window:123:0');
  assert.equal(constraints.mandatory.maxWidth, 960);
  assert.equal(constraints.mandatory.maxHeight, 540);
  assert.equal(constraints.mandatory.maxFrameRate, 60);
  assert.equal(screenSharePlaybackBuffer('competitive'), 220);
  assert.equal(screenSharePlaybackBuffer('fluid'), 140);
});

test('sender bitrate recovers gradually instead of following noisy estimates in bursts', async () => {
  const sender = fakeSender();
  sender.parameters.encodings[0].maxBitrate = 2_000_000;
  await adaptVideoSender(sender, 'fluid', 1, { availableOutgoingBitrate: 20_000_000 });
  assert.equal(sender.parameters.encodings[0].maxBitrate, 2_240_000);
});

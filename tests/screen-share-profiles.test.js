import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adaptVideoSender,
  configureVideoSender,
  evaluateCaptureAdaptation,
  initialCaptureAdaptation,
  screenCaptureConstraints,
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
  assert.equal(sender.parameters.encodings[0].maxBitrate, 12_000_000);
  assert.equal(sender.parameters.encodings[0].maxFramerate, 60);
  assert.equal(sender.parameters.degradationPreference, 'maintain-framerate');
});

test('adaptive sender preserves FPS by scaling when flashing content saturates bandwidth', async () => {
  const sender = fakeSender();
  assert.equal(await adaptVideoSender(sender, 'fluid', 1, {
    availableOutgoingBitrate: 4_000_000,
    framesPerSecond: 24,
    qualityLimitationReason: 'bandwidth',
    adaptationScale: 1.45,
  }), true);
  assert.equal(sender.parameters.encodings[0].maxBitrate, 3_280_000);
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 1.45);
  assert.equal(sender.parameters.encodings[0].maxFramerate, 60);
});

test('adaptive sender respects a genuinely constrained uplink instead of queueing above it', async () => {
  const sender = fakeSender();
  await adaptVideoSender(sender, 'fluid', 1, {
    availableOutgoingBitrate: 1_000_000,
    framesPerSecond: 12,
    qualityLimitationReason: 'bandwidth',
    adaptationScale: 1.75,
  });
  assert.equal(sender.parameters.encodings[0].maxBitrate, 820_000);
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 1.75);
});

test('capture controller reacts to low real FPS even when quality remains good', () => {
  const initial = initialCaptureAdaptation('fluid');
  const next = evaluateCaptureAdaptation(initial, 'fluid', {
    captureFps: 27,
    framesPerSecond: 26,
    averageEncodeTimeMs: 7,
    qualityLimitationReason: 'none',
  });
  assert.equal(next.level, 2);
  assert.equal(next.scale, 1.45);
  assert.equal(next.reason, 'fps-severe');
});

test('capture controller recovers resolution slowly after sustained 60 FPS', () => {
  let state = { ...initialCaptureAdaptation('fluid'), level: 2, scale: 1.45 };
  for (let sample = 0; sample < 6; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'fluid', {
      captureFps: 60,
      framesPerSecond: 59,
      averageEncodeTimeMs: 4,
      qualityLimitationReason: 'none',
    });
  }
  assert.equal(state.level, 1);
  assert.equal(state.scale, 1.2);
});

test('competitive profile starts at 720p60 for GPU-heavy games', () => {
  const constraints = screenCaptureConstraints('competitive', 'window:123:0');
  assert.equal(constraints.mandatory.maxWidth, 1280);
  assert.equal(constraints.mandatory.maxHeight, 720);
  assert.equal(constraints.mandatory.maxFrameRate, 60);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCREEN_SHARE_PROFILES,
  adaptVideoSender,
  configureVideoSender,
  evaluateCaptureAdaptation,
  initialCaptureAdaptation,
  normalizeScreenShareProfileId,
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

test('picker exposes only performance and quality automatic modes', () => {
  assert.deepEqual(Object.keys(SCREEN_SHARE_PROFILES), ['performance', 'quality']);
  assert.equal(SCREEN_SHARE_PROFILES.performance.frameRate, 60);
  assert.equal(SCREEN_SHARE_PROFILES.quality.frameRate, 30);
});

test('performance mode lowers native capture cost before the encoder', async () => {
  const constraints = screenCaptureConstraints('performance', 'window:123:0');
  assert.equal(constraints.mandatory.maxWidth, 854);
  assert.equal(constraints.mandatory.maxHeight, 480);
  assert.equal(constraints.mandatory.maxFrameRate, 60);

  const sender = fakeSender();
  assert.equal(await configureVideoSender(sender, 'performance', 1), true);
  assert.equal(sender.parameters.encodings[0].maxBitrate, 4_000_000);
  assert.equal(sender.parameters.encodings[0].maxFramerate, 60);
  assert.equal(sender.parameters.degradationPreference, 'maintain-framerate');
});

test('quality mode caps itself at 1080p30', () => {
  const constraints = screenCaptureConstraints('quality', 'window:123:0');
  assert.equal(constraints.mandatory.maxWidth, 1920);
  assert.equal(constraints.mandatory.maxHeight, 1080);
  assert.equal(constraints.mandatory.maxFrameRate, 30);
  assert.equal(screenSharePlaybackBuffer('quality'), 260);
});

test('adaptive sender reduces both pixels and bitrate immediately on a downshift', async () => {
  const sender = fakeSender();
  await configureVideoSender(sender, 'performance', 1);
  assert.equal(await adaptVideoSender(sender, 'performance', 1, {
    availableOutgoingBitrate: 4_000_000,
    framesPerSecond: 34,
    qualityLimitationReason: 'bandwidth',
    adaptationScale: 1.5,
  }), true);
  assert.equal(sender.parameters.encodings[0].maxBitrate, 1_777_778);
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 1.5);
  assert.equal(sender.parameters.encodings[0].maxFramerate, 60);
});

test('adaptive sender respects a constrained uplink instead of queueing above it', async () => {
  const sender = fakeSender();
  await adaptVideoSender(sender, 'performance', 1, {
    availableOutgoingBitrate: 1_000_000,
    framesPerSecond: 20,
    qualityLimitationReason: 'bandwidth',
    adaptationScale: 1.5,
  });
  assert.equal(sender.parameters.encodings[0].maxBitrate, 780_000);
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 1.5);
});

test('performance controller sacrifices two quality levels immediately on a real FPS collapse', () => {
  const lowFps = {
    captureFps: 34,
    framesPerSecond: 32,
    averageEncodeTimeMs: 7,
    qualityLimitationReason: 'none',
  };
  let state = evaluateCaptureAdaptation(initialCaptureAdaptation('performance'), 'performance', lowFps);
  assert.equal(state.level, 2);
  assert.equal(state.scale, 1.33);
  assert.equal(state.reason, 'fps-severe');
  assert.equal(state.effectiveWidth, 642);
  assert.equal(state.effectiveHeight, 361);

  state = evaluateCaptureAdaptation(state, 'performance', lowFps);
  state = evaluateCaptureAdaptation(state, 'performance', lowFps);
  assert.equal(state.level, 4);
  assert.equal(state.scale, 1.78);
  assert.equal(state.effectiveHeight, 270);
});

test('quality controller degrades more cautiously while still protecting 30 FPS', () => {
  const pressure = {
    captureFps: 24,
    framesPerSecond: 23,
    averageEncodeTimeMs: 9,
    qualityLimitationReason: 'none',
  };
  let state = initialCaptureAdaptation('quality');
  state = evaluateCaptureAdaptation(state, 'quality', pressure);
  state = evaluateCaptureAdaptation(state, 'quality', pressure);
  assert.equal(state.level, 0);
  state = evaluateCaptureAdaptation(state, 'quality', pressure);
  assert.equal(state.level, 1);
  assert.equal(state.scale, 1.2);
  assert.equal(state.targetFps, 30);
});

test('performance controller restores one quality level only after sustained target FPS', () => {
  let state = { ...initialCaptureAdaptation('performance'), level: 4, scale: 1.78 };
  for (let sample = 0; sample < 10; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', {
      captureFps: 60,
      framesPerSecond: 59,
      averageEncodeTimeMs: 4,
      qualityLimitationReason: 'none',
    });
  }
  assert.equal(state.level, 3);
  assert.equal(state.scale, 1.5);
  assert.equal(state.reason, 'recovery');
});

test('sender bitrate recovers gradually instead of following noisy estimates in bursts', async () => {
  const sender = fakeSender();
  sender.parameters.encodings[0].maxBitrate = 2_000_000;
  await adaptVideoSender(sender, 'performance', 1, { availableOutgoingBitrate: 20_000_000 });
  assert.equal(sender.parameters.encodings[0].maxBitrate, 2_160_000);
});

test('legacy profile ids migrate without breaking old clients or saved settings', () => {
  assert.equal(normalizeScreenShareProfileId('competitive'), 'performance');
  assert.equal(normalizeScreenShareProfileId('fluid'), 'performance');
  assert.equal(normalizeScreenShareProfileId('balanced'), 'quality');
  assert.equal(normalizeScreenShareProfileId('detail'), 'quality');
  assert.equal(normalizeScreenShareProfileId('unknown'), 'performance');
});

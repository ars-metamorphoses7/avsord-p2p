import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCREEN_SHARE_PROFILES,
  adaptVideoSender,
  configureVideoSender,
  evenScreenCaptureConstraints,
  evaluateCaptureAdaptation,
  initialCaptureAdaptation,
  normalizeScreenShareProfileId,
  safeVideoSenderScale,
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
  assert.equal(constraints.mandatory.maxWidth, 1280);
  assert.equal(constraints.mandatory.maxHeight, 720);
  assert.equal(constraints.mandatory.maxFrameRate, 60);

  const sender = fakeSender();
  assert.equal(await configureVideoSender(sender, 'performance', 1), true);
  assert.equal(sender.parameters.encodings[0].maxBitrate, 8_000_000);
  assert.equal(sender.parameters.encodings[0].maxFramerate, 60);
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 1);
  assert.equal(sender.parameters.degradationPreference, 'maintain-resolution');
});

test('configuring a reused sender clears an old adaptive screen scale', async () => {
  const sender = fakeSender();
  sender.parameters.encodings[0].scaleResolutionDownBy = 2;
  await configureVideoSender(sender, 'performance', 1);
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 1);
});

test('sender scale keeps arbitrary H.264 window dimensions even', () => {
  const scale = safeVideoSenderScale(2, { sourceWidth: 1918, sourceHeight: 1080 });
  const width = Math.round(1918 / scale);
  const height = Math.round(1080 / scale);
  assert.equal(width % 2, 0);
  assert.equal(height % 2, 0);
  assert.ok(Math.abs(scale - 2) < 0.02);
});

test('sender scale finds even dimensions between width and height rounding boundaries', () => {
  for (const dimensions of [
    { sourceWidth: 401, sourceHeight: 402, requestedScale: 4 / 3 },
    { sourceWidth: 641, sourceHeight: 362, requestedScale: 1 },
  ]) {
    const scale = safeVideoSenderScale(dimensions.requestedScale, dimensions);
    const width = Math.round(dimensions.sourceWidth / scale);
    const height = Math.round(dimensions.sourceHeight / scale);
    assert.equal(width % 2, 0, `${dimensions.sourceWidth}x${dimensions.sourceHeight} width`);
    assert.equal(height % 2, 0, `${dimensions.sourceWidth}x${dimensions.sourceHeight} height`);
    assert.ok(height >= 360);
  }
});

test('quality mode caps itself at 1080p30', () => {
  const constraints = screenCaptureConstraints('quality', 'window:123:0');
  assert.equal(constraints.mandatory.maxWidth, 1920);
  assert.equal(constraints.mandatory.maxHeight, 1080);
  assert.equal(constraints.mandatory.maxFrameRate, 30);
  assert.equal(screenSharePlaybackBuffer('quality'), 180);
  assert.equal(SCREEN_SHARE_PROFILES.quality.degradationPreference, 'maintain-resolution');
});

test('odd capture dimensions request a one-pixel crop before H.264', () => {
  assert.deepEqual(evenScreenCaptureConstraints('performance', { width: 1279, height: 721 }), {
    width: { exact: 1278 },
    height: { exact: 720 },
    frameRate: { ideal: 60, max: 60 },
    resizeMode: 'crop-and-scale',
  });
  assert.equal(evenScreenCaptureConstraints('performance', { width: 1280, height: 720 }), null);
});

test('adaptive sender reduces both pixels and bitrate immediately on a downshift', async () => {
  const sender = fakeSender();
  await configureVideoSender(sender, 'performance', 1);
  assert.equal(await adaptVideoSender(sender, 'performance', 1, {
    availableOutgoingBitrate: 4_000_000,
    framesPerSecond: 34,
    qualityLimitationReason: 'bandwidth',
    adaptationScale: 4 / 3,
  }), true);
  assert.equal(sender.parameters.encodings[0].maxBitrate, 3_120_000);
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 4 / 3);
  assert.equal(sender.parameters.encodings[0].maxFramerate, 60);
});

test('adaptive sender respects a constrained uplink instead of queueing above it', async () => {
  const sender = fakeSender();
  await adaptVideoSender(sender, 'performance', 1, {
    availableOutgoingBitrate: 1_000_000,
    framesPerSecond: 20,
    qualityLimitationReason: 'bandwidth',
    adaptationScale: 4 / 3,
  });
  assert.equal(sender.parameters.encodings[0].maxBitrate, 780_000);
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 4 / 3);
});

test('adaptive sender applies the 360p floor to the real ultrawide source height', async () => {
  const sender = fakeSender();
  await configureVideoSender(sender, 'performance', 1);
  await adaptVideoSender(sender, 'performance', 1, {
    adaptationScale: 2,
    sourceWidth: 1280,
    sourceHeight: 536,
  });
  const scale = sender.parameters.encodings[0].scaleResolutionDownBy;
  assert.ok(Math.abs(scale - (536 / 360)) < 1e-9);
  assert.ok((536 / scale) >= 360);
});

test('adaptive sender reconstructs source height from outbound stats when needed', async () => {
  const sender = fakeSender();
  sender.parameters.encodings[0].scaleResolutionDownBy = 4 / 3;
  await adaptVideoSender(sender, 'performance', 1, {
    adaptationScale: 2,
    frameWidth: 960,
    frameHeight: 402,
  });
  const scale = sender.parameters.encodings[0].scaleResolutionDownBy;
  assert.ok(Math.abs(scale - (536 / 360)) < 1e-9);
});

test('performance controller preserves pixels when capture is source-limited', () => {
  const sourceLimited = {
    captureFps: 34,
    framesPerSecond: 32,
    averageEncodeTimeMs: 7,
    qualityLimitationReason: 'none',
  };
  let state = initialCaptureAdaptation('performance');
  for (let sample = 0; sample < 8; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', sourceLimited);
  }
  assert.equal(state.level, 0);
  assert.equal(state.scale, 1);
  assert.equal(state.reason, 'source-limited');
  assert.equal(state.bottleneck, 'source');
  assert.equal(state.sourceLimited, true);
  assert.equal(state.effectiveWidth, 1280);
  assert.equal(state.effectiveHeight, 720);
});

test('performance controller downscales when encoder loses captured frames', () => {
  const encoderLimited = {
    captureFps: 60,
    framesPerSecond: 32,
    averageEncodeTimeMs: 7,
    qualityLimitationReason: 'none',
  };
  let state = initialCaptureAdaptation('performance');
  for (let sample = 0; sample < 4; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', encoderLimited);
  }
  assert.equal(state.level, 1);
  assert.equal(state.scale, 4 / 3);
  assert.equal(state.reason, 'encoder-fps-severe');
  assert.equal(state.bottleneck, 'encoder');
  assert.equal(state.effectiveWidth, 960);
  assert.equal(state.effectiveHeight, 540);
  assert.equal(state.downscaleEffectiveness.status, 'observing');
  assert.equal(state.downscaleEffectiveness.samplesObserved, 0);
  assert.equal(state.downscaleEffectiveness.triggerReason, 'encoder-fps-severe');
});

test('a real zero-FPS encoder stall pulls the trend down and triggers protection', () => {
  const stalledEncoder = {
    captureFps: 60,
    framesPerSecond: 0,
    averageEncodeTimeMs: null,
    qualityLimitationReason: 'none',
  };
  let state = initialCaptureAdaptation('performance');
  for (let sample = 0; sample < 4; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', stalledEncoder);
  }
  assert.equal(state.fpsEma, 0);
  assert.equal(state.level, 1);
  assert.equal(state.reason, 'encoder-fps-severe');
  assert.equal(state.encoderDeliveryRatio, 0);
  assert.equal(state.encoderTrial.baselineEncodeTimeMs, null);
});

test('missing encode timing cannot falsely prove a downscale effective', () => {
  const encoderCollapseWithoutTiming = {
    captureFps: 60,
    framesPerSecond: 32,
    qualityLimitationReason: 'none',
  };
  let state = initialCaptureAdaptation('performance');
  for (let sample = 0; sample < 4; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', encoderCollapseWithoutTiming);
  }
  assert.equal(state.level, 1);
  for (let sample = 0; sample < 3; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', encoderCollapseWithoutTiming);
  }
  assert.equal(state.level, 0);
  assert.equal(state.downscaleEffectiveness.status, 'ineffective');
  assert.equal(state.downscaleEffectiveness.materialEncodeCostReduction, false);
  assert.equal(state.reason, 'encoder-downscale-ineffective-rollback');
});

test('ineffective encoder downscale rolls back after three comparable samples', () => {
  const noImprovement = {
    captureFps: 60,
    framesPerSecond: 32,
    averageEncodeTimeMs: 7,
    qualityLimitationReason: 'none',
  };
  let state = initialCaptureAdaptation('performance');
  for (let sample = 0; sample < 4; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', noImprovement);
  }
  assert.equal(state.level, 1);

  for (let sample = 0; sample < 3; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', noImprovement);
  }
  assert.equal(state.level, 0);
  assert.equal(state.scale, 1);
  assert.equal(state.reason, 'encoder-downscale-ineffective-rollback');
  assert.equal(state.downscaleEffectiveness.status, 'ineffective');
  assert.equal(state.downscaleEffectiveness.samplesObserved, 3);
  assert.equal(state.downscaleEffectiveness.deliveryGain, 0);
  assert.equal(state.downscaleEffectiveness.encodeCostReductionRatio, 0);
  assert.equal(state.encoderTrial, null);
  assert.equal(state.cooldownSamples, 6);

  for (let sample = 0; sample < 5; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', noImprovement);
  }
  assert.equal(state.level, 0);
  assert.equal(state.reason, 'encoder-downscale-ineffective-rollback');
});

test('material delivery improvement keeps the encoder downscale', () => {
  const encoderCollapse = {
    captureFps: 60,
    framesPerSecond: 32,
    averageEncodeTimeMs: 7,
    qualityLimitationReason: 'none',
  };
  const improved = {
    captureFps: 60,
    framesPerSecond: 50,
    averageEncodeTimeMs: 5,
    qualityLimitationReason: 'none',
  };
  let state = initialCaptureAdaptation('performance');
  for (let sample = 0; sample < 4; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', encoderCollapse);
  }
  for (let sample = 0; sample < 3; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', improved);
  }

  assert.equal(state.level, 1);
  assert.equal(state.scale, 4 / 3);
  assert.equal(state.reason, 'encoder-downscale-effective');
  assert.equal(state.downscaleEffectiveness.status, 'effective');
  assert.ok(state.downscaleEffectiveness.deliveryGain > 0.29);
  assert.equal(state.downscaleEffectiveness.materialDeliveryGain, true);
  assert.equal(state.encoderTrial, null);
});

test('material encode-cost reduction keeps a downscale without delivery change', () => {
  const expensiveEncode = {
    captureFps: 60,
    framesPerSecond: 59,
    averageEncodeTimeMs: 20,
    qualityLimitationReason: 'cpu',
  };
  const cheaperEncode = {
    captureFps: 60,
    framesPerSecond: 59,
    averageEncodeTimeMs: 14,
    qualityLimitationReason: 'none',
  };
  let state = initialCaptureAdaptation('performance');
  for (let sample = 0; sample < 4; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', expensiveEncode);
  }
  for (let sample = 0; sample < 3; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', cheaperEncode);
  }

  assert.equal(state.level, 1);
  assert.equal(state.reason, 'encoder-downscale-effective');
  assert.equal(state.downscaleEffectiveness.materialEncodeCostReduction, true);
  assert.ok(state.downscaleEffectiveness.encodeCostReductionRatio > 0.29);
});

test('performance adaptation never crosses Chromium hardware encode 360p floor', () => {
  const heights = SCREEN_SHARE_PROFILES.performance.adaptationScales
    .map((scale) => Math.round(SCREEN_SHARE_PROFILES.performance.height / scale));
  assert.ok(heights.every((height) => height >= 360));
  assert.equal(Math.min(...heights), 360);
});

test('missing source stats cannot destroy resolution from FPS alone', () => {
  let state = initialCaptureAdaptation('performance');
  for (let sample = 0; sample < 8; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', {
      framesPerSecond: 24,
      averageEncodeTimeMs: 3,
      qualityLimitationReason: 'none',
    });
  }
  assert.equal(state.level, 0);
  assert.equal(state.scale, 1);
});

test('quality controller degrades more cautiously while still protecting 30 FPS', () => {
  const pressure = {
    captureFps: 30,
    framesPerSecond: 23,
    averageEncodeTimeMs: 9,
    qualityLimitationReason: 'none',
  };
  let state = initialCaptureAdaptation('quality');
  for (let sample = 0; sample < 5; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'quality', pressure);
  }
  assert.equal(state.level, 0);
  state = evaluateCaptureAdaptation(state, 'quality', pressure);
  assert.equal(state.level, 1);
  assert.equal(state.scale, 1.2);
  assert.equal(state.targetFps, 30);
});

test('performance controller restores one quality level only after sustained target FPS', () => {
  let state = { ...initialCaptureAdaptation('performance'), level: 2, scale: 2 };
  for (let sample = 0; sample < 10; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', {
      captureFps: 60,
      framesPerSecond: 59,
      averageEncodeTimeMs: 4,
      qualityLimitationReason: 'none',
    });
  }
  assert.equal(state.level, 1);
  assert.equal(state.scale, 4 / 3);
  assert.equal(state.reason, 'recovery');
});

test('stale bandwidth reason with transport headroom does not reduce resolution', () => {
  let state = initialCaptureAdaptation('performance');
  for (let sample = 0; sample < 12; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', {
      captureFps: 60,
      framesPerSecond: 59,
      averageEncodeTimeMs: 3,
      qualityLimitationReason: 'bandwidth',
      availableOutgoingBitrate: 10_000_000,
      configuredMaxBitrate: 8_000_000,
    });
  }
  assert.equal(state.level, 0);
  assert.equal(state.networkPressure, false);
  assert.ok(state.networkHeadroomRatio > 1.2);
});

test('stale bandwidth reason cannot trap a source-limited stream at low resolution', () => {
  let state = { ...initialCaptureAdaptation('performance'), level: 1, scale: 4 / 3 };
  for (let sample = 0; sample < 2; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', {
      captureFps: 30,
      framesPerSecond: 30,
      averageEncodeTimeMs: 3,
      qualityLimitationReason: 'bandwidth',
      availableOutgoingBitrate: 10_000_000,
      configuredMaxBitrate: 8_000_000,
    });
  }
  assert.equal(state.networkPressure, false);
  assert.equal(state.sourceLimited, true);
  assert.equal(state.level, 0);
  assert.equal(state.reason, 'source-limited-recovery');
});

test('sustained pure network pressure changes bitrate diagnostics, not spatial level', () => {
  let state = initialCaptureAdaptation('performance');
  for (let sample = 0; sample < 12; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', {
      captureFps: 60,
      framesPerSecond: 59,
      averageEncodeTimeMs: 3,
      qualityLimitationReason: 'bandwidth',
      availableOutgoingBitrate: 1_000_000,
      configuredMaxBitrate: 8_000_000,
    });
  }
  assert.equal(state.level, 0);
  assert.equal(state.scale, 1);
  assert.equal(state.bottleneck, 'network');
  assert.equal(state.networkPressure, true);
  assert.equal(state.networkSustained, true);
  assert.equal(state.reason, 'network-bitrate-only');
  assert.equal(state.encoderTrial, null);
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

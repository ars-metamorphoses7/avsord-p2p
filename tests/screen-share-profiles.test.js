import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCREEN_SHARE_PROFILES,
  RECOVERY_PROBE_COOLDOWN_SAMPLES,
  RECOVERY_PROBE_MAX_SAMPLES,
  adaptVideoSender,
  configureVideoSender,
  evenScreenCaptureConstraints,
  evaluatePlaybackBufferAdaptation,
  evaluateCaptureAdaptation,
  initialCaptureAdaptation,
  initialPlaybackBufferAdaptation,
  isSoftwareH264Encoder,
  normalizeScreenShareProfileId,
  safeVideoSenderScale,
  screenCaptureConstraints,
  screenShareEncodingBitrate,
  screenShareRecoveryProbeBitrate,
  screenShareCodecOrder,
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
  assert.deepEqual(SCREEN_SHARE_PROFILES.performance.adaptationFrameRates, [60, 30, 20, 15]);
  assert.deepEqual(SCREEN_SHARE_PROFILES.quality.adaptationFrameRates, [30, 20, 15]);
});

test('codec policy keeps H.264 first when hardware encoding is available', () => {
  assert.deepEqual(screenShareCodecOrder('performance', {
    hardwareVideoEncoding: true,
    videoEncode: 'enabled',
  }), ['video/H264', 'video/VP9', 'video/VP8']);
});

test('codec policy avoids OpenH264 when the runtime reports software-only encoding', () => {
  assert.deepEqual(screenShareCodecOrder('performance', {
    hardwareVideoEncoding: false,
    videoEncode: 'disabled_software',
  }), ['video/VP8', 'video/H264', 'video/VP9']);
});

test('software codec policy can be overridden by the benchmark matrix', () => {
  assert.deepEqual(screenShareCodecOrder('quality', {
    hardwareVideoEncoding: false,
    videoEncode: 'disabled_software',
  }), ['video/VP8', 'video/H264', 'video/VP9']);
  assert.deepEqual(screenShareCodecOrder('quality', {
    hardwareVideoEncoding: false,
    videoEncode: 'disabled_software',
    preferredSoftwareCodec: 'VP8',
  }), ['video/VP8', 'video/H264', 'video/VP9']);
});

test('actual H.264 implementation overrides an optimistic GPU capability probe', () => {
  assert.equal(isSoftwareH264Encoder({
    codec: { mimeType: 'video/H264' },
    encoderImplementation: 'OpenH264',
    powerEfficientEncoder: false,
  }), true);
  assert.equal(isSoftwareH264Encoder({
    codec: { mimeType: 'video/H264' },
    encoderImplementation: 'VaapiVideoEncoder',
    powerEfficientEncoder: true,
  }), false);
  assert.equal(isSoftwareH264Encoder({
    codec: { mimeType: 'video/VP8' },
    encoderImplementation: 'libvpx',
    powerEfficientEncoder: false,
  }), false);
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

test('receiver buffer grows on jitter/freezes and decays slowly', () => {
  let state = initialPlaybackBufferAdaptation('performance');
  state = evaluatePlaybackBufferAdaptation(state, 'performance', {
    jitterMs: 5,
    freezeCount: 0,
    framesDropped: 0,
  });
  assert.equal(state.targetMs, 140);

  state = evaluatePlaybackBufferAdaptation(state, 'performance', {
    jitterMs: 60,
    freezeCount: 1,
    framesDropped: 0,
  });
  assert.equal(state.targetMs, 360);
  assert.equal(state.reason, 'freeze-protection');
  assert.equal(state.freezeDelta, 1);

  for (let sample = 0; sample < 5; sample += 1) {
    state = evaluatePlaybackBufferAdaptation(state, 'performance', {
      jitterMs: 0,
      freezeCount: 1,
      framesDropped: 0,
    });
  }
  assert.equal(state.targetMs, 345);
  assert.equal(state.reason, 'stable-decay');
});

test('quality receiver buffer is bounded under repeated drops', () => {
  let state = evaluatePlaybackBufferAdaptation(initialPlaybackBufferAdaptation('quality'), 'quality', {
    jitterMs: 0,
    freezeCount: 0,
    framesDropped: 0,
  });
  state = evaluatePlaybackBufferAdaptation(state, 'quality', {
    jitterMs: 200,
    freezeCount: 4,
    framesDropped: 20,
  });
  assert.equal(state.targetMs, 480);
  assert.equal(state.reason, 'freeze-protection');
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

test('adaptive sender clamps a sudden capacity collapse in one sample', async () => {
  const sender = fakeSender();
  sender.parameters.encodings[0].maxBitrate = 8_000_000;
  await adaptVideoSender(sender, 'performance', 1, {
    availableOutgoingBitrate: 1_000_000,
    adaptationScale: 1,
  });
  assert.equal(sender.parameters.encodings[0].maxBitrate, 780_000);
});

test('startup exploration bounds a capacity-only estimate through its startup samples', async () => {
  const sender = fakeSender();
  await configureVideoSender(sender, 'performance', 1);
  const startupCapacity = {
    availableOutgoingBitrate: 750_000,
    adaptationScale: 1,
    targetFrameRate: 60,
    startupBitrateGuardActive: true,
    startupExplorationActive: true,
  };
  for (let sample = 0; sample < 3; sample += 1) {
    await adaptVideoSender(sender, 'performance', 1, startupCapacity);
    assert.equal(sender.parameters.encodings[0].maxBitrate, 2_150_000);
    assert.ok(sender.parameters.encodings[0].maxBitrate > 750_000);
    assert.ok(sender.parameters.encodings[0].maxBitrate < 8_000_000);
  }

  await adaptVideoSender(sender, 'performance', 1, {
    ...startupCapacity,
    startupBitrateGuardActive: false,
  });
  assert.equal(sender.parameters.encodings[0].maxBitrate, 585_000);
});

test('startup bitrate guard is exposed exactly by the existing startup sample window', () => {
  let state = initialCaptureAdaptation('performance');
  const diagnostics = {
    captureFps: 60,
    framesPerSecond: 59,
    averageEncodeTimeMs: 3,
    availableOutgoingBitrate: 20_000_000,
  };
  for (let sample = 0; sample < 3; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', diagnostics);
    assert.equal(state.startupBitrateGuardActive, true);
  }
  state = evaluateCaptureAdaptation(state, 'performance', diagnostics);
  assert.equal(state.startupBitrateGuardActive, false);
});

test('startup bitrate guard yields to every existing transport pressure signal', async () => {
  const pressureCases = [
    { packetLossRatio: 0.03 },
    { retransmissionRatio: 0.10 },
    { averagePacketSendDelayMs: 20 },
    { packetsDiscardedOnSend: 1 },
  ];
  for (const pressure of pressureCases) {
    const sender = fakeSender();
    await configureVideoSender(sender, 'performance', 1);
    await adaptVideoSender(sender, 'performance', 1, {
      availableOutgoingBitrate: 750_000,
      adaptationScale: 1,
      targetFrameRate: 60,
      startupBitrateGuardActive: true,
      ...pressure,
    });
    assert.ok(sender.parameters.encodings[0].maxBitrate < 8_000_000, JSON.stringify(pressure));
  }
});

test('startup bitrate guard never restores a cap previously reduced by transport pressure', async () => {
  const sender = fakeSender();
  await configureVideoSender(sender, 'performance', 1);
  await adaptVideoSender(sender, 'performance', 1, {
    availableOutgoingBitrate: 750_000,
    packetLossRatio: 0.03,
    adaptationScale: 1,
    startupBitrateGuardActive: true,
  });
  const pressureCap = sender.parameters.encodings[0].maxBitrate;
  assert.equal(pressureCap, 525_000);
  await adaptVideoSender(sender, 'performance', 1, {
    availableOutgoingBitrate: 600_000,
    adaptationScale: 1,
    startupBitrateGuardActive: true,
  });
  assert.equal(sender.parameters.encodings[0].maxBitrate, pressureCap);
  assert.notEqual(sender.parameters.encodings[0].maxBitrate, 8_000_000);
});

test('temporal fallback reduces sender cadence and its nominal bitrate', async () => {
  const sender = fakeSender();
  await configureVideoSender(sender, 'performance', 1);
  await adaptVideoSender(sender, 'performance', 1, {
    adaptationScale: 2,
    targetFrameRate: 30,
    sourceWidth: 1280,
    sourceHeight: 720,
  });
  assert.equal(sender.parameters.encodings[0].maxFramerate, 30);
  assert.equal(sender.parameters.encodings[0].maxBitrate, 2_000_000);
  assert.equal(screenShareEncodingBitrate('performance', 1, 2), 2_000_000);
});

test('startup bitrate guard preserves the current cap during software structural safe start', async () => {
  const sender = fakeSender();
  await configureVideoSender(sender, 'performance', 1);
  await adaptVideoSender(sender, 'performance', 1, {
    availableOutgoingBitrate: 0,
    adaptationScale: 4 / 3,
    targetFrameRate: 30,
    sourceWidth: 1280,
    sourceHeight: 720,
    startupBitrateGuardActive: true,
  });
  assert.equal(sender.parameters.encodings[0].maxBitrate, 4_500_000);
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 4 / 3);
  assert.equal(sender.parameters.encodings[0].maxFramerate, 30);
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

test('57/60 capture and encode is healthy for the current operating point', () => {
  let state = {
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    sampleCount: 4,
    fpsEma: 57,
  };
  for (let sample = 0; sample < SCREEN_SHARE_PROFILES.performance.recoverySamples; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', {
      captureFps: 57,
      framesPerSecond: 57,
      averageEncodeTimeMs: 2,
      availableOutgoingBitrate: 3_600_000,
      peerCount: 1,
    });
  }
  assert.equal(state.currentOperatingPointHealthy, true);
  assert.equal(state.level, 2);
  assert.equal(state.temporalLevel, 0);
  assert.equal(state.networkRecoveryReady, false);
  assert.equal(state.stableSamples, SCREEN_SHARE_PROFILES.performance.recoverySamples);
  assert.equal(state.recoveryProbeActive, true);
});

test('source-limited 45/45 does not count as current-point health or start a probe', () => {
  const state = evaluateCaptureAdaptation({
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    sampleCount: 4,
  }, 'performance', {
    captureFps: 45,
    framesPerSecond: 45,
    averageEncodeTimeMs: 2,
    availableOutgoingBitrate: 3_600_000,
  });
  assert.equal(state.sourceLimited, true);
  assert.equal(state.currentOperatingPointHealthy, false);
  assert.equal(state.stableSamples, 0);
  assert.equal(state.recoveryProbeActive, false);
});

test('encoder delivery loss at 57/40 does not count as current-point health', () => {
  const state = evaluateCaptureAdaptation({
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    sampleCount: 4,
  }, 'performance', {
    captureFps: 57,
    framesPerSecond: 40,
    averageEncodeTimeMs: 2,
    availableOutgoingBitrate: 3_600_000,
  });
  assert.equal(state.sourceLimited, false);
  assert.equal(state.encoderDeliveryRatio < 0.92, true);
  assert.equal(state.currentOperatingPointHealthy, false);
  assert.equal(state.recoveryProbeActive, false);
});

test('actual software encoder stats start from a conservative operating point', () => {
  const performance = evaluateCaptureAdaptation(initialCaptureAdaptation('performance'), 'performance', {
    captureFps: 30,
    framesPerSecond: 28,
    averageEncodeTimeMs: 28,
    encoderImplementation: 'OpenH264',
    powerEfficientEncoder: false,
  });
  assert.equal(performance.level, 1);
  assert.equal(performance.temporalLevel, 1);
  assert.equal(performance.scale, 4 / 3);
  assert.equal(performance.frameRate, 30);
  assert.equal(performance.reason, 'software-encoder-safe-start');
  assert.equal(performance.softwareEncoder, true);

  const quality = evaluateCaptureAdaptation(initialCaptureAdaptation('quality'), 'quality', {
    captureFps: 30,
    framesPerSecond: 14,
    averageEncodeTimeMs: 55,
    encoderImplementation: 'OpenH264',
    powerEfficientEncoder: false,
  });
  assert.equal(quality.level, 2);
  assert.equal(quality.temporalLevel, 1);
  assert.equal(quality.scale, 1.5);
  assert.equal(quality.frameRate, 20);
});

test('hardware encoder retains the full startup operating point', () => {
  const state = evaluateCaptureAdaptation(initialCaptureAdaptation('performance'), 'performance', {
    captureFps: 60,
    framesPerSecond: 59,
    averageEncodeTimeMs: 3,
    encoderImplementation: 'MediaFoundationVideoEncodeAccelerator',
    powerEfficientEncoder: true,
  });
  assert.equal(state.level, 0);
  assert.equal(state.temporalLevel, 0);
  assert.equal(state.frameRate, 60);
  assert.equal(state.softwareEncoder, false);
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
  assert.equal(state.downscaleEffectiveness.encodeDeadlineRescued, true);
  assert.ok(state.downscaleEffectiveness.encodeCostReductionRatio > 0.29);
});

test('cheaper encode alone preserves spatial quality when frame deadlines were already met', () => {
  const nearBudget = {
    captureFps: 30,
    framesPerSecond: 29,
    averageEncodeTimeMs: 29,
    qualityLimitationReason: 'cpu',
  };
  const cheaperWithoutDeliveryGain = {
    ...nearBudget,
    averageEncodeTimeMs: 15,
    qualityLimitationReason: 'none',
  };
  let state = {
    ...initialCaptureAdaptation('performance'),
    level: 1,
    temporalLevel: 1,
    scale: 4 / 3,
    frameRate: 30,
    sampleCount: 4,
  };
  for (let sample = 0; sample < 2; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', nearBudget);
  }
  assert.equal(state.level, 2);
  for (let sample = 0; sample < 3; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', cheaperWithoutDeliveryGain);
  }

  assert.equal(state.level, 1);
  assert.equal(state.reason, 'encoder-downscale-ineffective-rollback');
  assert.equal(state.downscaleEffectiveness.materialEncodeCostReduction, true);
  assert.equal(state.downscaleEffectiveness.encodeDeadlineRescued, false);
  assert.ok(state.downscaleEffectiveness.baselineEncodeRatio < 1);

  for (let sample = 0; sample < 12; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', nearBudget);
  }
  assert.equal(state.level, 1);
  assert.equal(state.reason, 'encoder-downscale-ineffective-hold');
  assert.equal(state.encoderTrial, null);
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

test('sustained network pressure reaches the minimum safe operating point', () => {
  let state = initialCaptureAdaptation('performance');
  for (let sample = 0; sample < 24; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', {
      captureFps: 60,
      framesPerSecond: state.frameRate,
      averageEncodeTimeMs: 3,
      qualityLimitationReason: 'bandwidth',
      availableOutgoingBitrate: 1_000_000,
      // This is deliberately below the demand but above the sender cap from
      // the previous sample. Comparing against maxBitrate would hide pressure.
      configuredMaxBitrate: 780_000,
      peerCount: 1,
    });
  }
  assert.equal(state.level, 2);
  assert.equal(state.scale, 2);
  assert.equal(state.temporalLevel, 3);
  assert.equal(state.frameRate, 15);
  assert.equal(state.targetFps, 15);
  assert.equal(state.networkPressure, true);
  assert.equal(state.reason, 'network-minimum-operating-point');
  assert.equal(state.networkRecoveryReady, false);
  assert.equal(state.recoveryRequiredBitrate, 2_000_000);
  assert.equal(state.encoderTrial, null);
});

test('encoder pressure uses temporal fallback after the spatial floor', () => {
  let state = {
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    sampleCount: 4,
  };
  state = evaluateCaptureAdaptation(state, 'performance', {
    captureFps: 60,
    framesPerSecond: 20,
    averageEncodeTimeMs: 20,
    qualityLimitationReason: 'cpu',
  });
  assert.equal(state.level, 2);
  assert.equal(state.temporalLevel, 1);
  assert.equal(state.frameRate, 30);
  assert.equal(state.reason, 'encoder-temporal-severe');
  assert.equal(state.encoderTrial, null);
});

test('temporal recovery waits for capacity headroom for the richer level', () => {
  let state = {
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    temporalLevel: 1,
    frameRate: 30,
  };
  for (let sample = 0; sample < 20; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', {
      captureFps: 60,
      framesPerSecond: 30,
      averageEncodeTimeMs: 3,
      availableOutgoingBitrate: 1_000_000,
    });
  }
  assert.equal(state.temporalLevel, 3);
  assert.equal(state.networkRecoveryReady, false);

  for (let sample = 0; sample < SCREEN_SHARE_PROFILES.performance.recoverySamples; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', {
      captureFps: 60,
      framesPerSecond: 30,
      averageEncodeTimeMs: 3,
      availableOutgoingBitrate: 2_400_000,
    });
  }
  assert.equal(state.temporalLevel, 2);
  assert.equal(state.frameRate, 20);
  assert.equal(state.reason, 'temporal-recovery');
});

test('spatial recovery probe derives a temporary cap from the next operating point', () => {
  let state = {
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    sampleCount: 4,
    stableSamples: SCREEN_SHARE_PROFILES.performance.recoverySamples - 1,
    fpsEma: 57,
  };
  state = evaluateCaptureAdaptation(state, 'performance', {
    captureFps: 57,
    framesPerSecond: 57,
    averageEncodeTimeMs: 2,
    availableOutgoingBitrate: 3_600_000,
    peerCount: 1,
  });
  assert.equal(state.level, 2);
  assert.equal(state.temporalLevel, 0);
  assert.equal(state.recoveryProbeActive, true);
  assert.equal(state.recoveryProbeSamples, 0);
  assert.equal(state.recoveryProbeCooldownSamples, 0);
  assert.equal(state.recoveryProbeReason, 'insufficient-next-point-headroom');
  assert.equal(state.recoveryProbeMaxBitrate, 5_500_000);
  assert.equal(state.reason, 'spatial-recovery-probe');
});

test('spatial recovery probe recovers exactly one level after headroom appears', () => {
  const state = evaluateCaptureAdaptation({
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    sampleCount: 14,
    stableSamples: SCREEN_SHARE_PROFILES.performance.recoverySamples,
    fpsEma: 57,
    recoveryProbeActive: true,
    recoveryProbeSamples: RECOVERY_PROBE_MAX_SAMPLES - 1,
    recoveryProbeMaxBitrate: 5_500_000,
    recoveryProbeReason: 'insufficient-next-point-headroom',
  }, 'performance', {
    captureFps: 57,
    framesPerSecond: 57,
    averageEncodeTimeMs: 2,
    availableOutgoingBitrate: 6_000_000,
    peerCount: 1,
  });
  assert.equal(state.level, 1);
  assert.equal(state.scale, 4 / 3);
  assert.equal(state.temporalLevel, 0);
  assert.equal(state.reason, 'recovery');
  assert.equal(state.recoveryProbeActive, false);
  assert.equal(state.recoveryProbeSamples, 0);
  assert.equal(state.recoveryProbeCooldownSamples, 0);
  assert.equal(state.recoveryProbeMaxBitrate, null);
});

test('spatial recovery probe times out and restores the operating-point cap', () => {
  const state = evaluateCaptureAdaptation({
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    sampleCount: 14,
    stableSamples: SCREEN_SHARE_PROFILES.performance.recoverySamples,
    fpsEma: 57,
    recoveryProbeActive: true,
    recoveryProbeSamples: RECOVERY_PROBE_MAX_SAMPLES - 1,
    recoveryProbeMaxBitrate: 5_500_000,
    recoveryProbeReason: 'insufficient-next-point-headroom',
  }, 'performance', {
    captureFps: 57,
    framesPerSecond: 57,
    averageEncodeTimeMs: 2,
    availableOutgoingBitrate: 3_600_000,
    peerCount: 1,
  });
  assert.equal(state.level, 2);
  assert.equal(state.scale, 2);
  assert.equal(state.temporalLevel, 0);
  assert.equal(state.frameRate, 60);
  assert.equal(state.recoveryProbeActive, false);
  assert.equal(state.recoveryProbeSamples, 0);
  assert.equal(state.recoveryProbeCooldownSamples, RECOVERY_PROBE_COOLDOWN_SAMPLES);
  assert.equal(state.recoveryProbeMaxBitrate, null);
  assert.equal(state.recoveryProbeReason, 'spatial-recovery-probe-timeout');
  assert.equal(state.recoveryProbeAbortReason, 'insufficient-next-point-headroom');
  assert.equal(state.networkPressure, false);
  assert.equal(state.transportPressure, false);
});

test('probe timeout immediately removes the temporary sender cap', async () => {
  const sender = fakeSender();
  sender.parameters.encodings[0].maxBitrate = 5_500_000;
  sender.parameters.encodings[0].scaleResolutionDownBy = 2;
  sender.parameters.encodings[0].maxFramerate = 60;
  await adaptVideoSender(sender, 'performance', 1, {
    availableOutgoingBitrate: 3_600_000,
    adaptationScale: 2,
    targetFrameRate: 60,
    networkPressure: false,
    transportPressure: false,
    recoveryProbeActive: false,
    recoveryProbeMaxBitrate: null,
    allowBitrateIncrease: false,
  });
  assert.equal(sender.parameters.encodings[0].maxBitrate, 2_000_000);
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 2);
  assert.equal(sender.parameters.encodings[0].maxFramerate, 60);
});

test('probe retry cooldown delays only the next probe and keeps stable samples', () => {
  const state = evaluateCaptureAdaptation({
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    sampleCount: 14,
    stableSamples: SCREEN_SHARE_PROFILES.performance.recoverySamples,
    fpsEma: 57,
    recoveryProbeCooldownSamples: RECOVERY_PROBE_COOLDOWN_SAMPLES,
    recoveryProbeReason: 'spatial-recovery-probe-timeout',
  }, 'performance', {
    captureFps: 57,
    framesPerSecond: 57,
    averageEncodeTimeMs: 2,
    availableOutgoingBitrate: 3_600_000,
    peerCount: 1,
  });
  assert.equal(state.recoveryProbeActive, false);
  assert.equal(state.recoveryProbeCooldownSamples, RECOVERY_PROBE_COOLDOWN_SAMPLES - 1);
  assert.equal(state.stableSamples, SCREEN_SHARE_PROFILES.performance.recoverySamples + 1);
});

test('probe retry opens after its separate cooldown expires', () => {
  const state = evaluateCaptureAdaptation({
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    sampleCount: 14,
    stableSamples: SCREEN_SHARE_PROFILES.performance.recoverySamples - 1,
    fpsEma: 57,
    recoveryProbeCooldownSamples: 1,
    recoveryProbeReason: 'spatial-recovery-probe-timeout',
  }, 'performance', {
    captureFps: 57,
    framesPerSecond: 57,
    averageEncodeTimeMs: 2,
    availableOutgoingBitrate: 3_600_000,
    peerCount: 1,
  });
  assert.equal(state.recoveryProbeActive, true);
  assert.equal(state.recoveryProbeSamples, 0);
  assert.equal(state.recoveryProbeCooldownSamples, 0);
});

test('a later capacity increase lets a retry probe recover one spatial level', () => {
  const firstProbe = evaluateCaptureAdaptation({
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    sampleCount: 14,
    stableSamples: SCREEN_SHARE_PROFILES.performance.recoverySamples - 1,
    fpsEma: 57,
    recoveryProbeCooldownSamples: 1,
  }, 'performance', {
    captureFps: 57,
    framesPerSecond: 57,
    averageEncodeTimeMs: 2,
    availableOutgoingBitrate: 3_600_000,
    peerCount: 1,
  });
  const recovered = evaluateCaptureAdaptation(firstProbe, 'performance', {
    captureFps: 57,
    framesPerSecond: 57,
    averageEncodeTimeMs: 2,
    availableOutgoingBitrate: 6_000_000,
    peerCount: 1,
  });
  assert.equal(firstProbe.recoveryProbeActive, true);
  assert.equal(recovered.level, 1);
  assert.equal(recovered.scale, 4 / 3);
  assert.equal(recovered.reason, 'recovery');
  assert.equal(recovered.recoveryProbeActive, false);
  assert.equal(recovered.recoveryProbeSamples, 0);
  assert.equal(recovered.recoveryProbeCooldownSamples, 0);
});

test('spatial recovery probe aborts when transport pressure appears', () => {
  const state = evaluateCaptureAdaptation({
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    sampleCount: 14,
    stableSamples: SCREEN_SHARE_PROFILES.performance.recoverySamples,
    recoveryProbeActive: true,
    recoveryProbeSamples: 3,
    recoveryProbeMaxBitrate: 5_500_000,
    recoveryProbeReason: 'insufficient-next-point-headroom',
  }, 'performance', {
    captureFps: 57,
    framesPerSecond: 57,
    averageEncodeTimeMs: 2,
    availableOutgoingBitrate: 6_000_000,
    packetLossRatio: 0.03,
  });
  assert.equal(state.recoveryProbeActive, false);
  assert.equal(state.recoveryProbeSamples, 0);
  assert.equal(state.recoveryProbeCooldownSamples, 2);
  assert.equal(state.recoveryProbeMaxBitrate, null);
  assert.equal(state.networkPressure, true);
  assert.equal(state.level, 2);
  assert.equal(state.temporalLevel, 0);
  assert.equal(state.cooldownSamples, 3);
});

test('normal network adaptation remains active during probe retry cooldown', () => {
  let state = {
    ...initialCaptureAdaptation('performance'),
    level: 1,
    scale: 4 / 3,
    sampleCount: 20,
    stableSamples: SCREEN_SHARE_PROFILES.performance.recoverySamples,
    fpsEma: 57,
    recoveryProbeCooldownSamples: RECOVERY_PROBE_COOLDOWN_SAMPLES,
  };
  for (let sample = 0; sample < 4; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', {
      captureFps: 57,
      framesPerSecond: 57,
      averageEncodeTimeMs: 2,
      availableOutgoingBitrate: 1_000_000,
      peerCount: 1,
    });
  }
  assert.equal(state.level, 2);
  assert.equal(state.reason, 'network-spatial-downshift');
  assert.equal(state.recoveryProbeActive, false);
  assert.equal(state.recoveryProbeCooldownSamples, RECOVERY_PROBE_COOLDOWN_SAMPLES - 4);
});

test('level zero and temporal degradation never start a spatial recovery probe', () => {
  const healthyLevelZero = evaluateCaptureAdaptation({
    ...initialCaptureAdaptation('performance'),
    sampleCount: 4,
    stableSamples: SCREEN_SHARE_PROFILES.performance.recoverySamples - 1,
  }, 'performance', {
    captureFps: 57,
    framesPerSecond: 57,
    averageEncodeTimeMs: 2,
    availableOutgoingBitrate: 20_000_000,
  });
  const temporal = evaluateCaptureAdaptation({
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    temporalLevel: 1,
    frameRate: 30,
    sampleCount: 4,
    stableSamples: SCREEN_SHARE_PROFILES.performance.recoverySamples - 1,
  }, 'performance', {
    captureFps: 30,
    framesPerSecond: 30,
    averageEncodeTimeMs: 2,
    availableOutgoingBitrate: 1_000_000,
  });
  assert.equal(healthyLevelZero.recoveryProbeActive, false);
  assert.equal(temporal.recoveryProbeActive, false);
});

test('sender bitrate recovers gradually instead of following noisy estimates in bursts', async () => {
  const sender = fakeSender();
  sender.parameters.encodings[0].maxBitrate = 2_000_000;
  sender.parameters.encodings[0].maxFramerate = 60;
  await adaptVideoSender(sender, 'performance', 1, { availableOutgoingBitrate: 20_000_000 });
  assert.equal(sender.parameters.encodings[0].maxBitrate, 2_800_000);
});

test('sender applies the spatial probe cap without changing scale or cadence', async () => {
  const sender = fakeSender();
  sender.parameters.encodings[0].maxBitrate = 2_000_000;
  sender.parameters.encodings[0].scaleResolutionDownBy = 2;
  sender.parameters.encodings[0].maxFramerate = 60;
  await adaptVideoSender(sender, 'performance', 1, {
    availableOutgoingBitrate: 3_600_000,
    adaptationScale: 2,
    targetFrameRate: 60,
    networkPressure: false,
    transportPressure: false,
    recoveryProbeActive: true,
    recoveryProbeMaxBitrate: 5_500_000,
    startupBitrateGuardActive: true,
    allowBitrateIncrease: false,
  });
  assert.equal(sender.parameters.encodings[0].maxBitrate, 5_500_000);
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 2);
  assert.equal(sender.parameters.encodings[0].maxFramerate, 60);
});

test('spatial probe cap preserves per-peer mesh bitrate math', () => {
  assert.equal(screenShareRecoveryProbeBitrate('performance', 1, 4 / 3), 5_500_000);
  assert.equal(screenShareRecoveryProbeBitrate('performance', 3, 4 / 3), 2_650_000);
});

test('sender coalesces bitrate-only recovery updates to avoid keyframe churn', async () => {
  const sender = fakeSender();
  await configureVideoSender(sender, 'performance', 1);
  sender.parameters.encodings[0].maxBitrate = 2_000_000;
  await adaptVideoSender(sender, 'performance', 1, {
    availableOutgoingBitrate: 20_000_000,
    allowBitrateIncrease: false,
  });
  assert.equal(sender.parameters.encodings[0].maxBitrate, 2_000_000);
});

test('structural recovery applies its matching bitrate despite the coalescing window', async () => {
  const sender = fakeSender();
  sender.parameters.encodings[0].maxBitrate = 2_000_000;
  sender.parameters.encodings[0].scaleResolutionDownBy = 2;
  await adaptVideoSender(sender, 'performance', 1, {
    availableOutgoingBitrate: 10_000_000,
    adaptationScale: 4 / 3,
    allowBitrateIncrease: false,
  });
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 4 / 3);
  assert.equal(sender.parameters.encodings[0].maxBitrate, 4_500_000);
});

test('spatial rollback restores its safe measured bitrate without a long quality ramp', async () => {
  const sender = fakeSender();
  sender.parameters.encodings[0].maxBitrate = 2_128_061;
  sender.parameters.encodings[0].scaleResolutionDownBy = 2;
  await adaptVideoSender(sender, 'performance', 1, {
    availableOutgoingBitrate: 10_000_000,
    adaptationScale: 4 / 3,
  });
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 4 / 3);
  assert.equal(sender.parameters.encodings[0].maxBitrate, 4_500_000);
});

test('small capacity dips stay inside the sender bitrate hysteresis', async () => {
  const sender = fakeSender();
  sender.parameters.encodings[0].maxBitrate = 4_000_000;
  await adaptVideoSender(sender, 'performance', 1, {
    availableOutgoingBitrate: 5_000_000,
    adaptationScale: 1,
  });
  assert.equal(sender.parameters.encodings[0].maxBitrate, 4_000_000);
});

test('packet loss reserves retransmission headroom and triggers network protection', async () => {
  const sender = fakeSender();
  sender.parameters.encodings[0].maxBitrate = 4_000_000;
  await adaptVideoSender(sender, 'performance', 1, {
    availableOutgoingBitrate: 5_000_000,
    packetLossRatio: 0.03,
    adaptationScale: 1,
  });
  assert.equal(sender.parameters.encodings[0].maxBitrate, 3_500_000);

  let state = initialCaptureAdaptation('performance');
  for (let sample = 0; sample < 2; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', {
      captureFps: 60,
      framesPerSecond: 59,
      averageEncodeTimeMs: 3,
      availableOutgoingBitrate: 10_000_000,
      packetLossRatio: 0.03,
    });
  }
  assert.equal(state.capacityPressure, false);
  assert.equal(state.packetLossPressure, true);
  assert.equal(state.transportPressure, true);
  assert.equal(state.level, 1);
  assert.equal(state.reason, 'network-spatial-downshift');
});

test('discarded pacer packets trigger immediate protection despite bandwidth headroom', () => {
  const state = evaluateCaptureAdaptation(initialCaptureAdaptation('performance'), 'performance', {
    captureFps: 60,
    framesPerSecond: 59,
    averageEncodeTimeMs: 3,
    availableOutgoingBitrate: 10_000_000,
    packetsDiscardedOnSend: 1,
  });
  assert.equal(state.discardedPacketPressure, true);
  assert.equal(state.networkSustained, true);
  assert.equal(state.level, 1);
});

test('legacy profile ids migrate without breaking old clients or saved settings', () => {
  assert.equal(normalizeScreenShareProfileId('competitive'), 'performance');
  assert.equal(normalizeScreenShareProfileId('fluid'), 'performance');
  assert.equal(normalizeScreenShareProfileId('balanced'), 'quality');
  assert.equal(normalizeScreenShareProfileId('detail'), 'quality');
  assert.equal(normalizeScreenShareProfileId('unknown'), 'performance');
});

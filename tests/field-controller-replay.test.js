import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECOVERY_PROBE_MAX_SAMPLES,
  SCREEN_SHARE_PROFILES,
  adaptVideoSender,
  configureVideoSender,
  evaluateCaptureAdaptation,
  initialCaptureAdaptation,
} from '../src/media/screenShareProfiles.js';

function fakeSender() {
  return {
    parameters: { encodings: [{}] },
    getParameters() { return structuredClone(this.parameters); },
    async setParameters(parameters) { this.parameters = parameters; },
  };
}

const HARDWARE_ENCODER = 'MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)';

function replaySample(state, sample) {
  return evaluateCaptureAdaptation(state, 'performance', {
    captureFps: sample.captureFps,
    framesPerSecond: sample.framesPerSecond,
    averageEncodeTimeMs: sample.averageEncodeTimeMs,
    availableOutgoingBitrate: sample.availableOutgoingBitrate,
    averagePacketSendDelayMs: sample.averagePacketSendDelayMs,
    packetLossRatio: sample.packetLossRatio,
    retransmissionRatio: sample.retransmissionRatio,
    packetsDiscardedOnSend: sample.packetsDiscardedOnSend,
    qualityLimitationReason: 'none',
    peerCount: 1,
    encoderImplementation: HARDWARE_ENCODER,
    powerEfficientEncoder: true,
    sourceWidth: 1280,
    sourceHeight: 720,
  });
}

async function replaySender(samples) {
  const sender = fakeSender();
  await configureVideoSender(sender, 'performance', 1);
  let state = initialCaptureAdaptation('performance');
  const states = [];

  for (const sample of samples) {
    state = replaySample(state, sample);
    states.push(state);
    await adaptVideoSender(sender, 'performance', 1, {
      ...sample,
      adaptationScale: state.scale,
      targetFrameRate: state.frameRate,
      startupBitrateGuardActive: state.startupBitrateGuardActive,
      sourceWidth: 1280,
      sourceHeight: 720,
    });
  }

  return { sender, states };
}

test('TEST 1 replay probe reproduces A1 and A2 without encoding a startup policy', async () => {
  const a1 = await replaySender([
    { captureFps: 55, framesPerSecond: 55, averageEncodeTimeMs: 3, availableOutgoingBitrate: 123_000, averagePacketSendDelayMs: 0 },
    { captureFps: 55, framesPerSecond: 18.7, averageEncodeTimeMs: 3, availableOutgoingBitrate: 171_000, averagePacketSendDelayMs: 688 },
    { captureFps: 55, framesPerSecond: 8, averageEncodeTimeMs: 3, availableOutgoingBitrate: 195_000, averagePacketSendDelayMs: 792 },
    { captureFps: 55, framesPerSecond: 12.7, averageEncodeTimeMs: 3, availableOutgoingBitrate: 219_000, averagePacketSendDelayMs: 636 },
  ]);
  assert.deepEqual(a1.states.map((state) => state.level), [0, 0, 0, 1]);
  assert.equal(a1.states[0].startupBitrateGuardActive, true);
  assert.equal(a1.states[1].transportPressure, true);
  assert.equal(a1.sender.parameters.encodings[0].maxBitrate < 8_000_000, true);

  const a2 = await replaySender([
    { captureFps: 47, framesPerSecond: 47, averageEncodeTimeMs: 0, availableOutgoingBitrate: 8_000_000, averagePacketSendDelayMs: 0 },
    { captureFps: 57.9, framesPerSecond: 45.9, averageEncodeTimeMs: 2.9, availableOutgoingBitrate: 8_300_000, averagePacketSendDelayMs: 275 },
    { captureFps: 57.4, framesPerSecond: 52.7, averageEncodeTimeMs: 4.4, availableOutgoingBitrate: 9_170_000, averagePacketSendDelayMs: 117 },
    { captureFps: 56.7, framesPerSecond: 42, averageEncodeTimeMs: 3.8, availableOutgoingBitrate: 9_310_000, averagePacketSendDelayMs: 0 },
  ]);
  assert.equal(a2.states[1].networkRecoveryHeadroomRatio > 1, true);
  assert.equal(a2.states[2].transportPressure, true);
  assert.equal(a2.states[2].startupPacerOnly, true);
  assert.equal(a2.states[2].level, 0);
  assert.equal(a2.states[3].level, 1);
  assert.equal(a2.states[3].reason, 'encoder-fps-severe');
});

test('TEST 2: source-limited recovery must not promote without next-point capacity', () => {
  const result = evaluateCaptureAdaptation({
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    sampleCount: 10,
    sourceSamples: 1,
    cooldownSamples: 0,
    fpsEma: 49,
    encodeEma: 3.5,
  }, 'performance', {
    captureFps: 49,
    framesPerSecond: 48,
    averageEncodeTimeMs: 3.5,
    availableOutgoingBitrate: 4_500_000,
    peerCount: 1,
    qualityLimitationReason: 'none',
    encoderImplementation: HARDWARE_ENCODER,
    powerEfficientEncoder: true,
  });

  assert.equal(result.sourceLimited, true);
  assert.equal(result.networkRecoveryReady, false);
  assert.equal(result.recoveryProbeActive, true);
  assert.equal(
    result.level,
    2,
    'source-limited recovery promoted to a richer spatial point without 1.12x next-point headroom',
  );
});

test('TEST 3: 57 capture / 55.5 encode must accumulate recovery health', () => {
  let state = {
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    sampleCount: 20,
    fpsEma: 55.5,
    encodeEma: 2.8,
  };
  const samples = SCREEN_SHARE_PROFILES.performance.recoverySamples + 1;
  for (let sample = 0; sample < samples; sample += 1) {
    state = replaySample(state, {
      captureFps: 57,
      framesPerSecond: 55.5,
      averageEncodeTimeMs: 2.8,
      availableOutgoingBitrate: 3_600_000,
      averagePacketSendDelayMs: 0,
    });
  }

  assert.deepEqual(
    {
      currentOperatingPointHealthy: state.currentOperatingPointHealthy,
      stableSamplesReached: state.stableSamples >= SCREEN_SHARE_PROFILES.performance.recoverySamples,
      recoveryProbeActive: state.recoveryProbeActive,
    },
    {
      currentOperatingPointHealthy: true,
      stableSamplesReached: true,
      recoveryProbeActive: true,
    },
    'health based on source-delivery ratio should allow recovery probing without accepting encoder frame loss',
  );
});

test('source-limited recovery promotes when the next point has demonstrated headroom', () => {
  const result = evaluateCaptureAdaptation({
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    sampleCount: 10,
    sourceSamples: 1,
    cooldownSamples: 0,
    fpsEma: 49,
    encodeEma: 3.5,
  }, 'performance', {
    captureFps: 49,
    framesPerSecond: 48,
    averageEncodeTimeMs: 3.5,
    availableOutgoingBitrate: 6_000_000,
    peerCount: 1,
    qualityLimitationReason: 'none',
    encoderImplementation: HARDWARE_ENCODER,
    powerEfficientEncoder: true,
  });

  assert.equal(result.sourceLimited, true);
  assert.equal(result.networkRecoveryReady, true);
  assert.equal(result.level, 1);
  assert.equal(result.reason, 'source-limited-recovery');
  assert.equal(result.recoveryProbeActive, false);
});

test('source-limited recovery probe is finite and promotes only after capacity appears', () => {
  let state = evaluateCaptureAdaptation({
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    sampleCount: 10,
    sourceSamples: 1,
    cooldownSamples: 0,
    fpsEma: 49,
    encodeEma: 3.5,
  }, 'performance', {
    captureFps: 49,
    framesPerSecond: 48,
    averageEncodeTimeMs: 3.5,
    availableOutgoingBitrate: 3_600_000,
    peerCount: 1,
  });

  assert.equal(state.level, 2);
  assert.equal(state.recoveryProbeActive, true);
  assert.equal(state.recoveryProbeSamples, 0);

  for (let sample = 0; sample < RECOVERY_PROBE_MAX_SAMPLES; sample += 1) {
    state = evaluateCaptureAdaptation(state, 'performance', {
      captureFps: 49,
      framesPerSecond: 48,
      averageEncodeTimeMs: 3.5,
      availableOutgoingBitrate: 3_600_000,
      peerCount: 1,
    });
  }

  assert.equal(state.level, 2);
  assert.equal(state.recoveryProbeActive, false);
  assert.equal(state.recoveryProbeSamples, 0);
  assert.equal(state.recoveryProbeReason, 'spatial-recovery-probe-timeout');
  assert.equal(state.recoveryProbeCooldownSamples, 10);

  state = evaluateCaptureAdaptation(state, 'performance', {
    captureFps: 49,
    framesPerSecond: 48,
    averageEncodeTimeMs: 3.5,
    availableOutgoingBitrate: 6_000_000,
    peerCount: 1,
  });
  assert.equal(state.networkRecoveryReady, true);
  assert.equal(state.level, 1);
  assert.equal(state.reason, 'source-limited-recovery');
});

test('source-limited recovery probe aborts and holds when network pressure appears', () => {
  const state = evaluateCaptureAdaptation({
    ...initialCaptureAdaptation('performance'),
    level: 2,
    scale: 2,
    sampleCount: 10,
    sourceSamples: 2,
    fpsEma: 49,
    encodeEma: 3.5,
    recoveryProbeActive: true,
    recoveryProbeSamples: 3,
    recoveryProbeMaxBitrate: 5_500_000,
    recoveryProbeReason: 'insufficient-next-point-headroom',
  }, 'performance', {
    captureFps: 49,
    framesPerSecond: 48,
    averageEncodeTimeMs: 3.5,
    availableOutgoingBitrate: 6_000_000,
    packetLossRatio: 0.03,
    peerCount: 1,
  });

  assert.equal(state.networkPressure, true);
  assert.equal(state.recoveryProbeActive, false);
  assert.equal(state.recoveryProbeMaxBitrate, null);
  assert.equal(state.recoveryProbeAbortReason, 'transport-or-network-pressure');
  assert.equal(state.level, 2);
});

test('startup pacer-only pressure does not bypass the sender bitrate guard', async () => {
  const sender = fakeSender();
  await configureVideoSender(sender, 'performance', 1);
  await adaptVideoSender(sender, 'performance', 1, {
    availableOutgoingBitrate: 8_300_000,
    averagePacketSendDelayMs: 275,
    adaptationScale: 1,
    targetFrameRate: 60,
    startupBitrateGuardActive: true,
  });

  assert.equal(sender.parameters.encodings[0].maxBitrate, 8_000_000);
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 1);
});

test('hard transport pressure can still bypass the startup bitrate guard', async () => {
  const pressureCases = [
    { packetLossRatio: 0.03 },
    { retransmissionRatio: 0.10 },
    { packetsDiscardedOnSend: 1 },
  ];
  for (const pressure of pressureCases) {
    const sender = fakeSender();
    await configureVideoSender(sender, 'performance', 1);
    await adaptVideoSender(sender, 'performance', 1, {
      availableOutgoingBitrate: 8_300_000,
      adaptationScale: 1,
      targetFrameRate: 60,
      startupBitrateGuardActive: true,
      ...pressure,
    });
    assert.ok(sender.parameters.encodings[0].maxBitrate < 8_000_000, JSON.stringify(pressure));
  }
});

test('low capacity is not classified as healthy during startup pacer analysis', () => {
  const state = evaluateCaptureAdaptation(initialCaptureAdaptation('performance'), 'performance', {
    captureFps: 60,
    framesPerSecond: 60,
    averageEncodeTimeMs: 3,
    availableOutgoingBitrate: 750_000,
    averagePacketSendDelayMs: 0,
    peerCount: 1,
  });

  assert.equal(state.capacityPressure, true);
  assert.equal(state.currentOperatingPointHealthy, false);
  assert.equal(state.startupPacerOnly, false);
});

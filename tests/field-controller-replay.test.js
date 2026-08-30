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

// These are deliberately small, copied from the sender artifacts rather than
// loading the untracked field logs at test time. The state seed is the replay
// state immediately before the 81f probe at 40.9s.
const WHOLE_SCREEN_81F_PRE_PROBE_STATE = {
  ...initialCaptureAdaptation('performance'),
  level: 2,
  scale: 2,
  sampleCount: 28,
  stableSamples: 9,
  fpsEma: 55.6036996140016,
  encodeEma: 2.733954586524782,
};

const WHOLE_SCREEN_81F_PROBE_SAMPLES = [
  {
    elapsedMs: 42_403.5,
    captureFps: 57.36227588789917,
    framesPerSecond: 56.69527267990034,
    averageEncodeTimeMs: 2.7294117647058744,
    availableOutgoingBitrate: 4_269_985,
    averagePacketSendDelayMs: 1.9305353982299012,
    packetLossRatio: 0,
    retransmissionRatio: 0,
    packetsDiscardedOnSend: 0,
  },
  {
    elapsedMs: 43_904.2,
    captureFps: 57.34626050957125,
    framesPerSecond: 39.34220197749656,
    averageEncodeTimeMs: 2.6610169491524824,
    availableOutgoingBitrate: 5_390_275,
    averagePacketSendDelayMs: 90.98822657580915,
    packetLossRatio: 0,
    retransmissionRatio: 0,
    packetsDiscardedOnSend: 0,
  },
];

const A1_REUSED_PC_STARTUP_SAMPLES = [
  {
    elapsedMs: 1_229.3,
    captureFps: 55,
    framesPerSecond: 17,
    averageEncodeTimeMs: null,
    availableOutgoingBitrate: 581_037,
    averagePacketSendDelayMs: null,
    packetLossRatio: null,
    retransmissionRatio: null,
    packetsDiscardedOnSend: null,
  },
  {
    elapsedMs: 2_730.9,
    captureFps: 54.633996532672356,
    framesPerSecond: 54.633996532672356,
    averageEncodeTimeMs: 3.0976,
    availableOutgoingBitrate: 4_440_010,
    averagePacketSendDelayMs: 70.43365794392523,
    packetLossRatio: 0,
    retransmissionRatio: 0,
    packetsDiscardedOnSend: 0,
  },
  {
    elapsedMs: 4_230.1,
    captureFps: 54.659416109353984,
    framesPerSecond: 54.659416109353984,
    averageEncodeTimeMs: 2.5732,
    availableOutgoingBitrate: 4_737_872,
    averagePacketSendDelayMs: 65.51263951120158,
    packetLossRatio: 0,
    retransmissionRatio: 0,
    packetsDiscardedOnSend: 0,
  },
  {
    elapsedMs: 5_728.9,
    captureFps: 54.02228947002059,
    framesPerSecond: 54.02228947002059,
    averageEncodeTimeMs: 2.4444,
    availableOutgoingBitrate: 4_737_872,
    averagePacketSendDelayMs: 2.859329694323145,
    packetLossRatio: 0,
    retransmissionRatio: 0,
    packetsDiscardedOnSend: 0,
  },
  {
    elapsedMs: 7_230.4,
    captureFps: 54.003744400246504,
    framesPerSecond: 54.003744400246504,
    averageEncodeTimeMs: 2.4938,
    availableOutgoingBitrate: 5_311_389,
    averagePacketSendDelayMs: 106.04855095184773,
    packetLossRatio: 0,
    retransmissionRatio: 0,
    packetsDiscardedOnSend: 0,
  },
  {
    elapsedMs: 8_728.9,
    captureFps: 55.34311566139458,
    framesPerSecond: 54.67633113535368,
    averageEncodeTimeMs: 2.5122,
    availableOutgoingBitrate: 5_766_933,
    averagePacketSendDelayMs: 8.713948179271657,
    packetLossRatio: 0,
    retransmissionRatio: 0,
    packetsDiscardedOnSend: 0,
  },
  {
    elapsedMs: 10_229.2,
    captureFps: 54.6505223473209,
    framesPerSecond: 49.985233854256926,
    averageEncodeTimeMs: 2.48,
    availableOutgoingBitrate: 3_975_913,
    averagePacketSendDelayMs: 0.110793103448357,
    packetLossRatio: 0,
    retransmissionRatio: 0,
    packetsDiscardedOnSend: 0,
  },
  {
    elapsedMs: 11_730.3,
    captureFps: 55.34846767996458,
    framesPerSecond: 55.34846767996458,
    averageEncodeTimeMs: 2.4458,
    availableOutgoingBitrate: 3_975_913,
    averagePacketSendDelayMs: 14.557732142857153,
    packetLossRatio: 0,
    retransmissionRatio: 0,
    packetsDiscardedOnSend: 0,
  },
];

const A1_6F98_SEVERE_STARTUP_SAMPLES = [
  {
    elapsedMs: 1_200,
    captureFps: 47,
    framesPerSecond: 1,
    averageEncodeTimeMs: 1,
    availableOutgoingBitrate: 225_884,
    averagePacketSendDelayMs: null,
  },
  {
    elapsedMs: 2_700,
    captureFps: 49.9925,
    framesPerSecond: 19.3304,
    averageEncodeTimeMs: 2.6,
    availableOutgoingBitrate: 367_231,
    averagePacketSendDelayMs: 455.2216,
  },
  {
    elapsedMs: 4_200,
    captureFps: 52.0027,
    framesPerSecond: 22.6678,
    averageEncodeTimeMs: 2.8,
    availableOutgoingBitrate: 412_160,
    averagePacketSendDelayMs: 85.4689,
  },
  {
    elapsedMs: 5_700,
    captureFps: 51.3339,
    framesPerSecond: 9.3334,
    averageEncodeTimeMs: 2.8,
    availableOutgoingBitrate: 448_855,
    averagePacketSendDelayMs: 3.9565,
  },
];

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
  const maxBitrates = [];

  for (const sample of samples) {
    state = replaySample(state, sample);
    states.push(state);
    await adaptVideoSender(sender, 'performance', 1, {
      ...sample,
      adaptationScale: state.scale,
      targetFrameRate: state.frameRate,
      startupBitrateGuardActive: state.startupBitrateGuardActive,
      startupExplorationActive: state.startupExplorationActive,
      sourceWidth: 1280,
      sourceHeight: 720,
    });
    maxBitrates.push(sender.parameters.encodings[0].maxBitrate);
  }

  return { sender, states, maxBitrates };
}

test('TEST 1 replay probe reproduces A1 and A2 without encoding a startup policy', async () => {
  const a1 = await replaySender([
    { captureFps: 55, framesPerSecond: 55, averageEncodeTimeMs: 3, availableOutgoingBitrate: 123_000, averagePacketSendDelayMs: 0 },
    { captureFps: 55, framesPerSecond: 18.7, averageEncodeTimeMs: 3, availableOutgoingBitrate: 171_000, averagePacketSendDelayMs: 688 },
    { captureFps: 55, framesPerSecond: 8, averageEncodeTimeMs: 3, availableOutgoingBitrate: 195_000, averagePacketSendDelayMs: 792 },
    { captureFps: 55, framesPerSecond: 12.7, averageEncodeTimeMs: 3, availableOutgoingBitrate: 219_000, averagePacketSendDelayMs: 636 },
  ]);
  assert.deepEqual(a1.states.map((state) => state.level), [0, 0, 0, 0]);
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

test('81f field replay tolerates the first probe pacer-only excursion', () => {
  const probeStart = replaySample(
    WHOLE_SCREEN_81F_PRE_PROBE_STATE,
    WHOLE_SCREEN_81F_PROBE_SAMPLES[0],
  );
  const observedTransient = replaySample(probeStart, WHOLE_SCREEN_81F_PROBE_SAMPLES[1]);

  assert.equal(probeStart.recoveryProbeActive, true);
  assert.equal(probeStart.networkRecoveryHeadroomRatio < 1, true);
  assert.equal(observedTransient.recoveryProbeActive, true);
  assert.equal(observedTransient.recoveryProbeAbortReason, null);
  assert.equal(observedTransient.hardTransportPressure, false);
  assert.equal(observedTransient.softTransportPressure, true);
  assert.equal(observedTransient.transportPressure, true);
  assert.equal(observedTransient.recoveryProbeStressSamples, 1);
  assert.equal(observedTransient.packetLossRatio, 0);
  assert.equal(observedTransient.retransmissionRatio, 0);
  assert.equal(observedTransient.packetsDiscardedOnSend, 0);
  assert.equal(observedTransient.averagePacketSendDelayMs > 80, true);

  const recovered = replaySample(observedTransient, {
    ...WHOLE_SCREEN_81F_PROBE_SAMPLES[0],
    framesPerSecond: 56,
    averageEncodeTimeMs: 2.8,
    availableOutgoingBitrate: 6_000_000,
    averagePacketSendDelayMs: 0,
  });
  assert.equal(recovered.recoveryProbeActive, false);
  assert.equal(recovered.level, 1);
  assert.equal(recovered.reason, 'recovery');
});

test('81f probe replay counterfactuals separate hard, soft, persistent and capacity cases', () => {
  const probeStart = replaySample(
    WHOLE_SCREEN_81F_PRE_PROBE_STATE,
    WHOLE_SCREEN_81F_PROBE_SAMPLES[0],
  );
  const sample = WHOLE_SCREEN_81F_PROBE_SAMPLES[1];

  const hardAbort = replaySample(probeStart, { ...sample, packetLossRatio: 0.03 });
  assert.equal(hardAbort.recoveryProbeActive, false);
  assert.equal(hardAbort.hardTransportPressure, true);
  assert.equal(hardAbort.recoveryProbeAbortReason, 'transport-or-network-pressure');

  const persistentPacerSample = replaySample(probeStart, {
    ...sample,
    framesPerSecond: 56,
    averageEncodeTimeMs: 2.8,
    averagePacketSendDelayMs: 50,
  });
  const persistentPacerAbort = replaySample(persistentPacerSample, {
    ...sample,
    framesPerSecond: 56,
    averageEncodeTimeMs: 2.8,
    averagePacketSendDelayMs: 50,
  });
  assert.equal(persistentPacerSample.recoveryProbeActive, true);
  assert.equal(persistentPacerSample.recoveryProbeStressSamples, 1);
  assert.equal(persistentPacerAbort.recoveryProbeActive, false);
  assert.equal(persistentPacerAbort.hardTransportPressure, false);
  assert.equal(persistentPacerAbort.transportPressure, true);
  assert.equal(persistentPacerAbort.recoveryProbeAbortReason, 'transport-or-network-pressure');

  let insufficient = probeStart;
  for (let sampleIndex = 0; sampleIndex < RECOVERY_PROBE_MAX_SAMPLES; sampleIndex += 1) {
    insufficient = replaySample(insufficient, {
      ...sample,
      framesPerSecond: 56,
      averageEncodeTimeMs: 2.8,
      availableOutgoingBitrate: 3_000_000,
      averagePacketSendDelayMs: 0,
    });
  }
  assert.equal(insufficient.recoveryProbeActive, false);
  assert.equal(insufficient.recoveryProbeReason, 'spatial-recovery-probe-timeout');

  const degradedSample = replaySample(probeStart, {
    ...sample,
    framesPerSecond: 40,
    averageEncodeTimeMs: 2.5,
    averagePacketSendDelayMs: 0,
  });
  const degradedAbort = replaySample(degradedSample, {
    ...sample,
    framesPerSecond: 40,
    averageEncodeTimeMs: 2.5,
    averagePacketSendDelayMs: 0,
  });
  assert.equal(degradedSample.recoveryProbeActive, true);
  assert.equal(degradedSample.recoveryProbeStressSamples, 1);
  assert.equal(degradedAbort.recoveryProbeActive, false);
  assert.equal(degradedAbort.recoveryProbeAbortReason, 'current-operating-point-unhealthy');

  const capacityDiscovered = replaySample(probeStart, {
    ...sample,
    framesPerSecond: 56,
    averageEncodeTimeMs: 2.8,
    availableOutgoingBitrate: 6_000_000,
    averagePacketSendDelayMs: 0,
  });
  assert.equal(capacityDiscovered.recoveryProbeActive, false);
  assert.equal(capacityDiscovered.level, 1);
  assert.equal(capacityDiscovered.reason, 'recovery');
});

test('A1 reused-PC startup replay bounds exploration during estimator recovery', async () => {
  const { states, maxBitrates } = await replaySender(A1_REUSED_PC_STARTUP_SAMPLES);

  assert.deepEqual(states.map((next) => next.level), [0, 0, 0, 1, 1, 1, 1, 2]);
  assert.equal(states[0].networkRecoveryHeadroomRatio < 0.1, true);
  assert.equal(states[1].networkPressure, true);
  assert.equal(states[1].hardTransportPressure, false);
  assert.equal(states[1].startupStructuralHold, true);
  assert.equal(states[1].transportPressure, true);
  assert.equal(states[5].currentOperatingPointHealthy, true);
  assert.equal(states[4].averagePacketSendDelayMs > 100, true);
  assert.equal(states[7].level, 2);
  assert.equal(states[7].hardTransportPressure, false);
  assert.equal(states[7].networkRecoveryHeadroomRatio < 0.6, true);
  assert.equal(maxBitrates[0] > A1_REUSED_PC_STARTUP_SAMPLES[0].availableOutgoingBitrate * 2, true);
  assert.equal(maxBitrates.slice(0, 3).every((bitrate) => bitrate < 8_000_000), true);
  assert.equal(maxBitrates[0] < 4_000_000, true);
});

test('6f98 severe startup does not blind-cap or structurally collapse on its first soft sample', async () => {
  const { states, maxBitrates } = await replaySender(A1_6F98_SEVERE_STARTUP_SAMPLES);

  assert.equal(states[0].startupExplorationActive, true);
  assert.equal(states[1].softTransportPressure, true);
  assert.equal(states[1].hardTransportPressure, false);
  assert.equal(states[1].level, 0);
  assert.equal(states[2].level, 0);
  assert.equal(maxBitrates[0] > A1_6F98_SEVERE_STARTUP_SAMPLES[0].availableOutgoingBitrate * 2, true);
  assert.equal(maxBitrates[0] < 8_000_000, true);
  assert.equal(states[3].startupBitrateGuardActive, false);
});

test('really low startup capacity eventually downshifts after bounded exploration', () => {
  let state = initialCaptureAdaptation('performance');
  for (let sample = 0; sample < 7; sample += 1) {
    state = replaySample(state, {
      captureFps: 60,
      framesPerSecond: 60,
      averageEncodeTimeMs: 3,
      availableOutgoingBitrate: 750_000,
      averagePacketSendDelayMs: 0,
    });
  }

  assert.equal(state.startupBitrateGuardActive, false);
  assert.equal(state.startupExplorationActive, false);
  assert.ok(state.level > 0 || state.temporalLevel > 0);
  assert.equal(state.hardTransportPressure, false);
});

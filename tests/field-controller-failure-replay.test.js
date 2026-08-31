import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateCaptureAdaptation,
  initialCaptureAdaptation,
} from '../src/media/screenShareProfiles.js';

const HARDWARE_ENCODER = 'MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)';

function fieldSample(overrides = {}) {
  return {
    captureFps: 57.3,
    framesPerSecond: 56,
    averageEncodeTimeMs: 2.8,
    availableOutgoingBitrate: 6_000_000,
    averagePacketSendDelayMs: 0,
    packetLossRatio: 0,
    retransmissionRatio: 0,
    packetsDiscardedOnSend: 0,
    qualityLimitationReason: 'none',
    peerCount: 1,
    encoderImplementation: HARDWARE_ENCODER,
    powerEfficientEncoder: true,
    ...overrides,
  };
}

function replay(state, sample) {
  return evaluateCaptureAdaptation(state, 'performance', fieldSample(sample));
}

const PRE_PROBE_360P = {
  ...initialCaptureAdaptation('performance'),
  level: 2,
  scale: 2,
  sampleCount: 28,
  stableSamples: 9,
  fpsEma: 55.6036996140016,
  encodeEma: 2.733954586524782,
};

test('field replay A: non-actionable network pressure is misreported as encoder FPS failure', () => {
  const state = replay({
    ...initialCaptureAdaptation('performance'),
    level: 1,
    scale: 4 / 3,
    sampleCount: 40,
    fpsEma: 57,
    encodeEma: 3,
  }, {
    captureFps: 57.30,
    framesPerSecond: 25.32,
    averageEncodeTimeMs: 3.08,
    availableOutgoingBitrate: 3_672_000,
    averagePacketSendDelayMs: 14.5,
  });

  assert.equal(state.networkPressure, true);
  assert.equal(state.transportPressure, true);
  assert.equal(state.hardTransportPressure, false);
  assert.equal(state.packetLossRatio, 0);
  assert.equal(state.retransmissionRatio, 0);
  assert.equal(state.networkSamples, 1);
  assert.equal(state.pressureSamplesRequired, 2);
  assert.equal(state.networkSustained, false);
  assert.equal(state.bottleneck, 'network');
  assert.equal(state.encoderDeliveryRatio < 0.45, true);
  assert.equal(state.reason, 'encoder-fps-severe');
  assert.equal(state.level, 2);
});

test('field replay A: network bottleneck can reach encoder-prefixed decision families', () => {
  const base = {
    ...initialCaptureAdaptation('performance'),
    level: 1,
    scale: 4 / 3,
    sampleCount: 40,
    networkSamples: 0,
    fpsEma: 57,
    encodeEma: 3,
  };

  const severe = replay(base, {
    captureFps: 57.3,
    framesPerSecond: 25.32,
    averageEncodeTimeMs: 3.08,
    availableOutgoingBitrate: 3_672_000,
    averagePacketSendDelayMs: 14.5,
  });
  assert.equal(severe.bottleneck, 'network');
  assert.equal(severe.reason, 'encoder-fps-severe');

  const encodeSevere = replay({ ...base, encodeEma: 16 }, {
    captureFps: 57.3,
    framesPerSecond: 56,
    averageEncodeTimeMs: 20,
    availableOutgoingBitrate: 3_672_000,
    averagePacketSendDelayMs: 0,
  });
  assert.equal(encodeSevere.bottleneck, 'network');
  assert.equal(encodeSevere.reason, 'encode-severe');

  const moderate = replay({ ...base, poorSamples: 1 }, {
    captureFps: 57.3,
    framesPerSecond: 50,
    averageEncodeTimeMs: 3.08,
    availableOutgoingBitrate: 3_672_000,
    averagePacketSendDelayMs: 0,
  });
  assert.equal(moderate.bottleneck, 'network');
  assert.equal(moderate.reason, 'encoder-fps');

  const observingTrial = replay({
    ...base,
    level: 2,
    scale: 2,
    encoderTrial: {
      triggerReason: 'encoder-fps-severe',
      fromLevel: 1,
      toLevel: 2,
      samplesObserved: 0,
      baselineDeliveryRatio: 0.44,
      baselineEncodeTimeMs: 3.08,
      baselineEncodeBudgetMs: 1000 / 60,
      deliverySum: 0,
      deliverySamples: 0,
      encodeTimeSum: 0,
      encodeTimeSamples: 0,
    },
  }, {
    captureFps: 57.3,
    framesPerSecond: 25.32,
    averageEncodeTimeMs: 3.08,
    availableOutgoingBitrate: 3_672_000,
    averagePacketSendDelayMs: 14.5,
  });
  assert.equal(observingTrial.bottleneck, 'network');
  assert.equal(observingTrial.reason, 'encoder-downscale-observation');

  const canceledTrial = replay({
    ...base,
    level: 2,
    scale: 2,
    encoderTrial: {
      ...observingTrial.encoderTrial,
      fromLevel: 1,
      toLevel: 1,
    },
  }, {
    availableOutgoingBitrate: 1_000_000,
  });
  assert.equal(canceledTrial.bottleneck, 'network');
  assert.equal(canceledTrial.reason, 'encoder-downscale-observation-canceled');

  const temporalSevere = replay({ ...base, level: 2, scale: 2 }, {
    framesPerSecond: 25.32,
    availableOutgoingBitrate: 1_000_000,
  });
  assert.equal(temporalSevere.bottleneck, 'network');
  assert.equal(temporalSevere.reason, 'encoder-temporal-severe');

  const temporalModerate = replay({
    ...base,
    level: 2,
    scale: 2,
    poorSamples: 1,
  }, {
    framesPerSecond: 50,
    averageEncodeTimeMs: 3.08,
    availableOutgoingBitrate: 1_000_000,
    averagePacketSendDelayMs: 0,
  });
  assert.equal(temporalModerate.bottleneck, 'network');
  assert.equal(temporalModerate.reason, 'encoder-temporal');

  const ineffectiveHold = replay({
    ...base,
    downscaleEffectiveness: {
      status: 'ineffective',
      fromLevel: 1,
      toLevel: 2,
      baselineDeliveryRatio: 0.5,
      baselineEncodeRatio: 0.18,
    },
  }, {
    framesPerSecond: 25.32,
    availableOutgoingBitrate: 3_672_000,
  });
  assert.equal(ineffectiveHold.bottleneck, 'network');
  assert.equal(ineffectiveHold.reason, 'encoder-downscale-ineffective-hold');
});

test('field replay B: two soft pacer samples abort the active probe without hard evidence', () => {
  const probeStart = replay(PRE_PROBE_360P, {
    captureFps: 57.36227588789917,
    framesPerSecond: 56.69527267990034,
    averageEncodeTimeMs: 2.7294117647058744,
    availableOutgoingBitrate: 4_269_985,
    averagePacketSendDelayMs: 1.9305353982299012,
  });
  const firstSoft = replay(probeStart, {
    framesPerSecond: 56,
    averageEncodeTimeMs: 2.8,
    averagePacketSendDelayMs: 50,
  });
  const secondSoft = replay(firstSoft, {
    framesPerSecond: 56,
    averageEncodeTimeMs: 2.8,
    averagePacketSendDelayMs: 50,
  });

  assert.equal(probeStart.recoveryProbeActive, true);
  assert.equal(firstSoft.recoveryProbeActive, true);
  assert.equal(firstSoft.recoveryProbeStressSamples, 1);
  assert.equal(firstSoft.probeEncoderHealthy, true);
  assert.equal(firstSoft.currentOperatingPointHealthy, false);
  assert.equal(firstSoft.softTransportPressure, true);
  assert.equal(firstSoft.hardTransportPressure, false);
  assert.equal(firstSoft.packetLossRatio, 0);
  assert.equal(firstSoft.retransmissionRatio, 0);
  assert.equal(secondSoft.recoveryProbeActive, false);
  assert.equal(secondSoft.recoveryProbeStressSamples, 0);
  assert.equal(secondSoft.recoveryProbeAbortReason, 'transport-or-network-pressure');
  assert.equal(secondSoft.level, 2);
});

test('field replay B: transient queue also makes probe encoder health false', () => {
  const probeStart = replay(PRE_PROBE_360P, {
    captureFps: 57.36227588789917,
    framesPerSecond: 56.69527267990034,
    averageEncodeTimeMs: 2.7294117647058744,
    availableOutgoingBitrate: 4_269_985,
    averagePacketSendDelayMs: 1.9305353982299012,
  });
  const transient = replay(probeStart, {
    captureFps: 57.34626050957125,
    framesPerSecond: 39.34220197749656,
    averageEncodeTimeMs: 2.6610169491524824,
    availableOutgoingBitrate: 5_390_275,
    averagePacketSendDelayMs: 90.98822657580915,
  });

  assert.equal(transient.recoveryProbeActive, true);
  assert.equal(transient.softTransportPressure, true);
  assert.equal(transient.hardTransportPressure, false);
  assert.equal(transient.encoderDeliveryRatio < 0.70, true);
  assert.equal(transient.probeEncoderHealthy, false);
  assert.equal(transient.currentOperatingPointHealthy, false);
  assert.equal(transient.recoveryProbeStressSamples, 1);
  assert.equal(transient.recoveryProbeAbortReason, null);
});

test('field replay B: network samples collected during post-recovery cooldown cause rollback', () => {
  let state = replay(PRE_PROBE_360P, {
    captureFps: 57.36227588789917,
    framesPerSecond: 56.69527267990034,
    averageEncodeTimeMs: 2.7294117647058744,
    availableOutgoingBitrate: 4_269_985,
    averagePacketSendDelayMs: 1.9305353982299012,
  });
  state = replay(state, {
    captureFps: 57.34626050957125,
    framesPerSecond: 56,
    averageEncodeTimeMs: 2.8,
    availableOutgoingBitrate: 6_000_000,
    averagePacketSendDelayMs: 0,
  });

  assert.equal(state.level, 1);
  assert.equal(state.reason, 'recovery');
  assert.equal(state.cooldownSamples, 5);

  const pacerDelays = [7.7, 112.9, 26.1, 96, 96, 96];
  const history = [];
  for (const averagePacketSendDelayMs of pacerDelays) {
    state = replay(state, {
      framesPerSecond: 56,
      averageEncodeTimeMs: 2.8,
      availableOutgoingBitrate: 6_000_000,
      averagePacketSendDelayMs,
    });
    history.push({
      delay: averagePacketSendDelayMs,
      level: state.level,
      reason: state.reason,
      cooldownSamples: state.cooldownSamples,
      networkSamples: state.networkSamples,
      networkSustained: state.networkSustained,
    });
  }

  assert.deepEqual(history.slice(0, 4).map((sample) => sample.level), [1, 1, 1, 1]);
  assert.deepEqual(history.slice(1, 5).map((sample) => sample.networkSamples), [1, 2, 3, 0]);
  assert.equal(history[2].networkSustained, true);
  assert.equal(history[4].level, 2);
  assert.equal(history[4].reason, 'network-spatial-downshift');
  assert.equal(history[4].networkSamples, 0);
});

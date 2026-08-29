import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_SCREEN_SHARE_DIAGNOSTIC_SAMPLES,
  createScreenShareDiagnosticsSession,
  createScreenShareReceiverSample,
  createScreenShareRunContext,
  createScreenShareSenderSample,
  normalizeScreenShareDiagnosticsEnvironment,
  normalizeScreenShareRunId,
  summarizeScreenShareDiagnostics,
} from '../src/media/screenShareDiagnostics.js';

function telemetry(overrides = {}) {
  return {
    timestampMs: 1_500,
    source: { width: 2560, height: 1440 },
    outbound: {
      frameWidth: 1280,
      frameHeight: 720,
      targetBitrate: 3_000_000,
      framesEncoded: 90,
      framesSent: 88,
      packetsSent: 88,
      bytesSent: 500_000,
      encoderImplementation: 'NVIDIA H.264 MFT',
      powerEfficientEncoder: true,
      qualityLimitationReason: 'none',
    },
    inbound: {
      frameWidth: 1280,
      frameHeight: 720,
      framesReceived: 88,
      framesDecoded: 86,
      framesRendered: 84,
      framesDropped: 0,
      decoderImplementation: 'FFmpeg',
      powerEfficientDecoder: true,
      freezeCount: 0,
    },
    remoteInbound: { packetsLost: 0 },
    network: { availableOutgoingBitrate: 6_000_000, relay: false },
    derived: {
      captureFps: 60,
      encodeFps: 58,
      sendFps: 57,
      receiveFps: 56,
      decodeFps: 55,
      renderFps: 54,
      averageEncodeTimeMs: 3.2,
      averageEncodeQp: 22,
      averageDecodeTimeMs: 2.1,
      averageDecodeQp: 24,
      sendBitrateBps: 2_800_000,
      receiveBitrateBps: 2_700_000,
      averagePacketSendDelayMs: 1.4,
      averageJitterBufferDelayMs: 12,
      averageJitterBufferTargetDelayMs: 20,
      averageJitterBufferMinimumDelayMs: 8,
      currentRoundTripTimeMs: 25,
      packetLossRatio: 0,
      inboundPacketLossRatio: 0,
      retransmissionRatio: 0,
      packetsDiscardedOnSend: 0,
      keyFramesEncoded: 1,
      hugeFramesSent: 0,
      outboundNackCount: 0,
      outboundPliCount: 0,
      outboundFirCount: 0,
      inboundNackCount: 0,
      inboundPliCount: 0,
      inboundFirCount: 0,
      freezeDurationMs: 0,
    },
    ...overrides,
  };
}

function adaptation(overrides = {}) {
  return {
    level: 1,
    temporalLevel: 0,
    scale: 1.333333,
    frameRate: 60,
    requiredBitrate: 4_000_000,
    recoveryRequiredBitrate: 4_500_000,
    networkHeadroomRatio: 1.5,
    networkRecoveryHeadroomRatio: 1.33,
    networkRecoveryReady: true,
    networkPressure: false,
    transportPressure: false,
    currentOperatingPointHealthy: true,
    stableSamples: 10,
    cooldownSamples: 0,
    reason: 'stable',
    recoveryProbeActive: false,
    recoveryProbeSamples: 0,
    recoveryProbeMaxBitrate: null,
    recoveryProbeReason: null,
    encoderRecoveryReady: true,
    bottleneck: 'none',
    ...overrides,
  };
}

test('diagnostics stay disabled without the explicit Electron bridge flag', () => {
  const session = createScreenShareDiagnosticsSession({
    enabled: false,
    runId: 'run-disabled',
    role: 'sender',
  });
  assert.equal(session, null);
});

test('run context has one bounded correlation id and monotonic origin', () => {
  const first = createScreenShareRunContext({ profileId: 'performance' });
  const second = createScreenShareRunContext({ profileId: 'performance' });
  assert.ok(first.runId);
  assert.ok(second.runId);
  assert.notEqual(first.runId, second.runId);
  assert.equal(normalizeScreenShareRunId(`  ${first.runId}  `), first.runId);
  assert.equal(first.capture.profileId, 'performance');
});

test('sender and receiver sessions preserve separate participant artifacts for one run', () => {
  const run = {
    runId: 'shared-run-001',
    startedAtMs: 1_700_000_000_000,
    performanceTimeOriginMs: 1_700_000_000_000,
    monotonicStartMs: 10,
    capture: { profileId: 'performance' },
  };
  const sender = createScreenShareDiagnosticsSession({
    enabled: true, ...run, role: 'sender', participantId: 'sender-a', peerId: 'sender-a', transportMode: 'mesh',
  });
  const receiverA = createScreenShareDiagnosticsSession({
    enabled: true,
    ...run,
    role: 'receiver',
    participantId: 'receiver-a',
    peerId: 'receiver-a',
    sourcePeerId: 'sender-a',
    transportMode: 'mesh',
    startedAtMs: 1_700_000_000_900,
    correlation: { senderAnnouncedStartedAtMs: run.startedAtMs },
  });
  const receiverB = createScreenShareDiagnosticsSession({
    enabled: true, ...run, role: 'receiver', participantId: 'receiver-b', peerId: 'receiver-b', sourcePeerId: 'sender-a', transportMode: 'mesh',
  });
  [sender, receiverA, receiverB].forEach((session, index) => {
    session.recordSample({ elapsedMs: index * 100, pipeline: { captureFps: 60 } });
  });
  const senderArtifact = sender.finish('share-stopped');
  const receiverArtifactA = receiverA.finish('share-stopped');
  const receiverArtifactB = receiverB.finish('share-stopped');
  assert.equal(senderArtifact.runId, receiverArtifactA.runId);
  assert.equal(receiverArtifactA.runId, receiverArtifactB.runId);
  assert.equal(receiverArtifactA.sourcePeerId, 'sender-a');
  assert.notEqual(receiverArtifactA.participantId, receiverArtifactB.participantId);
  assert.equal(receiverArtifactA.startedAtMs, 1_700_000_000_900);
  assert.equal(receiverArtifactA.correlation.senderAnnouncedStartedAtMs, run.startedAtMs);
  assert.equal(senderArtifact.endReason, 'share-stopped');
});

test('receiver elapsed time uses local monotonic clock, never sender wall clock', () => {
  const session = createScreenShareDiagnosticsSession({
    enabled: true,
    runId: 'clock-semantics-run',
    role: 'receiver',
    startedAtMs: 2_000_000,
    performanceTimeOriginMs: 1_900_000,
    monotonicStartMs: 500,
    correlation: { senderAnnouncedStartedAtMs: 1_000_000 },
  });
  session.recordSample({ monotonicMs: 500, pipeline: { captureFps: 60 } });
  session.recordSample({ monotonicMs: 1_250, pipeline: { captureFps: 60 } });
  const artifact = session.finish('test');
  assert.equal(artifact.startedAtMs, 2_000_000);
  assert.equal(artifact.correlation.senderAnnouncedStartedAtMs, 1_000_000);
  assert.equal(artifact.samples[0].elapsedMs, 0);
  assert.equal(artifact.samples[1].elapsedMs, 750);
});

test('diagnostics capture omits arbitrary source window titles', () => {
  const session = createScreenShareDiagnosticsSession({
    enabled: true,
    runId: 'source-privacy-run',
    role: 'sender',
    capture: {
      profileId: 'performance',
      source: { id: 'window:limited-id', type: 'window', name: 'Private Window Title', title: 'Private Title' },
    },
  });
  const artifact = session.finish('test');
  const serialized = JSON.stringify(artifact);
  assert.equal(serialized.includes('Private Window Title'), false);
  assert.equal(serialized.includes('Private Title'), false);
  assert.deepEqual(artifact.capture.source, { id: 'window:limited-id', type: 'window' });
});

test('summary includes operating-point transitions and sender retention', () => {
  const artifact = createScreenShareDiagnosticsSession({
    enabled: true,
    runId: 'summary-run',
    role: 'sender',
    participantId: 'sender',
  });
  artifact.recordSample({ elapsedMs: 0, pipeline: { captureFps: 60, encodeFps: 60, sendFps: 58, averageEncodeTimeMs: 3 }, rateControl: { level: 2, temporalLevel: 0, scaleResolutionDownBy: 2, maxFramerate: 60 } });
  artifact.recordSample({ elapsedMs: 1_500, pipeline: { captureFps: 60, encodeFps: 58, sendFps: 56, averageEncodeTimeMs: 3.5 }, rateControl: { level: 1, temporalLevel: 0, scaleResolutionDownBy: 1.333333, maxFramerate: 60, adaptationReason: 'spatial-recovery' } });
  const finished = artifact.finish('completed');
  assert.equal(finished.summary.sender.sampleCount, 2);
  assert.equal(finished.summary.sender.adaptationTransitions.length, 1);
  assert.equal(finished.summary.sender.adaptationTransitions[0].to.level, 1);
  assert.equal(finished.summary.sender.retention.encodeRetention, 59 / 60);
  assert.equal(finished.summary.sender.retention.sendRetention, 57 / 59);
});

test('render callbacks aggregate valid metrics instead of retaining every frame', () => {
  const session = createScreenShareDiagnosticsSession({
    enabled: true,
    runId: 'render-run',
    role: 'receiver',
    participantId: 'receiver',
  });
  session.recordRenderFrame({ elapsedMs: 0, streamId: 'stream', width: 1280, height: 720 });
  session.recordRenderFrame({ elapsedMs: 20, streamId: 'stream', width: 1280, height: 720, intervalMs: 20, networkMs: 8, postReceiveMs: 4 });
  session.recordRenderFrame({ elapsedMs: 1_600, streamId: 'stream', width: 1280, height: 720, intervalMs: 16, networkMs: 10, postReceiveMs: 5 });
  const finished = session.finish();
  assert.equal(finished.render.available, true);
  assert.equal(finished.render.windows.length, 2);
  assert.equal(finished.render.windows[0].validCounts.networkMs, 1);
  assert.equal(finished.render.windows[0].networkMs.p50, 8);
  assert.equal(finished.render.windows[1].frameCount, 1);
});

test('sample and render buffers remain bounded and flush exactly once', async () => {
  const writes = [];
  const previousBridge = globalThis.jumpDesktop;
  globalThis.jumpDesktop = {
    streamDiagnosticsEnabled: true,
    writeScreenShareDiagnosticsArtifact: async (artifact) => {
      writes.push(artifact);
      return { written: true };
    },
  };
  try {
    const session = createScreenShareDiagnosticsSession({ enabled: true, runId: 'bounded-run', role: 'sender' });
    for (let index = 0; index < MAX_SCREEN_SHARE_DIAGNOSTIC_SAMPLES + 20; index += 1) {
      session.recordSample({ elapsedMs: index, pipeline: { captureFps: 60 } });
    }
    assert.equal(session.artifact.samples.length, MAX_SCREEN_SHARE_DIAGNOSTIC_SAMPLES);
    await session.flush('test');
    await session.flush('second-call-is-coalesced');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].endReason, 'test');
  } finally {
    globalThis.jumpDesktop = previousBridge;
  }
});

test('environment schema keeps the expected top-level fields and unknown values null', () => {
  const environment = normalizeScreenShareDiagnosticsEnvironment({ os: 'win32', display: { width: 2560 } });
  assert.equal(environment.os, 'win32');
  assert.deepEqual(environment.display, { width: 2560 });
  assert.equal(environment.gpuFeatureStatus, null);
  assert.equal(Object.prototype.hasOwnProperty.call(environment, 'memoryBytes'), true);
});

test('sender and receiver sample builders expose the field-run metrics', () => {
  const sender = createScreenShareSenderSample({
    telemetry: telemetry(),
    adaptation: adaptation(),
    senderParameters: { encodings: [{ maxBitrate: 5_500_000, maxFramerate: 60, scaleResolutionDownBy: 1.333333 }] },
    peerId: 'peer-b',
    trackSettings: { width: 2560, height: 1440 },
    peerCount: 2,
  });
  const receiver = createScreenShareReceiverSample({
    telemetry: telemetry(),
    peerId: 'receiver',
    sourcePeerId: 'sender',
    receiver: { configuredTargetMs: 80 },
  });
  assert.equal(sender.rateControl.maxBitrate, 5_500_000);
  assert.equal(sender.rateControl.networkRecoveryHeadroomRatio, 1.33);
  assert.equal(sender.transport.averagePacketSendDelayMs, 1.4);
  assert.equal(receiver.jitter.actualAverageMs, 12);
  assert.equal(receiver.jitter.targetAverageMs, 20);
  assert.equal(receiver.jitter.minimumAverageMs, 8);
});

test('sender summary remains JSON serializable after non-finite input', () => {
  const session = createScreenShareDiagnosticsSession({ enabled: true, runId: 'json-run', role: 'sender' });
  session.recordSample({ elapsedMs: NaN, pipeline: { encodeFps: Infinity } });
  const artifact = session.finish();
  assert.doesNotThrow(() => JSON.stringify(artifact));
  assert.ok(Number.isFinite(artifact.samples[0].elapsedMs));
  assert.equal(artifact.samples[0].pipeline.encodeFps, null);
  assert.ok(summarizeScreenShareDiagnostics(artifact));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createScreenShareTelemetrySnapshot,
  resolveScreenShareReports,
} from '../src/media/screenShareTelemetry.js';

function fixture({
  timestamp = 1_000,
  sourceFrames = 100,
  encoded = 90,
  sent = 88,
  sentBytes = 1_000,
  encodeTime = 1.8,
  encodeQp = 1_800,
  received = 80,
  decoded = 75,
  receivedBytes = 2_000,
  decodeTime = 1.5,
  decodeQp = 1_500,
  reportedFps = 0,
  jitter = 0,
  jitterBufferDelay = 0,
  jitterBufferTargetDelay = 0,
  jitterBufferMinimumDelay = 0,
  jitterBufferEmittedCount = 0,
  remoteJitter = 0,
  rtt = 0,
  packetsLost = 0,
  retransmittedPacketsSent = 0,
  keyFramesEncoded = 1,
  keyFramesDecoded = 1,
  hugeFramesSent = 0,
  outboundNackCount = 0,
  outboundPliCount = 0,
  outboundFirCount = 0,
  inboundNackCount = 0,
  inboundPliCount = 0,
  inboundFirCount = 0,
  freezeCount = 0,
  totalFreezesDuration = 0,
} = {}) {
  return new Map([
    ['local-candidate', {
      id: 'local-candidate', type: 'local-candidate', candidateType: 'host', protocol: 'udp',
      networkType: 'wifi', address: '192.0.2.1', port: 1234,
    }],
    ['remote-candidate', {
      id: 'remote-candidate', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp',
      address: '198.51.100.2', port: 5678,
    }],
    ['codec-in', {
      id: 'codec-in', type: 'codec', timestamp, mimeType: 'video/VP9', payloadType: 98,
    }],
    ['pair', {
      id: 'pair', type: 'candidate-pair', timestamp, state: 'succeeded', nominated: true,
      availableOutgoingBitrate: 0, availableIncomingBitrate: 0,
      currentRoundTripTime: rtt, bytesSent: 0, bytesReceived: 0,
      localCandidateId: 'local-candidate', remoteCandidateId: 'remote-candidate',
    }],
    ['remote-in', {
      id: 'remote-in', type: 'remote-inbound-rtp', kind: 'video', timestamp,
      localId: 'out', ssrc: 42, packetsLost, jitter: remoteJitter, roundTripTime: 0,
    }],
    ['source', {
      id: 'source', type: 'media-source', kind: 'video', timestamp,
      trackIdentifier: 'screen-track', frames: sourceFrames, framesPerSecond: reportedFps,
      width: 854, height: 480,
    }],
    ['transport', {
      id: 'transport', type: 'transport', timestamp, selectedCandidatePairId: 'pair',
    }],
    ['in', {
      id: 'in', type: 'inbound-rtp', kind: 'video', timestamp, ssrc: 77,
      transportId: 'transport', codecId: 'codec-in', framesReceived: received,
      framesDecoded: decoded, framesDropped: 0, bytesReceived: receivedBytes,
      keyFramesDecoded,
      totalDecodeTime: decodeTime, qpSum: decodeQp, framesPerSecond: reportedFps,
      packetsLost: 0, jitter, jitterBufferDelay, jitterBufferTargetDelay,
      jitterBufferMinimumDelay, jitterBufferEmittedCount,
      freezeCount, totalFreezesDuration,
      nackCount: inboundNackCount, pliCount: inboundPliCount, firCount: inboundFirCount,
    }],
    ['codec-out', {
      id: 'codec-out', type: 'codec', timestamp, mimeType: 'video/H264', payloadType: 96,
      clockRate: 90_000, sdpFmtpLine: 'profile-level-id=42e01f',
    }],
    ['out', {
      id: 'out', type: 'outbound-rtp', kind: 'video', timestamp, ssrc: 42,
      mediaSourceId: 'source', remoteId: 'remote-in', transportId: 'transport',
      codecId: 'codec-out', framesEncoded: encoded, framesSent: sent,
      keyFramesEncoded, hugeFramesSent,
      packetsSent: sent, bytesSent: sentBytes, totalEncodeTime: encodeTime,
      totalPacketSendDelay: encodeTime, qpSum: encodeQp,
      framesPerSecond: reportedFps, frameWidth: 854, frameHeight: 480,
      qualityLimitationReason: 'none', retransmittedBytesSent: 0,
      retransmittedPacketsSent,
      nackCount: outboundNackCount, pliCount: outboundPliCount, firCount: outboundFirCount,
      targetBitrate: 0, encoderImplementation: 'ExternalEncoder', powerEfficientEncoder: true,
    }],
  ]);
}

test('resolves the complete linked screen-share stats path', () => {
  const resolved = resolveScreenShareReports(fixture(), { trackIdentifier: 'screen-track' });
  assert.equal(resolved.mediaSource.id, 'source');
  assert.equal(resolved.outbound.id, 'out');
  assert.equal(resolved.remoteInbound.id, 'remote-in');
  assert.equal(resolved.candidatePair.id, 'pair');
  assert.equal(resolved.localCandidate.candidateType, 'host');
  assert.equal(resolved.remoteCandidate.candidateType, 'srflx');
  assert.equal(resolved.inbound.id, 'in');
  assert.equal(resolved.codec.id, 'codec-out');
  assert.equal(resolved.inboundCodec.id, 'codec-in');
  assert.equal(resolved.transport.id, 'transport');
  const snapshot = createScreenShareTelemetrySnapshot(fixture());
  assert.equal(snapshot.network.localCandidateType, 'host');
  assert.equal(snapshot.network.remoteCandidateType, 'srflx');
  assert.equal(snapshot.network.relay, false);
  assert.equal(snapshot.reports.localCandidate.address, undefined);
  assert.equal(snapshot.reports.remoteCandidate.port, undefined);
});

test('preserves real zero values instead of treating them as missing', () => {
  const snapshot = createScreenShareTelemetrySnapshot(fixture({
    sourceFrames: 0,
    encoded: 0,
    sent: 0,
    sentBytes: 0,
    encodeTime: 0,
    encodeQp: 0,
    received: 0,
    decoded: 0,
    receivedBytes: 0,
    decodeTime: 0,
    decodeQp: 0,
  }));

  assert.equal(snapshot.source.frames, 0);
  assert.equal(snapshot.source.reportedFps, 0);
  assert.equal(snapshot.outbound.bytesSent, 0);
  assert.equal(snapshot.outbound.targetBitrate, 0);
  assert.equal(snapshot.outbound.encoderImplementation, 'ExternalEncoder');
  assert.equal(snapshot.outbound.powerEfficientEncoder, true);
  assert.equal(snapshot.inbound.framesDropped, 0);
  assert.equal(snapshot.network.availableOutgoingBitrate, 0);
  assert.equal(snapshot.remoteInbound.jitter, 0);
  assert.equal(snapshot.derived.captureFps, 0);
  assert.equal(snapshot.derived.encodeFps, 0);
  assert.equal(snapshot.derived.inboundJitterMs, 0);
  assert.equal(snapshot.derived.currentRoundTripTimeMs, 0);
});

test('derives stage FPS, bitrates, time per frame, QP and jitter from deltas', () => {
  const previous = createScreenShareTelemetrySnapshot(fixture());
  const current = createScreenShareTelemetrySnapshot(fixture({
    timestamp: 2_500,
    sourceFrames: 145,
    encoded: 132,
    sent: 130,
    sentBytes: 751_000,
    encodeTime: 2.64,
    encodeQp: 2_640,
    received: 122,
    decoded: 114,
    receivedBytes: 752_000,
    decodeTime: 2.28,
    decodeQp: 2_280,
    jitter: 0.012,
    remoteJitter: 0.007,
    rtt: 0.025,
    packetsLost: 2,
    retransmittedPacketsSent: 4,
    keyFramesEncoded: 4,
    keyFramesDecoded: 3,
    hugeFramesSent: 2,
    outboundNackCount: 7,
    outboundPliCount: 2,
    outboundFirCount: 1,
    inboundNackCount: 5,
    inboundPliCount: 3,
    inboundFirCount: 2,
    freezeCount: 2,
    totalFreezesDuration: 0.35,
    jitterBufferDelay: 1.2,
    jitterBufferTargetDelay: 0.9,
    jitterBufferMinimumDelay: 0.6,
    jitterBufferEmittedCount: 60,
  }), previous);

  assert.equal(current.sequence, 1);
  assert.equal(current.derived.captureFps, 30);
  assert.equal(current.derived.encodeFps, 28);
  assert.equal(current.derived.sendFps, 28);
  assert.equal(current.derived.receiveFps, 28);
  assert.equal(current.derived.decodeFps, 26);
  assert.equal(current.derived.sendBitrateBps, 4_000_000);
  assert.equal(current.derived.receiveBitrateBps, 4_000_000);
  assert.ok(Math.abs(current.derived.averageEncodeTimeMs - 20) < 1e-9);
  assert.ok(Math.abs(current.derived.averageDecodeTimeMs - 20) < 1e-9);
  assert.equal(current.derived.averageEncodeQp, 20);
  assert.equal(current.derived.averageDecodeQp, 20);
  assert.equal(current.derived.inboundJitterMs, 12);
  assert.equal(current.derived.remoteInboundJitterMs, 7);
  assert.equal(current.derived.currentRoundTripTimeMs, 25);
  assert.equal(current.derived.averageJitterBufferDelayMs, 20);
  assert.equal(current.derived.averageJitterBufferTargetDelayMs, 15);
  assert.equal(current.derived.averageJitterBufferMinimumDelayMs, 10);
  assert.equal(current.derived.packetLossRatio, 2 / 42);
  assert.equal(current.derived.retransmissionRatio, 4 / 42);
  assert.equal(current.derived.keyFramesEncoded, 3);
  assert.equal(current.derived.keyFramesDecoded, 2);
  assert.equal(current.derived.keyFramesPerMinute, 120);
  assert.equal(current.derived.keyFrameRatio, 3 / 42);
  assert.equal(current.derived.hugeFramesSent, 2);
  assert.equal(current.derived.outboundNackCount, 7);
  assert.equal(current.derived.outboundPliCount, 2);
  assert.equal(current.derived.outboundFirCount, 1);
  assert.equal(current.derived.inboundNackCount, 5);
  assert.equal(current.derived.inboundPliCount, 3);
  assert.equal(current.derived.inboundFirCount, 2);
  assert.equal(current.derived.freezeCount, 2);
  assert.equal(current.derived.freezeDurationMs, 350);
});

test('returns zero rates for unchanged counters and null averages without new frames', () => {
  const previous = createScreenShareTelemetrySnapshot(fixture());
  const current = createScreenShareTelemetrySnapshot(fixture({ timestamp: 2_500 }), previous);

  assert.equal(current.derived.captureFps, 0);
  assert.equal(current.derived.encodeFps, 0);
  assert.equal(current.derived.sendFps, 0);
  assert.equal(current.derived.receiveFps, 0);
  assert.equal(current.derived.decodeFps, 0);
  assert.equal(current.derived.sendBitrateBps, 0);
  assert.equal(current.derived.receiveBitrateBps, 0);
  assert.equal(current.derived.averageEncodeTimeMs, null);
  assert.equal(current.derived.averageDecodeTimeMs, null);
  assert.equal(current.derived.averageEncodeQp, null);
  assert.equal(current.derived.averageDecodeQp, null);
  assert.equal(current.derived.averageJitterBufferDelayMs, null);
  assert.equal(current.derived.averageJitterBufferTargetDelayMs, null);
  assert.equal(current.derived.averageJitterBufferMinimumDelayMs, null);
});

test('counter resets do not produce negative telemetry and snapshots remain serializable', () => {
  const previous = createScreenShareTelemetrySnapshot(fixture());
  const current = createScreenShareTelemetrySnapshot(fixture({
    timestamp: 2_500,
    sourceFrames: 2,
    encoded: 2,
    sent: 2,
    sentBytes: 20,
    received: 2,
    decoded: 2,
    receivedBytes: 20,
  }), previous);

  assert.equal(current.derived.captureFps, 0);
  assert.equal(current.derived.sendFps, null);
  assert.equal(current.derived.sendBitrateBps, null);
  assert.equal(current.derived.receiveBitrateBps, null);
  assert.equal(current.derived.averageJitterBufferTargetDelayMs, null);
  assert.doesNotThrow(() => JSON.stringify(current));
  assert.equal(current.reports.outbound.codecId, 'codec-out');
});

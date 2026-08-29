import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createScreenShareAudioTelemetrySnapshot,
  createScreenShareTelemetrySnapshot,
  resolveScreenShareAudioReports,
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

function audioFixture({
  timestamp = 1_000,
  microphonePacketsSent = 100,
  microphoneBytesSent = 10_000,
  microphonePacketsLost = 0,
  screenPacketsSent = 200,
  screenBytesSent = 20_000,
  screenPacketsLost = 0,
  microphonePacketsReceived = 90,
  microphoneBytesReceived = 9_000,
  microphoneInboundPacketsLost = 0,
  screenPacketsReceived = 180,
  screenBytesReceived = 18_000,
  screenInboundPacketsLost = 0,
  microphoneJitter = 0.004,
  screenJitter = 0.006,
  microphoneJitterBufferDelay = 2,
  screenJitterBufferDelay = 3,
  microphoneJitterBufferTargetDelay = 1.5,
  screenJitterBufferTargetDelay = 2,
  microphoneJitterBufferMinimumDelay = 1,
  screenJitterBufferMinimumDelay = 1.5,
  microphoneJitterBufferEmittedCount = 100,
  screenJitterBufferEmittedCount = 200,
  microphoneConcealedSamples = 5,
  screenConcealedSamples = 7,
  microphoneConcealmentEvents = 1,
  screenConcealmentEvents = 2,
} = {}) {
  return new Map([
    ['audio-pair', {
      id: 'audio-pair', type: 'candidate-pair', timestamp, state: 'succeeded', nominated: true,
      availableOutgoingBitrate: 4_000_000, currentRoundTripTime: 0.025,
    }],
    ['audio-transport', {
      id: 'audio-transport', type: 'transport', timestamp, selectedCandidatePairId: 'audio-pair',
    }],
    ['codec-microphone', {
      id: 'codec-microphone', type: 'codec', timestamp, mimeType: 'audio/opus',
      payloadType: 111, clockRate: 48_000, channels: 2,
    }],
    ['codec-screen-audio', {
      id: 'codec-screen-audio', type: 'codec', timestamp, mimeType: 'audio/opus',
      payloadType: 112, clockRate: 48_000, channels: 2,
    }],
    ['source-microphone', {
      id: 'source-microphone', type: 'media-source', kind: 'audio', timestamp,
      trackIdentifier: 'microphone-track', audioLevel: 0.2, totalAudioEnergy: 0.8,
      totalSamplesDuration: 2.1,
    }],
    ['source-screen-audio', {
      id: 'source-screen-audio', type: 'media-source', kind: 'audio', timestamp,
      trackIdentifier: 'screen-audio-track', audioLevel: 0.4, totalAudioEnergy: 1.2,
      totalSamplesDuration: 2.1,
    }],
    ['remote-microphone', {
      id: 'remote-microphone', type: 'remote-inbound-rtp', kind: 'audio', timestamp,
      localId: 'out-microphone', packetsLost: microphonePacketsLost,
      roundTripTime: 0.025,
    }],
    ['remote-screen-audio', {
      id: 'remote-screen-audio', type: 'remote-inbound-rtp', kind: 'audio', timestamp,
      localId: 'out-screen-audio', packetsLost: screenPacketsLost,
      roundTripTime: 0.03,
    }],
    ['out-microphone', {
      id: 'out-microphone', type: 'outbound-rtp', kind: 'audio', timestamp, ssrc: 11,
      mediaSourceId: 'source-microphone', remoteId: 'remote-microphone', transportId: 'audio-transport',
      codecId: 'codec-microphone', packetsSent: microphonePacketsSent, bytesSent: microphoneBytesSent,
      retransmittedPacketsSent: 2,
    }],
    ['out-screen-audio', {
      id: 'out-screen-audio', type: 'outbound-rtp', kind: 'audio', timestamp, ssrc: 12,
      mediaSourceId: 'source-screen-audio', remoteId: 'remote-screen-audio', transportId: 'audio-transport',
      codecId: 'codec-screen-audio', packetsSent: screenPacketsSent, bytesSent: screenBytesSent,
      retransmittedPacketsSent: 3,
    }],
    ['in-microphone', {
      id: 'in-microphone', type: 'inbound-rtp', kind: 'audio', timestamp, ssrc: 21,
      trackIdentifier: 'microphone-received-track', transportId: 'audio-transport', codecId: 'codec-microphone',
      packetsReceived: microphonePacketsReceived, bytesReceived: microphoneBytesReceived,
      packetsLost: microphoneInboundPacketsLost, jitter: microphoneJitter,
      jitterBufferDelay: microphoneJitterBufferDelay,
      jitterBufferTargetDelay: microphoneJitterBufferTargetDelay,
      jitterBufferMinimumDelay: microphoneJitterBufferMinimumDelay,
      jitterBufferEmittedCount: microphoneJitterBufferEmittedCount,
      concealedSamples: microphoneConcealedSamples,
      silentConcealedSamples: 2,
      concealmentEvents: microphoneConcealmentEvents,
      insertedSamplesForDeceleration: 1,
      removedSamplesForAcceleration: 2,
      totalSamplesReceived: 4_800,
      totalSamplesDuration: 2.1,
      audioLevel: 0.1,
      totalAudioEnergy: 0.4,
    }],
    ['in-screen-audio', {
      id: 'in-screen-audio', type: 'inbound-rtp', kind: 'audio', timestamp, ssrc: 22,
      trackIdentifier: 'screen-audio-received-track', transportId: 'audio-transport', codecId: 'codec-screen-audio',
      packetsReceived: screenPacketsReceived, bytesReceived: screenBytesReceived,
      packetsLost: screenInboundPacketsLost, jitter: screenJitter,
      jitterBufferDelay: screenJitterBufferDelay,
      jitterBufferTargetDelay: screenJitterBufferTargetDelay,
      jitterBufferMinimumDelay: screenJitterBufferMinimumDelay,
      jitterBufferEmittedCount: screenJitterBufferEmittedCount,
      concealedSamples: screenConcealedSamples,
      silentConcealedSamples: 3,
      concealmentEvents: screenConcealmentEvents,
      insertedSamplesForDeceleration: 2,
      removedSamplesForAcceleration: 1,
      totalSamplesReceived: 9_600,
      totalSamplesDuration: 2.1,
      audioLevel: 0.3,
      totalAudioEnergy: 0.7,
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

test('audio resolver keeps microphone and screen audio outbound/inbound paths separate', () => {
  const stats = audioFixture();
  assert.equal(resolveScreenShareAudioReports(stats, {
    direction: 'outbound', trackIdentifier: 'microphone-track',
  }).outbound.id, 'out-microphone');
  assert.equal(resolveScreenShareAudioReports(stats, {
    direction: 'outbound', trackIdentifier: 'screen-audio-track',
  }).outbound.id, 'out-screen-audio');
  assert.equal(resolveScreenShareAudioReports(stats, {
    direction: 'inbound', trackIdentifier: 'microphone-received-track',
  }).inbound.id, 'in-microphone');
  assert.equal(resolveScreenShareAudioReports(stats, {
    direction: 'inbound', trackIdentifier: 'screen-audio-received-track',
  }).inbound.id, 'in-screen-audio');
});

test('audio telemetry derives bitrate, loss, jitter and jitter-buffer deltas per path', () => {
  const previousStats = audioFixture();
  const currentStats = audioFixture({
    timestamp: 2_500,
    microphonePacketsSent: 160,
    microphoneBytesSent: 16_000,
    microphonePacketsLost: 2,
    screenPacketsSent: 320,
    screenBytesSent: 32_000,
    screenPacketsLost: 4,
    microphonePacketsReceived: 150,
    microphoneBytesReceived: 15_000,
    microphoneInboundPacketsLost: 1,
    screenPacketsReceived: 300,
    screenBytesReceived: 30_000,
    screenInboundPacketsLost: 3,
    microphoneJitter: 0.012,
    microphoneJitterBufferDelay: 3.5,
    microphoneJitterBufferTargetDelay: 2.7,
    microphoneJitterBufferMinimumDelay: 1.6,
    microphoneJitterBufferEmittedCount: 160,
    microphoneConcealedSamples: 10,
    microphoneConcealmentEvents: 3,
  });
  const microphoneOutbound = createScreenShareAudioTelemetrySnapshot(previousStats, null, {
    direction: 'outbound', trackIdentifier: 'microphone-track',
  });
  const currentMicrophoneOutbound = createScreenShareAudioTelemetrySnapshot(currentStats, microphoneOutbound, {
    direction: 'outbound', trackIdentifier: 'microphone-track',
  });
  const microphoneInbound = createScreenShareAudioTelemetrySnapshot(previousStats, null, {
    direction: 'inbound', trackIdentifier: 'microphone-received-track',
  });
  const currentMicrophoneInbound = createScreenShareAudioTelemetrySnapshot(currentStats, microphoneInbound, {
    direction: 'inbound', trackIdentifier: 'microphone-received-track',
  });
  const screenOutbound = createScreenShareAudioTelemetrySnapshot(currentStats, null, {
    direction: 'outbound', trackIdentifier: 'screen-audio-track',
  });

  assert.equal(currentMicrophoneOutbound.derived.bitrateBps, 32_000);
  assert.equal(currentMicrophoneOutbound.derived.packetLossRatio, 2 / 60);
  assert.equal(currentMicrophoneOutbound.signal.audioLevel, 0.2);
  assert.equal(screenOutbound.derived.bitrateBps, null);
  assert.equal(currentMicrophoneInbound.derived.packetLossRatio, 1 / 61);
  assert.equal(currentMicrophoneInbound.derived.jitterMs, 12);
  assert.equal(currentMicrophoneInbound.derived.jitterBufferActualMs, 25);
  assert.equal(currentMicrophoneInbound.derived.concealedSamplesDelta, 5);
  assert.equal(currentMicrophoneInbound.derived.concealmentEventsDelta, 2);
});

test('audio counter resets yield null instead of negative deltas', () => {
  const previous = createScreenShareAudioTelemetrySnapshot(audioFixture(), null, {
    direction: 'inbound', trackIdentifier: 'screen-audio-received-track',
  });
  const current = createScreenShareAudioTelemetrySnapshot(audioFixture({
    timestamp: 2_500,
    screenPacketsReceived: 10,
    screenBytesReceived: 100,
    screenInboundPacketsLost: 0,
    screenJitterBufferDelay: 1,
    screenJitterBufferEmittedCount: 10,
    screenConcealedSamples: 1,
  }), previous, {
    direction: 'inbound', trackIdentifier: 'screen-audio-received-track',
  });
  assert.equal(current.derived.bitrateBps, null);
  assert.equal(current.derived.packetLossRatio, null);
  assert.equal(current.derived.jitterBufferActualMs, null);
  assert.equal(current.derived.concealedSamplesDelta, null);
});

test('audio missing fields and settings remain null and private device fields are excluded', () => {
  const snapshot = createScreenShareAudioTelemetrySnapshot(new Map(), null, {
    direction: 'inbound',
    trackSettings: {
      sampleRate: 48_000,
      sampleSize: 16,
      channelCount: 2,
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
      deviceId: 'private-device-id',
      groupId: 'private-group-id',
      label: 'Private Microphone',
    },
  });
  assert.equal(snapshot.kind, 'audio');
  assert.equal(snapshot.codec, null);
  assert.equal(snapshot.derived.bitrateBps, null);
  assert.equal(snapshot.inbound.jitterBufferDelay, null);
  assert.deepEqual(snapshot.trackSettings, {
    sampleRate: 48_000,
    sampleSize: 16,
    channelCount: 2,
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
  });
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('private-device-id'), false);
  assert.equal(serialized.includes('private-group-id'), false);
  assert.equal(serialized.includes('Private Microphone'), false);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});

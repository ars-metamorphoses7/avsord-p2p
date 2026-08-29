const TELEMETRY_VERSION = 2;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function reportNumber(report, key) {
  return finiteNumber(report?.[key]);
}

function reportTimestamp(report, fallback = null) {
  return reportNumber(report, 'timestamp') ?? finiteNumber(fallback);
}

function isVideoReport(report) {
  return report?.kind === 'video' || report?.mediaType === 'video';
}

function statsValues(stats) {
  if (!stats) return [];
  if (typeof stats.values === 'function') return [...stats.values()];
  if (Array.isArray(stats)) return stats;
  if (typeof stats[Symbol.iterator] === 'function') {
    return [...stats].map((entry) => (Array.isArray(entry) ? entry[1] : entry));
  }
  return Object.values(stats);
}

function selectReport(reports, type, predicate = () => true) {
  return reports.find((report) => report?.type === type && predicate(report)) || null;
}

function linkedReport(byId, id, type) {
  if (!id) return null;
  const report = byId.get(id);
  return report?.type === type ? report : null;
}

function matchesIdentifier(report, wantedId, wantedSsrc) {
  if (wantedId && report?.id !== wantedId) return false;
  if (wantedSsrc !== undefined && wantedSsrc !== null
      && String(report?.ssrc) !== String(wantedSsrc)) return false;
  return true;
}

function linkedTrackIdentifier(report, byId) {
  if (report?.trackIdentifier) return report.trackIdentifier;
  for (const id of [report?.mediaSourceId, report?.trackId, report?.senderId, report?.receiverId]) {
    const linked = id ? byId.get(id) : null;
    if (linked?.trackIdentifier) return linked.trackIdentifier;
  }
  return null;
}

/**
 * Resolve the reports that belong to one screen-share path. The function only
 * reads the supplied RTCStatsReport and also accepts Maps/arrays/plain objects
 * so recorded fixtures can be replayed outside a browser.
 */
export function resolveScreenShareReports(stats, selectors = {}) {
  const reports = statsValues(stats);
  const byId = new Map(reports.filter((report) => report?.id).map((report) => [report.id, report]));
  const outboundCandidates = reports.filter((report) => (
    report?.type === 'outbound-rtp'
    && !report.isRemote
    && isVideoReport(report)
  ));
  const outbound = outboundCandidates.find((report) => (
    matchesIdentifier(report, selectors.outboundId, selectors.outboundSsrc)
    && (!selectors.trackIdentifier
      || linkedTrackIdentifier(report, byId) === selectors.trackIdentifier)
  )) || null;

  const mediaSource = linkedReport(byId, outbound?.mediaSourceId, 'media-source')
    || selectReport(reports, 'media-source', (report) => (
      isVideoReport(report)
      && (!selectors.trackIdentifier || report.trackIdentifier === selectors.trackIdentifier)
    ));

  const remoteInbound = linkedReport(byId, outbound?.remoteId, 'remote-inbound-rtp')
    || selectReport(reports, 'remote-inbound-rtp', (report) => (
      isVideoReport(report)
      && (!outbound || report.localId === outbound.id
        || (report.ssrc !== undefined && String(report.ssrc) === String(outbound.ssrc)))
    ));

  const inbound = selectReport(reports, 'inbound-rtp', (report) => (
    !report.isRemote
    && isVideoReport(report)
    && matchesIdentifier(report, selectors.inboundId, selectors.inboundSsrc)
    && (!selectors.remoteTrackIdentifier
      || linkedTrackIdentifier(report, byId) === selectors.remoteTrackIdentifier)
  ));

  const transport = linkedReport(byId, outbound?.transportId || inbound?.transportId, 'transport')
    || selectReport(reports, 'transport', (report) => Boolean(report.selectedCandidatePairId));
  const candidatePair = linkedReport(byId, transport?.selectedCandidatePairId, 'candidate-pair')
    || selectReport(reports, 'candidate-pair', (report) => (
      report.selected === true
      || (report.nominated === true && report.state === 'succeeded')
    ));
  const localCandidate = linkedReport(byId, candidatePair?.localCandidateId, 'local-candidate');
  const remoteCandidate = linkedReport(byId, candidatePair?.remoteCandidateId, 'remote-candidate');
  const codec = linkedReport(byId, outbound?.codecId, 'codec')
    || linkedReport(byId, inbound?.codecId, 'codec');
  const inboundCodec = linkedReport(byId, inbound?.codecId, 'codec');

  return {
    mediaSource,
    outbound,
    remoteInbound,
    candidatePair,
    localCandidate,
    remoteCandidate,
    inbound,
    codec,
    inboundCodec,
    transport,
  };
}

function counter(value, timestamp) {
  return { value: finiteNumber(value), timestampMs: finiteNumber(timestamp) };
}

function counterDelta(current, previous) {
  if (current?.value === null || current?.value === undefined
      || previous?.value === null || previous?.value === undefined) return null;
  const delta = current.value - previous.value;
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
}

function elapsedSeconds(current, previous) {
  if (current?.timestampMs === null || current?.timestampMs === undefined
      || previous?.timestampMs === null || previous?.timestampMs === undefined) return null;
  const elapsed = (current.timestampMs - previous.timestampMs) / 1000;
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : null;
}

function perSecond(current, previous, multiplier = 1) {
  const delta = counterDelta(current, previous);
  const seconds = elapsedSeconds(current, previous);
  return delta === null || seconds === null ? null : (delta * multiplier) / seconds;
}

function perFrame(currentTotal, previousTotal, currentFrames, previousFrames, multiplier = 1) {
  const totalDelta = counterDelta(currentTotal, previousTotal);
  const frameDelta = counterDelta(currentFrames, previousFrames);
  if (totalDelta === null || frameDelta === null || frameDelta <= 0) return null;
  return (totalDelta * multiplier) / frameDelta;
}

function ratioOfDeltas(currentNumerator, previousNumerator, currentDenominator, previousDenominator) {
  const numeratorDelta = counterDelta(currentNumerator, previousNumerator);
  const denominatorDelta = counterDelta(currentDenominator, previousDenominator);
  if (numeratorDelta === null || denominatorDelta === null || denominatorDelta <= 0) return null;
  return numeratorDelta / denominatorDelta;
}

function fallback(primary, fallbackValue) {
  return primary === null ? fallbackValue : primary;
}

function cloneReport(report) {
  if (!report) return null;
  const clone = { ...report };
  for (const key of ['id', 'type', 'timestamp']) {
    if (!(key in clone) && report[key] !== undefined) clone[key] = report[key];
  }
  return clone;
}

function codecSnapshot(codec) {
  if (!codec) return null;
  return {
    id: codec.id ?? null,
    mimeType: codec.mimeType ?? null,
    payloadType: reportNumber(codec, 'payloadType'),
    clockRate: reportNumber(codec, 'clockRate'),
    channels: reportNumber(codec, 'channels'),
    sdpFmtpLine: codec.sdpFmtpLine ?? null,
  };
}

function latestTimestamp(resolved, explicitTimestamp) {
  const explicit = finiteNumber(explicitTimestamp);
  if (explicit !== null) return explicit;
  const timestamps = Object.values(resolved)
    .map((report) => reportNumber(report, 'timestamp'))
    .filter((value) => value !== null);
  return timestamps.length ? Math.max(...timestamps) : null;
}

function buildCounters(resolved, snapshotTimestamp) {
  const sourceTimestamp = reportTimestamp(resolved.mediaSource, snapshotTimestamp);
  const outboundTimestamp = reportTimestamp(resolved.outbound, snapshotTimestamp);
  const inboundTimestamp = reportTimestamp(resolved.inbound, snapshotTimestamp);
  const remoteInboundTimestamp = reportTimestamp(resolved.remoteInbound, snapshotTimestamp);
  const candidatePairTimestamp = reportTimestamp(resolved.candidatePair, snapshotTimestamp);
  return {
    captureFrames: counter(resolved.mediaSource?.frames, sourceTimestamp),
    framesEncoded: counter(resolved.outbound?.framesEncoded, outboundTimestamp),
    keyFramesEncoded: counter(resolved.outbound?.keyFramesEncoded, outboundTimestamp),
    hugeFramesSent: counter(resolved.outbound?.hugeFramesSent, outboundTimestamp),
    framesSent: counter(resolved.outbound?.framesSent, outboundTimestamp),
    packetsSent: counter(resolved.outbound?.packetsSent, outboundTimestamp),
    retransmittedPacketsSent: counter(resolved.outbound?.retransmittedPacketsSent, outboundTimestamp),
    bytesSent: counter(resolved.outbound?.bytesSent, outboundTimestamp),
    retransmittedBytesSent: counter(resolved.outbound?.retransmittedBytesSent, outboundTimestamp),
    totalEncodeTime: counter(resolved.outbound?.totalEncodeTime, outboundTimestamp),
    totalPacketSendDelay: counter(resolved.outbound?.totalPacketSendDelay, outboundTimestamp),
    encodeQpSum: counter(resolved.outbound?.qpSum, outboundTimestamp),
    outboundNackCount: counter(resolved.outbound?.nackCount, outboundTimestamp),
    outboundPliCount: counter(resolved.outbound?.pliCount, outboundTimestamp),
    outboundFirCount: counter(resolved.outbound?.firCount, outboundTimestamp),
    remotePacketsLost: counter(resolved.remoteInbound?.packetsLost, remoteInboundTimestamp),
    framesReceived: counter(resolved.inbound?.framesReceived, inboundTimestamp),
    framesDecoded: counter(resolved.inbound?.framesDecoded, inboundTimestamp),
    keyFramesDecoded: counter(resolved.inbound?.keyFramesDecoded, inboundTimestamp),
    framesRendered: counter(resolved.inbound?.framesRendered, inboundTimestamp),
    bytesReceived: counter(resolved.inbound?.bytesReceived, inboundTimestamp),
    packetsReceived: counter(resolved.inbound?.packetsReceived, inboundTimestamp),
    inboundPacketsLost: counter(resolved.inbound?.packetsLost, inboundTimestamp),
    totalDecodeTime: counter(resolved.inbound?.totalDecodeTime, inboundTimestamp),
    totalProcessingDelay: counter(resolved.inbound?.totalProcessingDelay, inboundTimestamp),
    jitterBufferDelay: counter(resolved.inbound?.jitterBufferDelay, inboundTimestamp),
    jitterBufferTargetDelay: counter(resolved.inbound?.jitterBufferTargetDelay, inboundTimestamp),
    jitterBufferMinimumDelay: counter(resolved.inbound?.jitterBufferMinimumDelay, inboundTimestamp),
    jitterBufferEmittedCount: counter(resolved.inbound?.jitterBufferEmittedCount, inboundTimestamp),
    decodeQpSum: counter(resolved.inbound?.qpSum, inboundTimestamp),
    inboundNackCount: counter(resolved.inbound?.nackCount, inboundTimestamp),
    inboundPliCount: counter(resolved.inbound?.pliCount, inboundTimestamp),
    inboundFirCount: counter(resolved.inbound?.firCount, inboundTimestamp),
    freezeCount: counter(resolved.inbound?.freezeCount, inboundTimestamp),
    totalFreezesDuration: counter(resolved.inbound?.totalFreezesDuration, inboundTimestamp),
    packetsDiscardedOnSend: counter(resolved.candidatePair?.packetsDiscardedOnSend, candidatePairTimestamp),
  };
}

/**
 * Build a JSON-serializable telemetry sample. Pass the previous returned
 * snapshot to derive rates. No clock or mutable module state is consulted.
 */
export function createScreenShareTelemetrySnapshot(stats, previous = null, options = {}) {
  const resolved = resolveScreenShareReports(stats, options);
  const timestampMs = latestTimestamp(resolved, options.timestampMs);
  const counters = buildCounters(resolved, timestampMs);
  const previousCounters = previous?.counters || {};

  const captureFpsDelta = perSecond(counters.captureFrames, previousCounters.captureFrames);
  const encodeFpsDelta = perSecond(counters.framesEncoded, previousCounters.framesEncoded);
  const decodeFpsDelta = perSecond(counters.framesDecoded, previousCounters.framesDecoded);
  const captureReportedFps = reportNumber(resolved.mediaSource, 'framesPerSecond');
  const encodeReportedFps = reportNumber(resolved.outbound, 'framesPerSecond');
  const decodeReportedFps = reportNumber(resolved.inbound, 'framesPerSecond');
  const encodedKeyFrames = counterDelta(
    counters.keyFramesEncoded,
    previousCounters.keyFramesEncoded,
  );
  const decodedKeyFrames = counterDelta(
    counters.keyFramesDecoded,
    previousCounters.keyFramesDecoded,
  );
  const encodedKeyFrameSeconds = elapsedSeconds(
    counters.keyFramesEncoded,
    previousCounters.keyFramesEncoded,
  );

  const derived = {
    captureFps: fallback(captureFpsDelta, captureReportedFps),
    encodeFps: fallback(encodeFpsDelta, encodeReportedFps),
    sendFps: perSecond(counters.framesSent, previousCounters.framesSent),
    receiveFps: perSecond(counters.framesReceived, previousCounters.framesReceived),
    decodeFps: fallback(decodeFpsDelta, decodeReportedFps),
    renderFps: perSecond(counters.framesRendered, previousCounters.framesRendered),
    keyFramesEncoded: encodedKeyFrames,
    keyFramesDecoded: decodedKeyFrames,
    keyFramesPerMinute: encodedKeyFrames === null || encodedKeyFrameSeconds === null
      ? null : (encodedKeyFrames * 60) / encodedKeyFrameSeconds,
    keyFrameRatio: ratioOfDeltas(
      counters.keyFramesEncoded,
      previousCounters.keyFramesEncoded,
      counters.framesEncoded,
      previousCounters.framesEncoded,
    ),
    hugeFramesSent: counterDelta(counters.hugeFramesSent, previousCounters.hugeFramesSent),
    outboundNackCount: counterDelta(
      counters.outboundNackCount,
      previousCounters.outboundNackCount,
    ),
    outboundPliCount: counterDelta(
      counters.outboundPliCount,
      previousCounters.outboundPliCount,
    ),
    outboundFirCount: counterDelta(
      counters.outboundFirCount,
      previousCounters.outboundFirCount,
    ),
    inboundNackCount: counterDelta(
      counters.inboundNackCount,
      previousCounters.inboundNackCount,
    ),
    inboundPliCount: counterDelta(
      counters.inboundPliCount,
      previousCounters.inboundPliCount,
    ),
    inboundFirCount: counterDelta(
      counters.inboundFirCount,
      previousCounters.inboundFirCount,
    ),
    freezeCount: counterDelta(counters.freezeCount, previousCounters.freezeCount),
    freezeDurationMs: (() => {
      const seconds = counterDelta(
        counters.totalFreezesDuration,
        previousCounters.totalFreezesDuration,
      );
      return seconds === null ? null : seconds * 1000;
    })(),
    sendBitrateBps: perSecond(counters.bytesSent, previousCounters.bytesSent, 8),
    retransmitBitrateBps: perSecond(
      counters.retransmittedBytesSent,
      previousCounters.retransmittedBytesSent,
      8,
    ),
    packetLossRatio: (() => {
      const lost = counterDelta(counters.remotePacketsLost, previousCounters.remotePacketsLost);
      const sent = counterDelta(counters.packetsSent, previousCounters.packetsSent);
      // remote-inbound loss is a subset of the sender's packetsSent total;
      // unlike local inbound packetsReceived, it must not be added to the
      // denominator a second time.
      if (lost === null || sent === null || sent <= 0) return null;
      return lost / sent;
    })(),
    retransmissionRatio: ratioOfDeltas(
      counters.retransmittedPacketsSent,
      previousCounters.retransmittedPacketsSent,
      counters.packetsSent,
      previousCounters.packetsSent,
    ),
    inboundPacketLossRatio: (() => {
      const lost = counterDelta(counters.inboundPacketsLost, previousCounters.inboundPacketsLost);
      const received = counterDelta(counters.packetsReceived, previousCounters.packetsReceived);
      if (lost === null || received === null || lost + received <= 0) return null;
      return lost / (lost + received);
    })(),
    packetsDiscardedOnSend: counterDelta(
      counters.packetsDiscardedOnSend,
      previousCounters.packetsDiscardedOnSend,
    ),
    receiveBitrateBps: perSecond(counters.bytesReceived, previousCounters.bytesReceived, 8),
    averageEncodeTimeMs: perFrame(
      counters.totalEncodeTime,
      previousCounters.totalEncodeTime,
      counters.framesEncoded,
      previousCounters.framesEncoded,
      1000,
    ),
    averageDecodeTimeMs: perFrame(
      counters.totalDecodeTime,
      previousCounters.totalDecodeTime,
      counters.framesDecoded,
      previousCounters.framesDecoded,
      1000,
    ),
    averageEncodeQp: perFrame(
      counters.encodeQpSum,
      previousCounters.encodeQpSum,
      counters.framesEncoded,
      previousCounters.framesEncoded,
    ),
    averageDecodeQp: perFrame(
      counters.decodeQpSum,
      previousCounters.decodeQpSum,
      counters.framesDecoded,
      previousCounters.framesDecoded,
    ),
    averagePacketSendDelayMs: perFrame(
      counters.totalPacketSendDelay,
      previousCounters.totalPacketSendDelay,
      counters.packetsSent,
      previousCounters.packetsSent,
      1000,
    ),
    averageProcessingDelayMs: perFrame(
      counters.totalProcessingDelay,
      previousCounters.totalProcessingDelay,
      counters.framesDecoded,
      previousCounters.framesDecoded,
      1000,
    ),
    averageJitterBufferDelayMs: perFrame(
      counters.jitterBufferDelay,
      previousCounters.jitterBufferDelay,
      counters.jitterBufferEmittedCount,
      previousCounters.jitterBufferEmittedCount,
      1000,
    ),
    averageJitterBufferTargetDelayMs: perFrame(
      counters.jitterBufferTargetDelay,
      previousCounters.jitterBufferTargetDelay,
      counters.jitterBufferEmittedCount,
      previousCounters.jitterBufferEmittedCount,
      1000,
    ),
    averageJitterBufferMinimumDelayMs: perFrame(
      counters.jitterBufferMinimumDelay,
      previousCounters.jitterBufferMinimumDelay,
      counters.jitterBufferEmittedCount,
      previousCounters.jitterBufferEmittedCount,
      1000,
    ),
    inboundJitterMs: reportNumber(resolved.inbound, 'jitter') === null
      ? null : reportNumber(resolved.inbound, 'jitter') * 1000,
    remoteInboundJitterMs: reportNumber(resolved.remoteInbound, 'jitter') === null
      ? null : reportNumber(resolved.remoteInbound, 'jitter') * 1000,
    currentRoundTripTimeMs: reportNumber(resolved.candidatePair, 'currentRoundTripTime') === null
      ? null : reportNumber(resolved.candidatePair, 'currentRoundTripTime') * 1000,
  };

  return {
    version: TELEMETRY_VERSION,
    sequence: previous && Number.isInteger(previous.sequence) ? previous.sequence + 1 : 0,
    timestampMs,
    ids: {
      mediaSource: resolved.mediaSource?.id ?? null,
      outbound: resolved.outbound?.id ?? null,
      remoteInbound: resolved.remoteInbound?.id ?? null,
      candidatePair: resolved.candidatePair?.id ?? null,
      inbound: resolved.inbound?.id ?? null,
      codec: resolved.codec?.id ?? null,
      inboundCodec: resolved.inboundCodec?.id ?? null,
      transport: resolved.transport?.id ?? null,
    },
    source: {
      trackIdentifier: resolved.mediaSource?.trackIdentifier ?? null,
      frames: reportNumber(resolved.mediaSource, 'frames'),
      reportedFps: captureReportedFps,
      width: reportNumber(resolved.mediaSource, 'width'),
      height: reportNumber(resolved.mediaSource, 'height'),
    },
    outbound: {
      ssrc: reportNumber(resolved.outbound, 'ssrc'),
      framesEncoded: reportNumber(resolved.outbound, 'framesEncoded'),
      keyFramesEncoded: reportNumber(resolved.outbound, 'keyFramesEncoded'),
      framesSent: reportNumber(resolved.outbound, 'framesSent'),
      packetsSent: reportNumber(resolved.outbound, 'packetsSent'),
      bytesSent: reportNumber(resolved.outbound, 'bytesSent'),
      totalEncodeTime: reportNumber(resolved.outbound, 'totalEncodeTime'),
      totalPacketSendDelay: reportNumber(resolved.outbound, 'totalPacketSendDelay'),
      qpSum: reportNumber(resolved.outbound, 'qpSum'),
      reportedFps: encodeReportedFps,
      frameWidth: reportNumber(resolved.outbound, 'frameWidth'),
      frameHeight: reportNumber(resolved.outbound, 'frameHeight'),
      qualityLimitationReason: resolved.outbound?.qualityLimitationReason ?? null,
      qualityLimitationDurations: resolved.outbound?.qualityLimitationDurations
        ? { ...resolved.outbound.qualityLimitationDurations } : null,
      qualityLimitationResolutionChanges: reportNumber(resolved.outbound, 'qualityLimitationResolutionChanges'),
      targetBitrate: reportNumber(resolved.outbound, 'targetBitrate'),
      totalEncodedBytesTarget: reportNumber(resolved.outbound, 'totalEncodedBytesTarget'),
      hugeFramesSent: reportNumber(resolved.outbound, 'hugeFramesSent'),
      encoderImplementation: resolved.outbound?.encoderImplementation ?? null,
      powerEfficientEncoder: resolved.outbound?.powerEfficientEncoder ?? null,
      retransmittedBytesSent: reportNumber(resolved.outbound, 'retransmittedBytesSent'),
      retransmittedPacketsSent: reportNumber(resolved.outbound, 'retransmittedPacketsSent'),
      nackCount: reportNumber(resolved.outbound, 'nackCount'),
      pliCount: reportNumber(resolved.outbound, 'pliCount'),
      firCount: reportNumber(resolved.outbound, 'firCount'),
    },
    remoteInbound: {
      packetsLost: reportNumber(resolved.remoteInbound, 'packetsLost'),
      jitter: reportNumber(resolved.remoteInbound, 'jitter'),
      roundTripTime: reportNumber(resolved.remoteInbound, 'roundTripTime'),
      fractionLost: reportNumber(resolved.remoteInbound, 'fractionLost'),
    },
    inbound: {
      ssrc: reportNumber(resolved.inbound, 'ssrc'),
      framesReceived: reportNumber(resolved.inbound, 'framesReceived'),
      framesDecoded: reportNumber(resolved.inbound, 'framesDecoded'),
      keyFramesDecoded: reportNumber(resolved.inbound, 'keyFramesDecoded'),
      framesRendered: reportNumber(resolved.inbound, 'framesRendered'),
      framesDropped: reportNumber(resolved.inbound, 'framesDropped'),
      bytesReceived: reportNumber(resolved.inbound, 'bytesReceived'),
      totalDecodeTime: reportNumber(resolved.inbound, 'totalDecodeTime'),
      qpSum: reportNumber(resolved.inbound, 'qpSum'),
      reportedFps: decodeReportedFps,
      frameWidth: reportNumber(resolved.inbound, 'frameWidth'),
      frameHeight: reportNumber(resolved.inbound, 'frameHeight'),
      packetsLost: reportNumber(resolved.inbound, 'packetsLost'),
      jitter: reportNumber(resolved.inbound, 'jitter'),
      jitterBufferDelay: reportNumber(resolved.inbound, 'jitterBufferDelay'),
      jitterBufferTargetDelay: reportNumber(resolved.inbound, 'jitterBufferTargetDelay'),
      jitterBufferMinimumDelay: reportNumber(resolved.inbound, 'jitterBufferMinimumDelay'),
      jitterBufferEmittedCount: reportNumber(resolved.inbound, 'jitterBufferEmittedCount'),
      totalProcessingDelay: reportNumber(resolved.inbound, 'totalProcessingDelay'),
      totalInterFrameDelay: reportNumber(resolved.inbound, 'totalInterFrameDelay'),
      totalSquaredInterFrameDelay: reportNumber(resolved.inbound, 'totalSquaredInterFrameDelay'),
      freezeCount: reportNumber(resolved.inbound, 'freezeCount'),
      totalFreezesDuration: reportNumber(resolved.inbound, 'totalFreezesDuration'),
      pauseCount: reportNumber(resolved.inbound, 'pauseCount'),
      totalPausesDuration: reportNumber(resolved.inbound, 'totalPausesDuration'),
      decoderImplementation: resolved.inbound?.decoderImplementation ?? null,
      powerEfficientDecoder: resolved.inbound?.powerEfficientDecoder ?? null,
      nackCount: reportNumber(resolved.inbound, 'nackCount'),
      pliCount: reportNumber(resolved.inbound, 'pliCount'),
      firCount: reportNumber(resolved.inbound, 'firCount'),
    },
    network: {
      state: resolved.candidatePair?.state ?? null,
      nominated: resolved.candidatePair?.nominated ?? null,
      availableOutgoingBitrate: reportNumber(resolved.candidatePair, 'availableOutgoingBitrate'),
      availableIncomingBitrate: reportNumber(resolved.candidatePair, 'availableIncomingBitrate'),
      currentRoundTripTime: reportNumber(resolved.candidatePair, 'currentRoundTripTime'),
      bytesSent: reportNumber(resolved.candidatePair, 'bytesSent'),
      bytesReceived: reportNumber(resolved.candidatePair, 'bytesReceived'),
      packetsDiscardedOnSend: reportNumber(resolved.candidatePair, 'packetsDiscardedOnSend'),
      bytesDiscardedOnSend: reportNumber(resolved.candidatePair, 'bytesDiscardedOnSend'),
      localCandidateType: resolved.localCandidate?.candidateType ?? null,
      remoteCandidateType: resolved.remoteCandidate?.candidateType ?? null,
      protocol: resolved.localCandidate?.protocol || resolved.remoteCandidate?.protocol || null,
      networkType: resolved.localCandidate?.networkType ?? null,
      relay: resolved.localCandidate?.candidateType === 'relay'
        || resolved.remoteCandidate?.candidateType === 'relay'
        ? true
        : resolved.localCandidate || resolved.remoteCandidate ? false : null,
    },
    codec: codecSnapshot(resolved.codec),
    inboundCodec: codecSnapshot(resolved.inboundCodec),
    derived,
    counters,
    reports: {
      mediaSource: cloneReport(resolved.mediaSource),
      outbound: cloneReport(resolved.outbound),
      remoteInbound: cloneReport(resolved.remoteInbound),
      candidatePair: cloneReport(resolved.candidatePair),
      inbound: cloneReport(resolved.inbound),
      codec: cloneReport(resolved.codec),
      inboundCodec: cloneReport(resolved.inboundCodec),
      transport: cloneReport(resolved.transport),
      localCandidate: resolved.localCandidate ? {
        id: resolved.localCandidate.id ?? null,
        type: resolved.localCandidate.type ?? null,
        candidateType: resolved.localCandidate.candidateType ?? null,
        protocol: resolved.localCandidate.protocol ?? null,
        networkType: resolved.localCandidate.networkType ?? null,
      } : null,
      remoteCandidate: resolved.remoteCandidate ? {
        id: resolved.remoteCandidate.id ?? null,
        type: resolved.remoteCandidate.type ?? null,
        candidateType: resolved.remoteCandidate.candidateType ?? null,
        protocol: resolved.remoteCandidate.protocol ?? null,
      } : null,
    },
  };
}

export const collectScreenShareTelemetry = createScreenShareTelemetrySnapshot;

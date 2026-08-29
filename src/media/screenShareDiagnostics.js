export const SCREEN_SHARE_DIAGNOSTICS_SCHEMA_VERSION = 1;
export const MAX_SCREEN_SHARE_DIAGNOSTIC_SAMPLES = 600;
export const MAX_SCREEN_SHARE_DIAGNOSTIC_RENDER_WINDOWS = 600;
export const MAX_SCREEN_SHARE_DIAGNOSTIC_WINDOW_VALUES = 180;
export const SCREEN_SHARE_DIAGNOSTIC_RENDER_WINDOW_MS = 1_500;

const ENVIRONMENT_FIELDS = [
  'role',
  'os',
  'osVersion',
  'arch',
  'cpuModel',
  'cpuLogicalCount',
  'memoryBytes',
  'electronVersion',
  'chromiumVersion',
  'appVersion',
  'appCommit',
  'gpu',
  'gpuFeatureStatus',
  'hardwareAcceleration',
  'videoEncode',
  'hardwareVideoEncoding',
  'display',
  'capturePolicy',
];

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteOrNull(value) {
  return finiteNumber(value);
}

function jsonSafe(value, depth = 0) {
  if (depth > 8) return null;
  if (value === null || value === undefined) return value === undefined ? null : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry, depth + 1));
  if (typeof value !== 'object') return null;
  const result = {};
  Object.entries(value).forEach(([key, entry]) => {
    result[key] = jsonSafe(entry, depth + 1);
  });
  return result;
}

function sanitizeDiagnosticsCapture(capture) {
  const safeCapture = jsonSafe(capture);
  if (!safeCapture || typeof safeCapture !== 'object' || Array.isArray(safeCapture)) return safeCapture;
  if (!safeCapture.source || typeof safeCapture.source !== 'object' || Array.isArray(safeCapture.source)) {
    return safeCapture;
  }
  const safeSource = { ...safeCapture.source };
  delete safeSource.name;
  delete safeSource.title;
  delete safeSource.windowTitle;
  return { ...safeCapture, source: safeSource };
}

function normalizeRunId(value) {
  return String(value || '').trim().slice(0, 128);
}

export function normalizeScreenShareRunId(value) {
  return normalizeRunId(value);
}

function nowClock() {
  const performanceObject = globalThis.performance;
  return {
    wallTimeMs: Date.now(),
    monotonicMs: typeof performanceObject?.now === 'function' ? performanceObject.now() : null,
    timeOriginMs: finiteNumber(performanceObject?.timeOrigin),
  };
}

function isoTime(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  try {
    return new Date(number).toISOString();
  } catch {
    return null;
  }
}

export function isScreenShareDiagnosticsEnabled(runtime = globalThis.jumpDesktop) {
  return runtime?.streamDiagnosticsEnabled === true;
}

export function createScreenShareRunId(random = globalThis.crypto) {
  return random?.randomUUID?.()
    || `screen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function createScreenShareRunContext(capture = {}) {
  const clock = nowClock();
  return {
    runId: createScreenShareRunId(),
    startedAtMs: clock.wallTimeMs,
    performanceTimeOriginMs: clock.timeOriginMs,
    monotonicStartMs: clock.monotonicMs,
    capture: sanitizeDiagnosticsCapture(capture),
  };
}

export function normalizeScreenShareDiagnosticsEnvironment(environment = {}) {
  const source = environment && typeof environment === 'object' ? environment : {};
  const normalized = {};
  ENVIRONMENT_FIELDS.forEach((field) => {
    normalized[field] = source[field] === undefined ? null : jsonSafe(source[field]);
  });
  return normalized;
}

function metricValues(values) {
  return values.map(finiteNumber).filter((value) => value !== null);
}

export function percentile(values, percentage) {
  const sorted = metricValues(values).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = (sorted.length - 1) * Math.max(0, Math.min(100, percentage)) / 100;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (rank - lower));
}

export function summarizeMetric(values) {
  const valid = metricValues(values);
  if (!valid.length) {
    return { count: 0, p05: null, p50: null, p95: null, p99: null, min: null, max: null };
  }
  return {
    count: valid.length,
    p05: percentile(valid, 5),
    p50: percentile(valid, 50),
    p95: percentile(valid, 95),
    p99: percentile(valid, 99),
    min: Math.min(...valid),
    max: Math.max(...valid),
  };
}

function sampleMetric(samples, path) {
  return samples.map((sample) => path.reduce((value, key) => value?.[key], sample));
}

function retention(numerator, denominator) {
  const top = finiteNumber(numerator);
  const bottom = finiteNumber(denominator);
  return top === null || bottom === null || bottom <= 0 ? null : top / bottom;
}

function transitionList(samples) {
  const transitions = [];
  let previous = null;
  samples.forEach((sample) => {
    const current = sample.rateControl;
    if (!current) return;
    const signature = [
      current.level,
      current.temporalLevel,
      current.scaleResolutionDownBy,
      current.maxFramerate,
    ].join('|');
    if (previous && previous.signature !== signature) {
      transitions.push({
        elapsedMs: sample.elapsedMs ?? null,
        from: previous.value,
        to: {
          level: current.level ?? null,
          temporalLevel: current.temporalLevel ?? null,
          scaleResolutionDownBy: current.scaleResolutionDownBy ?? null,
          maxFramerate: current.maxFramerate ?? null,
        },
        reason: current.adaptationReason ?? null,
      });
    }
    previous = {
      signature,
      value: {
        level: current.level ?? null,
        temporalLevel: current.temporalLevel ?? null,
        scaleResolutionDownBy: current.scaleResolutionDownBy ?? null,
        maxFramerate: current.maxFramerate ?? null,
      },
    };
  });
  return transitions;
}

function summarizeSender(artifact) {
  const samples = artifact.samples || [];
  const capture = summarizeMetric(sampleMetric(samples, ['pipeline', 'captureFps']));
  const encode = summarizeMetric(sampleMetric(samples, ['pipeline', 'encodeFps']));
  const send = summarizeMetric(sampleMetric(samples, ['pipeline', 'sendFps']));
  const bitrate = summarizeMetric(sampleMetric(samples, ['transport', 'sendBitrateBps']));
  const encodeTime = summarizeMetric(sampleMetric(samples, ['pipeline', 'averageEncodeTimeMs']));
  const pacer = summarizeMetric(sampleMetric(samples, ['transport', 'averagePacketSendDelayMs']));
  const loss = summarizeMetric(sampleMetric(samples, ['transport', 'packetLossRatio']));
  const rtt = summarizeMetric(sampleMetric(samples, ['transport', 'roundTripTimeMs']));
  return {
    sampleCount: samples.length,
    captureFps: capture,
    encodeFps: encode,
    sendFps: send,
    bitrateBps: bitrate,
    encodeTimeMs: encodeTime,
    packetSendDelayMs: pacer,
    packetLossRatio: loss,
    roundTripTimeMs: rtt,
    resolutionStrata: [...new Set(samples.map((sample) => {
      const width = sample.pipeline?.frameWidth;
      const height = sample.pipeline?.frameHeight;
      return width && height ? `${width}x${height}` : null;
    }).filter(Boolean))],
    adaptationTransitions: transitionList(samples),
    retention: {
      encodeRetention: retention(encode.p50, capture.p50),
      sendRetention: retention(send.p50, encode.p50),
    },
  };
}

function summarizeReceiver(artifact) {
  const samples = artifact.samples || [];
  const receive = summarizeMetric(sampleMetric(samples, ['pipeline', 'receiveFps']));
  const decode = summarizeMetric(sampleMetric(samples, ['pipeline', 'decodeFps']));
  const decodeTime = summarizeMetric(sampleMetric(samples, ['pipeline', 'averageDecodeTimeMs']));
  const loss = summarizeMetric(sampleMetric(samples, ['transport', 'packetLossRatio']));
  const rtt = summarizeMetric(sampleMetric(samples, ['transport', 'roundTripTimeMs']));
  const renderWindows = artifact.render?.windows || [];
  const renderFps = summarizeMetric(renderWindows.map((window) => window.presentedFps));
  const frameIntervalP95 = summarizeMetric(renderWindows.map((window) => window.frameIntervalMs?.p95));
  const frameIntervalP99 = summarizeMetric(renderWindows.map((window) => window.frameIntervalMs?.p99));
  const captureToCompositorP95 = summarizeMetric(renderWindows.map((window) => window.captureToCompositorMs?.p95));
  const postReceiveP95 = summarizeMetric(renderWindows.map((window) => window.postReceiveMs?.p95));
  const jitterActual = summarizeMetric(sampleMetric(samples, ['jitter', 'actualAverageMs']));
  const jitterTarget = summarizeMetric(sampleMetric(samples, ['jitter', 'targetAverageMs']));
  const jitterMinimum = summarizeMetric(sampleMetric(samples, ['jitter', 'minimumAverageMs']));
  return {
    sampleCount: samples.length,
    receiveFps: receive,
    decodeFps: decode,
    renderFps,
    frameIntervalP95,
    frameIntervalP99,
    captureToCompositorP95,
    postReceiveP95,
    decodeTimeMs: decodeTime,
    freezes: summarizeMetric(sampleMetric(samples, ['webrtc', 'freezeCount'])),
    packetLossRatio: loss,
    roundTripTimeMs: rtt,
    jitter: {
      actualAverageMs: jitterActual,
      targetAverageMs: jitterTarget,
      minimumAverageMs: jitterMinimum,
    },
    retention: {
      decodeRetention: retention(decode.p50, receive.p50),
      renderRetention: retention(renderFps.p50, decode.p50),
    },
  };
}

export function createScreenShareSenderSample({
  telemetry,
  adaptation = null,
  senderParameters = null,
  peerId = null,
  trackSettings = null,
  peerCount = null,
} = {}) {
  if (!telemetry) return null;
  const encoding = senderParameters?.encodings?.[0] || {};
  return {
    timestampMs: telemetry.timestampMs ?? null,
    pipeline: {
      captureFps: telemetry.derived?.captureFps ?? null,
      encodeFps: telemetry.derived?.encodeFps ?? null,
      sendFps: telemetry.derived?.sendFps ?? null,
      frameWidth: telemetry.outbound?.frameWidth ?? null,
      frameHeight: telemetry.outbound?.frameHeight ?? null,
      sourceWidth: telemetry.source?.width ?? null,
      sourceHeight: telemetry.source?.height ?? null,
      trackWidth: trackSettings?.width ?? null,
      trackHeight: trackSettings?.height ?? null,
      averageEncodeTimeMs: telemetry.derived?.averageEncodeTimeMs ?? null,
      averageEncodeQp: telemetry.derived?.averageEncodeQp ?? null,
      encoderImplementation: telemetry.outbound?.encoderImplementation ?? null,
      powerEfficientEncoder: telemetry.outbound?.powerEfficientEncoder ?? null,
      qualityLimitationReason: telemetry.outbound?.qualityLimitationReason ?? null,
    },
    rateControl: {
      peerId,
      peerCount,
      level: adaptation?.level ?? null,
      temporalLevel: adaptation?.temporalLevel ?? null,
      scaleResolutionDownBy: encoding.scaleResolutionDownBy ?? adaptation?.scale ?? null,
      maxFramerate: encoding.maxFramerate ?? adaptation?.frameRate ?? null,
      maxBitrate: encoding.maxBitrate ?? null,
      targetBitrate: telemetry.outbound?.targetBitrate ?? null,
      availableOutgoingBitrate: telemetry.network?.availableOutgoingBitrate ?? null,
      requiredBitrate: adaptation?.requiredBitrate ?? null,
      recoveryRequiredBitrate: adaptation?.recoveryRequiredBitrate ?? null,
      networkHeadroomRatio: adaptation?.networkHeadroomRatio ?? null,
      networkRecoveryHeadroomRatio: adaptation?.networkRecoveryHeadroomRatio ?? null,
      networkRecoveryReady: adaptation?.networkRecoveryReady ?? null,
      networkPressure: adaptation?.networkPressure ?? null,
      transportPressure: adaptation?.transportPressure ?? null,
      currentOperatingPointHealthy: adaptation?.currentOperatingPointHealthy ?? null,
      stableSamples: adaptation?.stableSamples ?? null,
      cooldownSamples: adaptation?.cooldownSamples ?? null,
      adaptationReason: adaptation?.reason ?? null,
      recoveryProbeActive: adaptation?.recoveryProbeActive ?? null,
      recoveryProbeSamples: adaptation?.recoveryProbeSamples ?? null,
      recoveryProbeMaxBitrate: adaptation?.recoveryProbeMaxBitrate ?? null,
      recoveryProbeReason: adaptation?.recoveryProbeReason ?? null,
      encoderRecoveryReady: adaptation?.encoderRecoveryReady ?? null,
      bottleneck: adaptation?.bottleneck ?? null,
    },
    transport: {
      sendBitrateBps: telemetry.derived?.sendBitrateBps ?? null,
      packetLossRatio: telemetry.derived?.packetLossRatio ?? null,
      retransmissionRatio: telemetry.derived?.retransmissionRatio ?? null,
      packetsDiscardedOnSend: telemetry.derived?.packetsDiscardedOnSend ?? null,
      averagePacketSendDelayMs: telemetry.derived?.averagePacketSendDelayMs ?? null,
      roundTripTimeMs: telemetry.derived?.currentRoundTripTimeMs ?? null,
      network: telemetry.network || null,
      remoteInbound: telemetry.remoteInbound || null,
    },
    webrtc: {
      framesEncoded: telemetry.outbound?.framesEncoded ?? null,
      framesSent: telemetry.outbound?.framesSent ?? null,
      packetsSent: telemetry.outbound?.packetsSent ?? null,
      bytesSent: telemetry.outbound?.bytesSent ?? null,
      keyFramesEncoded: telemetry.derived?.keyFramesEncoded ?? null,
      hugeFramesSent: telemetry.derived?.hugeFramesSent ?? null,
      nackCount: telemetry.derived?.outboundNackCount ?? null,
      pliCount: telemetry.derived?.outboundPliCount ?? null,
      firCount: telemetry.derived?.outboundFirCount ?? null,
    },
    raw: { telemetry, adaptation, senderParameters },
  };
}

export function createScreenShareReceiverSample({
  telemetry,
  peerId = null,
  sourcePeerId = null,
  adaptation = null,
  receiver = null,
} = {}) {
  if (!telemetry) return null;
  return {
    timestampMs: telemetry.timestampMs ?? null,
    pipeline: {
      receiveFps: telemetry.derived?.receiveFps ?? null,
      decodeFps: telemetry.derived?.decodeFps ?? null,
      renderFps: telemetry.derived?.renderFps ?? null,
      frameWidth: telemetry.inbound?.frameWidth ?? null,
      frameHeight: telemetry.inbound?.frameHeight ?? null,
      averageDecodeTimeMs: telemetry.derived?.averageDecodeTimeMs ?? null,
      averageDecodeQp: telemetry.derived?.averageDecodeQp ?? null,
      decoderImplementation: telemetry.inbound?.decoderImplementation ?? null,
      powerEfficientDecoder: telemetry.inbound?.powerEfficientDecoder ?? null,
    },
    receiver: { peerId, sourcePeerId, ...receiver },
    jitter: {
      actualAverageMs: telemetry.derived?.averageJitterBufferDelayMs ?? null,
      targetAverageMs: telemetry.derived?.averageJitterBufferTargetDelayMs ?? null,
      minimumAverageMs: telemetry.derived?.averageJitterBufferMinimumDelayMs ?? null,
      configuredTargetMs: receiver?.configuredTargetMs ?? null,
    },
    transport: {
      receiveBitrateBps: telemetry.derived?.receiveBitrateBps ?? null,
      packetLossRatio: telemetry.derived?.inboundPacketLossRatio ?? telemetry.derived?.packetLossRatio ?? null,
      retransmissionRatio: telemetry.derived?.retransmissionRatio ?? null,
      roundTripTimeMs: telemetry.derived?.currentRoundTripTimeMs ?? null,
      network: telemetry.network || null,
      remoteInbound: telemetry.remoteInbound || null,
    },
    webrtc: {
      framesReceived: telemetry.inbound?.framesReceived ?? null,
      framesDecoded: telemetry.inbound?.framesDecoded ?? null,
      framesRendered: telemetry.inbound?.framesRendered ?? null,
      framesDropped: telemetry.inbound?.framesDropped ?? null,
      freezeCount: telemetry.inbound?.freezeCount ?? null,
      freezeDurationMs: telemetry.derived?.freezeDurationMs ?? null,
      nackCount: telemetry.derived?.inboundNackCount ?? null,
      pliCount: telemetry.derived?.inboundPliCount ?? null,
      firCount: telemetry.derived?.inboundFirCount ?? null,
    },
    raw: { telemetry, adaptation, receiver },
  };
}

export function summarizeScreenShareDiagnostics(artifact) {
  if (!artifact || !Array.isArray(artifact.samples)) return null;
  const first = artifact.samples[0]?.elapsedMs ?? 0;
  const last = artifact.samples.at(-1)?.elapsedMs ?? first;
  const common = {
    sampleCount: artifact.samples.length,
    elapsedMs: Math.max(0, Number(last) - Number(first)),
    transitions: transitionList(artifact.samples),
  };
  return artifact.role === 'receiver'
    ? { ...common, receiver: summarizeReceiver(artifact) }
    : { ...common, sender: summarizeSender(artifact) };
}

function boundedPush(values, value, limit) {
  if (finiteNumber(value) === null) return;
  values.push(Number(value));
  if (values.length > limit) values.shift();
}

function finalizeRenderWindow(state) {
  if (!state || state.frameCount <= 0) return null;
  const durationMs = Math.max(0, Number(state.lastElapsedMs) - Number(state.firstElapsedMs));
  const summary = {
    streamId: state.streamId,
    startedElapsedMs: state.firstElapsedMs,
    endedElapsedMs: state.lastElapsedMs,
    durationMs,
    frameCount: state.frameCount,
    presentedFrames: state.lastPresentedFrames,
    presentedFps: durationMs > 0 ? (state.frameCount * 1000) / durationMs : null,
    width: state.width,
    height: state.height,
    validCounts: {
      frameIntervalMs: state.intervals.length,
      captureToCompositorMs: state.captureToCompositor.length,
      networkMs: state.network.length,
      postReceiveMs: state.postReceive.length,
      compositorLatenessMs: state.lateness.length,
      processingDurationMs: state.processing.length,
    },
    frameIntervalMs: summarizeMetric(state.intervals),
    captureToCompositorMs: summarizeMetric(state.captureToCompositor),
    networkMs: summarizeMetric(state.network),
    postReceiveMs: summarizeMetric(state.postReceive),
    compositorLatenessMs: summarizeMetric(state.lateness),
    processingDurationMs: summarizeMetric(state.processing),
  };
  return summary;
}

export function createScreenShareDiagnosticsSession({
  enabled = isScreenShareDiagnosticsEnabled(),
  runId,
  role,
  participantId = null,
  peerId = null,
  sourcePeerId = null,
  transportMode = 'mesh',
  environment = {},
  startedAtMs = Date.now(),
  performanceTimeOriginMs = finiteNumber(globalThis.performance?.timeOrigin),
  monotonicStartMs = globalThis.performance?.now?.() ?? null,
  capture = null,
  correlation = null,
} = {}) {
  if (!enabled || !normalizeRunId(runId) || !['sender', 'receiver'].includes(role)) return null;

  const normalizedRunId = normalizeRunId(runId);
  const startWallTimeMs = finiteNumber(startedAtMs) ?? Date.now();
  const startMonotonicMs = finiteNumber(monotonicStartMs);
  const artifact = {
    schemaVersion: SCREEN_SHARE_DIAGNOSTICS_SCHEMA_VERSION,
    runId: normalizedRunId,
    role,
    participantId: participantId ? String(participantId) : null,
    peerId: peerId ? String(peerId) : null,
    sourcePeerId: sourcePeerId ? String(sourcePeerId) : null,
    transportMode: transportMode || null,
    startedAt: isoTime(startWallTimeMs),
    startedAtMs: startWallTimeMs,
    performanceTimeOriginMs: finiteNumber(performanceTimeOriginMs),
    monotonicStartMs: startMonotonicMs,
    environment: normalizeScreenShareDiagnosticsEnvironment({ ...environment, role }),
    correlation: jsonSafe(correlation),
    capture: sanitizeDiagnosticsCapture(capture),
    transport: null,
    samples: [],
    render: { available: false, windows: [] },
    summary: null,
    endedAt: null,
    endedAtMs: null,
    endReason: null,
  };
  let active = true;
  let renderWindow = null;
  let finishedArtifact = null;
  let flushPromise = null;

  const session = {
    artifact,
    get runId() { return normalizedRunId; },
    get role() { return role; },
    get active() { return active; },
    updateMetadata(metadata = {}) {
      if (!active || !metadata || typeof metadata !== 'object') return false;
      if (metadata.capture !== undefined) artifact.capture = sanitizeDiagnosticsCapture(metadata.capture);
      if (metadata.correlation !== undefined) artifact.correlation = jsonSafe(metadata.correlation);
      if (metadata.transport !== undefined) artifact.transport = jsonSafe(metadata.transport);
      if (metadata.environment !== undefined) {
        artifact.environment = normalizeScreenShareDiagnosticsEnvironment({ ...metadata.environment, role });
      }
      return true;
    },
    recordSample(sample = {}) {
      if (!active || artifact.samples.length >= MAX_SCREEN_SHARE_DIAGNOSTIC_SAMPLES) return false;
      const clock = nowClock();
      const monotonic = finiteNumber(sample.monotonicMs) ?? clock.monotonicMs;
      // elapsedMs is always local monotonic time; wall clocks between machines must not be subtracted.
      const elapsedMs = finiteNumber(sample.elapsedMs)
        ?? (monotonic === null || startMonotonicMs === null ? 0 : Math.max(0, monotonic - startMonotonicMs));
      artifact.samples.push({
        ...jsonSafe(sample),
        elapsedMs,
        monotonicMs: monotonic,
        wallTimeMs: clock.wallTimeMs,
      });
      return true;
    },
    recordRenderFrame(frame = {}) {
      if (!active) return false;
      const clock = nowClock();
      const monotonic = finiteNumber(frame.monotonicMs) ?? clock.monotonicMs;
      const elapsedMs = finiteNumber(frame.elapsedMs)
        ?? (monotonic === null || startMonotonicMs === null ? 0 : Math.max(0, monotonic - startMonotonicMs));
      const streamId = frame.streamId ? String(frame.streamId) : null;
      if (!renderWindow || renderWindow.streamId !== streamId
          || elapsedMs - renderWindow.firstElapsedMs >= SCREEN_SHARE_DIAGNOSTIC_RENDER_WINDOW_MS) {
        if (renderWindow) {
          const summary = finalizeRenderWindow(renderWindow);
          if (summary) artifact.render.windows.push(summary);
        }
        renderWindow = {
          streamId,
          firstElapsedMs: elapsedMs,
          lastElapsedMs: elapsedMs,
          frameCount: 0,
          lastPresentedFrames: finiteOrNull(frame.presentedFrames),
          width: finiteOrNull(frame.width),
          height: finiteOrNull(frame.height),
          intervals: [],
          captureToCompositor: [],
          network: [],
          postReceive: [],
          lateness: [],
          processing: [],
        };
        artifact.render.available = true;
      }
      renderWindow.lastElapsedMs = elapsedMs;
      renderWindow.frameCount += 1;
      renderWindow.lastPresentedFrames = finiteOrNull(frame.presentedFrames);
      renderWindow.width = finiteOrNull(frame.width) ?? renderWindow.width;
      renderWindow.height = finiteOrNull(frame.height) ?? renderWindow.height;
      boundedPush(renderWindow.intervals, frame.intervalMs, MAX_SCREEN_SHARE_DIAGNOSTIC_WINDOW_VALUES);
      boundedPush(renderWindow.captureToCompositor, frame.captureToCompositorMs, MAX_SCREEN_SHARE_DIAGNOSTIC_WINDOW_VALUES);
      boundedPush(renderWindow.network, frame.networkMs, MAX_SCREEN_SHARE_DIAGNOSTIC_WINDOW_VALUES);
      boundedPush(renderWindow.postReceive, frame.postReceiveMs, MAX_SCREEN_SHARE_DIAGNOSTIC_WINDOW_VALUES);
      boundedPush(renderWindow.lateness, frame.compositorLatenessMs, MAX_SCREEN_SHARE_DIAGNOSTIC_WINDOW_VALUES);
      boundedPush(renderWindow.processing, frame.processingDurationMs, MAX_SCREEN_SHARE_DIAGNOSTIC_WINDOW_VALUES);
      if (artifact.render.windows.length > MAX_SCREEN_SHARE_DIAGNOSTIC_RENDER_WINDOWS) artifact.render.windows.shift();
      return true;
    },
    finish(reason = 'completed') {
      if (!active && finishedArtifact) return finishedArtifact;
      if (renderWindow) {
        const summary = finalizeRenderWindow(renderWindow);
        if (summary) artifact.render.windows.push(summary);
        renderWindow = null;
      }
      while (artifact.render.windows.length > MAX_SCREEN_SHARE_DIAGNOSTIC_RENDER_WINDOWS) {
        artifact.render.windows.shift();
      }
      active = false;
      const clock = nowClock();
      artifact.endedAtMs = clock.wallTimeMs;
      artifact.endedAt = isoTime(clock.wallTimeMs);
      artifact.endReason = String(reason || 'completed').slice(0, 120);
      artifact.summary = summarizeScreenShareDiagnostics(artifact);
      finishedArtifact = jsonSafe(artifact);
      return finishedArtifact;
    },
    flush(reason = 'completed') {
      if (flushPromise) return flushPromise;
      const completed = session.finish(reason);
      const writer = globalThis.jumpDesktop?.writeScreenShareDiagnosticsArtifact;
      if (typeof writer !== 'function') return Promise.resolve({ written: false, artifact: completed });
      flushPromise = Promise.resolve(writer(completed)).catch((error) => ({
        written: false,
        error: error?.message || String(error),
      }));
      return flushPromise;
    },
  };
  return session;
}

export function flushScreenShareDiagnosticsSession(session, reason = 'completed') {
  if (!session?.flush) return Promise.resolve({ written: false });
  return session.flush(reason);
}

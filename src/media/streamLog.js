// Always-on, low-cost call log: every STREAM_LOG_INTERVAL_MS one line per
// active video stream, from RTCStats counter deltas. It answers "what did the
// friend actually see" after a real session without enabling the heavy field
// diagnostics: viewer FPS, freezes and frame-interval jitter next to the
// sender's capture/encode rate, QP, bitrate, estimate and codec.
export const STREAM_LOG_INTERVAL_MS = 10_000;

const OUTBOUND_KEYS = ['framesEncoded', 'totalEncodeTime', 'qpSum', 'bytesSent', 'frameWidth', 'frameHeight', 'qualityLimitationDurations', 'encoderImplementation', 'pliCount', 'nackCount', 'retransmittedBytesSent'];
const INBOUND_KEYS = ['framesDecoded', 'framesDropped', 'totalDecodeTime', 'freezeCount', 'totalFreezesDuration', 'totalInterFrameDelay', 'totalSquaredInterFrameDelay', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'packetsLost', 'packetsReceived', 'bytesReceived', 'frameWidth', 'frameHeight', 'keyFramesDecoded', 'pliCount', 'decoderImplementation'];

function pick(stat, keys) {
  const result = {};
  for (const key of keys) if (stat[key] !== undefined) result[key] = stat[key];
  return result;
}

/** Reduces an RTCStatsReport to the counters the log needs. */
export function streamLogSnapshot(report, timestampMs) {
  const snapshot = { t: timestampMs, outbound: [], inbound: [], sourceFrames: null, estimate: null, rtt: null, remoteLost: null };
  const codecs = new Map();
  let selectedPair = '';
  report.forEach((stat) => {
    if (stat.type === 'transport' && stat.selectedCandidatePairId) selectedPair = stat.selectedCandidatePairId;
    if (stat.type === 'codec') codecs.set(stat.id, String(stat.mimeType || '').replace(/^video\//, '') + (/profile-level-id=(\w{4})/.exec(stat.sdpFmtpLine || '')?.[1] ? `/${/profile-level-id=(\w{4})/.exec(stat.sdpFmtpLine)[1]}` : ''));
  });
  report.forEach((stat) => {
    if (stat.kind !== 'video' && stat.type !== 'candidate-pair') return;
    if (stat.type === 'outbound-rtp') snapshot.outbound.push({ ...pick(stat, OUTBOUND_KEYS), codec: codecs.get(stat.codecId) || '' });
    else if (stat.type === 'inbound-rtp') snapshot.inbound.push({ ...pick(stat, INBOUND_KEYS), codec: codecs.get(stat.codecId) || '' });
    else if (stat.type === 'media-source') snapshot.sourceFrames = Number.isFinite(stat.frames) ? stat.frames : null;
    else if (stat.type === 'remote-inbound-rtp') snapshot.remoteLost = Number(stat.packetsLost) || 0;
    else if (stat.type === 'candidate-pair' && (selectedPair ? stat.id === selectedPair : stat.nominated && stat.state === 'succeeded')) {
      snapshot.estimate = Number(stat.availableOutgoingBitrate) || null;
      snapshot.rtt = Number.isFinite(stat.currentRoundTripTime) ? stat.currentRoundTripTime : null;
    }
  });
  return snapshot;
}

const diff = (a, b, key) => {
  const before = Number(a?.[key]);
  const after = Number(b?.[key]);
  return Number.isFinite(before) && Number.isFinite(after) ? after - before : null;
};
const round = (value, digits = 1) => (value === null || !Number.isFinite(value) ? '-' : Number(value.toFixed(digits)));

/** Human-readable lines (one per stream that moved frames) between two snapshots. */
export function streamLogLines(label, previous, current) {
  if (!previous || !current) return [];
  const seconds = (current.t - previous.t) / 1000;
  if (!(seconds > 0)) return [];
  const lines = [];
  current.outbound.forEach((out, index) => {
    const before = previous.outbound[index];
    const frames = diff(before, out, 'framesEncoded');
    if (!before || !frames) return;
    const limits = Object.entries(out.qualityLimitationDurations || {})
      .map(([reason, value]) => [reason, value - (before.qualityLimitationDurations?.[reason] || 0)])
      .filter(([reason, value]) => reason !== 'none' && value > 0.5)
      .sort((a, b) => b[1] - a[1]);
    const capture = previous.sourceFrames !== null && current.sourceFrames !== null
      ? (current.sourceFrames - previous.sourceFrames) / seconds : null;
    lines.push(`envio ${label} ${out.frameWidth}x${out.frameHeight} captura=${round(capture)} encode=${round(frames / seconds)}fps ${round(diff(before, out, 'totalEncodeTime') / frames * 1000)}ms`
      + ` qp=${round(diff(before, out, 'qpSum') / frames)} ${round(diff(before, out, 'bytesSent') * 8 / seconds / 1e6, 2)}Mb/s est=${round(current.estimate / 1e6, 1)}Mb/s`
      + ` rtt=${round(current.rtt * 1000, 0)}ms perdidos=${round(diff(previous, current, 'remoteLost'), 0)} pli=${round(diff(before, out, 'pliCount'), 0)} nack=${round(diff(before, out, 'nackCount'), 0)}`
      + `${limits.length ? ` limitado=${limits[0][0]}:${round(limits[0][1])}s` : ''} ${out.codec} ${out.encoderImplementation || ''}`.trimEnd());
  });
  current.inbound.forEach((inbound, index) => {
    const before = previous.inbound[index];
    const frames = diff(before, inbound, 'framesDecoded');
    if (!before || !frames) return;
    const mean = diff(before, inbound, 'totalInterFrameDelay') / frames;
    const meanSquare = diff(before, inbound, 'totalSquaredInterFrameDelay') / frames;
    const emitted = diff(before, inbound, 'jitterBufferEmittedCount');
    lines.push(`recebe ${label} ${inbound.frameWidth}x${inbound.frameHeight} ${round(frames / seconds)}fps intervalo=${round(mean * 1000)}±${round(Math.sqrt(Math.max(0, meanSquare - mean * mean)) * 1000)}ms`
      + ` travadas=${round(diff(before, inbound, 'freezeCount'), 0)}(${round(diff(before, inbound, 'totalFreezesDuration') * 1000, 0)}ms) descartados=${round(diff(before, inbound, 'framesDropped'), 0)}`
      + ` decode=${round(diff(before, inbound, 'totalDecodeTime') / frames * 1000)}ms buffer=${round(emitted ? diff(before, inbound, 'jitterBufferDelay') / emitted * 1000 : null, 0)}ms`
      + ` ${round(diff(before, inbound, 'bytesReceived') * 8 / seconds / 1e6, 2)}Mb/s perdidos=${round(diff(before, inbound, 'packetsLost'), 0)} keyframes=${round(diff(before, inbound, 'keyFramesDecoded'), 0)}`
      + ` rtt=${round(current.rtt * 1000, 0)}ms ${inbound.codec} ${inbound.decoderImplementation || ''}`.trimEnd());
  });
  return lines;
}

/**
 * Polls `getSources()` ([{ label, source }] where source has getStats) and
 * hands formatted lines to `write`. Returns a stop function.
 */
export function startStreamLog({ getSources, write, intervalMs = STREAM_LOG_INTERVAL_MS, now = () => Date.now() }) {
  const previous = new Map();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const lines = [];
      const seen = new Set();
      for (const { label, source } of getSources()) {
        if (!source?.getStats) continue;
        seen.add(label);
        try {
          const snapshot = streamLogSnapshot(await source.getStats(), now());
          lines.push(...streamLogLines(label, previous.get(label), snapshot));
          previous.set(label, snapshot);
        } catch { /* closed connection */ }
      }
      for (const label of previous.keys()) if (!seen.has(label)) previous.delete(label);
      if (lines.length) await write(lines);
    } catch { /* the log must never disturb the call */ } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  return () => clearInterval(timer);
}

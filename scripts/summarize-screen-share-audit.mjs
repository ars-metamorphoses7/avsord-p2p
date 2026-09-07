import fs from 'node:fs';
import path from 'node:path';

// Read-only audit of exported receiver runs. No raw reports or identifiers
// beyond the run ID are emitted. Missing metrics stay null.
const directory = path.resolve(process.argv[2] || '.');
const rows = [];
for (const file of fs.readdirSync(directory).sort()) {
  if (!file.endsWith('.json') || !file.includes('receiver')) continue;
  const run = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
  const receiver = run.summary?.receiver;
  if (run.role !== 'receiver' || !receiver) continue;
  const median = (metric) => metric?.p50 ?? null;
  const samples = run.samples || [];
  rows.push({
    runId: run.runId,
    version: run.environment?.appVersion ?? null,
    os: run.environment?.os ?? null,
    durationSeconds: (run.summary.elapsedMs ?? 0) / 1000,
    samples: receiver.sampleCount,
    receiveFpsMedian: median(receiver.receiveFps),
    decodeFpsMedian: median(receiver.decodeFps),
    renderFpsMedian: median(receiver.renderFps),
    decodeMsMedian: median(receiver.decodeTimeMs),
    jitterBufferMsMedian: median(receiver.jitter?.actualAverageMs),
    minimumJitterBufferMsMedian: median(receiver.jitter?.minimumAverageMs),
    // This is the median of window p95s, NOT the run's global p95.
    postReceiveWindowP95MsMedian: median(receiver.postReceiveP95),
    frameIntervalWindowP95MsMedian: median(receiver.frameIntervalP95),
    lossRatioP95: receiver.packetLossRatio?.p95 ?? null,
    rttMsMedian: median(receiver.roundTripTimeMs),
    freezesInObservedDeltas: receiver.freezeCountTotal ?? null,
    resolutions: [...new Set(samples.flatMap(({ pipeline: p }) =>
      p?.frameWidth && p?.frameHeight ? [`${p.frameWidth}x${p.frameHeight}`] : []))],
    decoders: [...new Set(samples.map(s => s.pipeline?.decoderImplementation).filter(Boolean))],
  });
}
console.log(JSON.stringify({
  note: 'Receiver-only evidence; no sender bottleneck attribution or cross-version causal comparison. Window p95 medians are not global percentiles.',
  runs: rows,
}, null, 2));

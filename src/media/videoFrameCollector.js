const MAX_RENDER_SAMPLES = 7_200;

function finiteMetric(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function startVideoFrameCollector({ media, streamId, store = null, diagnosticsSession = null }) {
  if (!(store || diagnosticsSession) || typeof media?.requestVideoFrameCallback !== 'function') return undefined;

  let videoFrameHandle = 0;
  let cancelled = false;
  const record = {
    streamId,
    sessionId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    startedAtMs: Date.now(),
    frames: 0,
    samples: [],
  };
  if (store) store.render[streamId] = record;

  const onVideoFrame = (now, metadata = {}) => {
    if (cancelled) return;
    const previous = record.samples.at(-1);
    const expectedDisplayTime = finiteMetric(metadata.expectedDisplayTime);
    const captureTime = finiteMetric(metadata.captureTime);
    const receiveTime = finiteMetric(metadata.receiveTime);
    const sample = {
      timestampMs: performance.timeOrigin + now,
      intervalMs: previous ? now - previous.callbackNow : null,
      callbackNow: now,
      presentedFrames: finiteMetric(metadata.presentedFrames),
      width: finiteMetric(metadata.width),
      height: finiteMetric(metadata.height),
      processingDurationMs: finiteMetric(metadata.processingDuration) === null
        ? null : Number(metadata.processingDuration) * 1000,
      networkMs: captureTime === null || receiveTime === null ? null : receiveTime - captureTime,
      captureToCompositorMs: captureTime === null || expectedDisplayTime === null
        ? null : expectedDisplayTime - captureTime,
      postReceiveMs: receiveTime === null || expectedDisplayTime === null
        ? null : expectedDisplayTime - receiveTime,
      compositorLatenessMs: expectedDisplayTime === null ? null : now - expectedDisplayTime,
      rtpTimestamp: finiteMetric(metadata.rtpTimestamp),
    };
    record.frames += 1;
    record.last = sample;
    record.samples.push(sample);
    if (record.samples.length > MAX_RENDER_SAMPLES) record.samples.shift();
    diagnosticsSession?.recordRenderFrame({
      streamId,
      monotonicMs: now,
      presentedFrames: sample.presentedFrames,
      width: sample.width,
      height: sample.height,
      intervalMs: sample.intervalMs,
      captureToCompositorMs: sample.captureToCompositorMs,
      networkMs: sample.networkMs,
      postReceiveMs: sample.postReceiveMs,
      compositorLatenessMs: sample.compositorLatenessMs,
      processingDurationMs: sample.processingDurationMs,
    });
    videoFrameHandle = media.requestVideoFrameCallback(onVideoFrame);
  };

  videoFrameHandle = media.requestVideoFrameCallback(onVideoFrame);
  return () => {
    cancelled = true;
    if (videoFrameHandle && typeof media.cancelVideoFrameCallback === 'function') {
      media.cancelVideoFrameCallback(videoFrameHandle);
    }
  };
}

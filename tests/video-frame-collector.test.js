import assert from 'node:assert/strict';
import test from 'node:test';
import { startVideoFrameCollector } from '../src/media/videoFrameCollector.js';

function fakeMedia() {
  const callbacks = new Map();
  let nextId = 0;
  return {
    requestCount: 0,
    cancelCount: 0,
    requestVideoFrameCallback(callback) {
      const id = ++nextId;
      callbacks.set(id, callback);
      this.requestCount += 1;
      return id;
    },
    cancelVideoFrameCallback(id) {
      callbacks.delete(id);
      this.cancelCount += 1;
    },
    flush(now = 100, metadata = {}) {
      const entry = callbacks.entries().next().value;
      if (!entry) return false;
      callbacks.delete(entry[0]);
      entry[1](now, metadata);
      return true;
    },
  };
}

const frameMetadata = {
  expectedDisplayTime: 95,
  captureTime: 40,
  receiveTime: 70,
  presentedFrames: 1,
  width: 640,
  height: 360,
  processingDuration: 0.005,
  rtpTimestamp: 7,
};

test('does not start a collector when both consumers are disabled', () => {
  const media = fakeMedia();
  const stop = startVideoFrameCollector({ media, streamId: 'video-off' });

  assert.equal(stop, undefined);
  assert.equal(media.requestCount, 0);
});

test('legacy stream telemetry records render frames when diagnostics are absent', () => {
  const media = fakeMedia();
  const store = { render: {} };
  const stop = startVideoFrameCollector({ media, streamId: 'legacy-video', store });

  assert.equal(media.requestCount, 1);
  assert.equal(store.render['legacy-video'].frames, 0);
  assert.doesNotThrow(() => media.flush(100, frameMetadata));
  assert.equal(store.render['legacy-video'].frames, 1);
  stop();
});

test('diagnostics record render frames without creating a legacy telemetry store', () => {
  const media = fakeMedia();
  const frames = [];
  const diagnosticsSession = { recordRenderFrame: (frame) => frames.push(frame) };
  delete globalThis.__jumpStreamTelemetry;

  const stop = startVideoFrameCollector({ media, streamId: 'diagnostics-video', diagnosticsSession });

  assert.equal(media.requestCount, 1);
  assert.equal(globalThis.__jumpStreamTelemetry, undefined);
  assert.doesNotThrow(() => media.flush(100, frameMetadata));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].streamId, 'diagnostics-video');
  assert.equal(frames[0].width, 640);
  stop();
});

test('legacy telemetry and diagnostics both receive the same render frame', () => {
  const media = fakeMedia();
  const store = { render: {} };
  const frames = [];
  const diagnosticsSession = { recordRenderFrame: (frame) => frames.push(frame) };
  const stop = startVideoFrameCollector({ media, streamId: 'combined-video', store, diagnosticsSession });

  assert.doesNotThrow(() => media.flush(100, frameMetadata));
  assert.equal(store.render['combined-video'].frames, 1);
  assert.equal(frames.length, 1);
  stop();
  assert.equal(media.cancelCount, 1);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { visibleWindowProcesses, windowHandleFromSourceId } = require('../electron/desktop-media.cjs');

test('maps Electron window source identifiers to native handles', () => {
  assert.equal(windowHandleFromSourceId('window:123456:0'), '123456');
  assert.equal(windowHandleFromSourceId('screen:0:0'), '');
});

test('enumerates visible Windows processes for audio linking', { skip: process.platform !== 'win32' }, async () => {
  const processes = await visibleWindowProcesses();
  assert.ok(Array.isArray(processes));
  assert.ok(processes.every((entry) => Number(entry.Id) > 0));
});

test('starts and stops the native WASAPI loopback bridge', { skip: process.platform !== 'win32' }, async () => {
  const { LoopbackCapture } = require('loopback-capture');
  const capture = new LoopbackCapture();
  let bytes = 0;
  capture.startSystemAudio((chunk) => { bytes += chunk.length; });
  await new Promise((resolve) => setTimeout(resolve, 400));
  capture.stop();
  assert.ok(bytes >= 0);
});

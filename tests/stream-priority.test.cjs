const assert = require('node:assert/strict');
const os = require('node:os');
const test = require('node:test');
const { createStreamPriority, streamProcessIds } = require('../electron/stream-priority.cjs');

const METRICS = [
  { pid: 10, type: 'Browser' },
  { pid: 11, type: 'GPU' },
  { pid: 12, type: 'Tab' },
  { pid: 13, type: 'Utility', serviceName: 'video_capture.mojom.VideoCaptureService' },
  { pid: 14, type: 'Utility', serviceName: 'network.mojom.NetworkService' },
  { pid: 15, type: 'Utility', serviceName: 'audio.mojom.AudioService' },
];

test('boosts capture, compositor/encoder and renderer processes only', () => {
  assert.deepEqual(streamProcessIds(METRICS), [10, 11, 12, 13, 15]);
});

test('raises CPU and GPU priority while sharing and restores it afterwards', async () => {
  const cpu = [];
  const gpu = [];
  const priority = createStreamPriority({
    platform: 'win32',
    getAppMetrics: () => METRICS,
    setPriority: (pid, value) => cpu.push([pid, value]),
    applyGpuPriority: async (pids, value) => { gpu.push([pids, value]); return 'ok'; },
  });
  await priority.set(true);
  await priority.set(true);
  assert.equal(priority.active, true);
  await priority.set(false);
  assert.deepEqual(gpu, [[[10, 11, 12, 13, 15], 4], [[10, 11, 12, 13, 15], 2]]);
  assert.deepEqual(cpu.filter(([pid]) => pid === 11).map(([, value]) => value), [
    os.constants.priority.PRIORITY_ABOVE_NORMAL,
    os.constants.priority.PRIORITY_NORMAL,
  ]);
});

test('is a no-op outside Windows and survives exited processes', async () => {
  let calls = 0;
  const linux = createStreamPriority({ platform: 'linux', getAppMetrics: () => METRICS, applyGpuPriority: async () => { calls += 1; } });
  assert.equal((await linux.set(true)).applied, false);
  assert.equal(calls, 0);
  const windows = createStreamPriority({
    platform: 'win32',
    getAppMetrics: () => METRICS,
    setPriority: () => { throw new Error('ESRCH'); },
    applyGpuPriority: async () => 'ok',
  });
  assert.equal((await windows.set(true)).applied, true);
});

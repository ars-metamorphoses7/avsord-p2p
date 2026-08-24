import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMediasoupWorkerBin } from '../sfu-server.mjs';

test('mediasoup worker uses the executable outside Electron ASAR', () => {
  const linux = '/opt/JUMP/resources/app.asar/node_modules/mediasoup/worker/out/Release/mediasoup-worker';
  const windows = String.raw`C:\JUMP\resources\app.asar\node_modules\mediasoup\worker\out\Release\mediasoup-worker.exe`;
  assert.equal(resolveMediasoupWorkerBin(linux, (candidate) => candidate.includes('app.asar.unpacked')), linux.replace('app.asar', 'app.asar.unpacked'));
  assert.equal(resolveMediasoupWorkerBin(windows, (candidate) => candidate.includes('app.asar.unpacked')), windows.replace('app.asar', 'app.asar.unpacked'));
});

test('mediasoup worker keeps its normal path outside an ASAR package', () => {
  const worker = '/workspace/node_modules/mediasoup/worker/out/Release/mediasoup-worker';
  assert.equal(resolveMediasoupWorkerBin(worker, () => false), worker);
});

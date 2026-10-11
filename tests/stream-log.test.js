import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { streamLogLines, streamLogSnapshot } from '../src/media/streamLog.js';

const require = createRequire(import.meta.url);
const { createStreamLogWriter, sanitizeStreamLogLines } = require('../electron/stream-log.cjs');

function report(entries) {
  return { forEach: (callback) => entries.forEach(callback) };
}

const sender = (frames, encodeSeconds, qpSum, bytes, sourceFrames, cpuSeconds = 0) => report([
  { type: 'codec', id: 'c1', mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=640020' },
  { type: 'outbound-rtp', kind: 'video', codecId: 'c1', framesEncoded: frames, totalEncodeTime: encodeSeconds, qpSum, bytesSent: bytes, frameWidth: 1920, frameHeight: 1080, qualityLimitationDurations: { none: 10, cpu: cpuSeconds }, encoderImplementation: 'NVIDIA', pliCount: 0, nackCount: 2 },
  { type: 'media-source', kind: 'video', frames: sourceFrames },
  { type: 'remote-inbound-rtp', kind: 'video', packetsLost: 1 },
  { type: 'candidate-pair', nominated: true, state: 'succeeded', availableOutgoingBitrate: 18e6, currentRoundTripTime: 0.031 },
]);

test('sender line reports capture/encode rate, QP, bitrate, codec profile and CPU limitation', () => {
  const before = streamLogSnapshot(sender(0, 0, 0, 0, 0), 0);
  const after = streamLogSnapshot(sender(600, 4.2, 12_000, 15_000_000, 590, 2), 10_000);
  const [line] = streamLogLines('p2p:abc', before, after);
  assert.match(line, /^envio p2p:abc 1920x1080 captura=59 encode=60fps 7ms qp=20 12Mb\/s est=18Mb\/s rtt=31ms/);
  assert.match(line, /limitado=cpu:2s H264\/6400 NVIDIA$/);
});

test('viewer line reports smoothness: fps, interval jitter, freezes, buffer and loss', () => {
  const inbound = (frames, interFrame, squared, freezes, lost) => report([
    { type: 'inbound-rtp', kind: 'video', framesDecoded: frames, framesDropped: 0, totalDecodeTime: frames * 0.001, freezeCount: freezes, totalFreezesDuration: freezes * 0.2, totalInterFrameDelay: interFrame, totalSquaredInterFrameDelay: squared, jitterBufferDelay: frames * 0.03, jitterBufferEmittedCount: frames, packetsLost: lost, bytesReceived: frames * 25_000, frameWidth: 1920, frameHeight: 1080, keyFramesDecoded: 1 },
  ]);
  const before = streamLogSnapshot(inbound(0, 0, 0, 0, 0), 0);
  // 500 frames, 20 ms apart on average with a 5 ms deviation.
  const after = streamLogSnapshot(inbound(500, 10, 500 * (0.02 ** 2 + 0.005 ** 2), 2, 7), 10_000);
  const [line] = streamLogLines('sfu:x', before, after);
  assert.match(line, /^recebe sfu:x 1920x1080 50fps intervalo=20±5ms travadas=2\(400ms\) descartados=0 decode=1ms buffer=30ms 10Mb\/s perdidos=7 keyframes=0/);
});

test('idle streams and the first snapshot produce no lines', () => {
  const snapshot = streamLogSnapshot(sender(10, 0.1, 100, 1000, 10), 0);
  assert.deepEqual(streamLogLines('p2p:a', null, snapshot), []);
  assert.deepEqual(streamLogLines('p2p:a', snapshot, { ...snapshot, t: 10_000 }), []);
});

test('writer stamps lines, writes the header once and rotates a large file', async () => {
  const files = new Map([['/d/log.txt', 'x'.repeat(50)]]);
  const fsApi = {
    mkdir: async () => {},
    stat: async (file) => { if (!files.has(file)) throw new Error('ENOENT'); return { size: files.get(file).length }; },
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    appendFile: async (file, text) => { files.set(file, (files.get(file) || '') + text); },
  };
  const now = () => new Date(2026, 9, 10, 21, 5, 9);
  await createStreamLogWriter({ filePath: '/d/log.txt', fsApi, now, maxBytes: 40 }).append(['envio a']);
  assert.equal(files.get('/d/log.txt.1'), 'x'.repeat(50));
  assert.equal(files.get('/d/log.txt'), '2026-10-10 21:05:09 envio a\n');
  files.clear();
  const writer = createStreamLogWriter({ filePath: '/d/log.txt', header: '--- JUMP', fsApi, now });
  await writer.append(['envio a']);
  await writer.append(['recebe b']);
  assert.equal(files.get('/d/log.txt'), '2026-10-10 21:05:09 --- JUMP\n2026-10-10 21:05:09 envio a\n2026-10-10 21:05:09 recebe b\n');
  assert.deepEqual(sanitizeStreamLogLines(['a\nb', 3, 'c'.repeat(900)]).map((line) => line.length), [3, 800]);
});

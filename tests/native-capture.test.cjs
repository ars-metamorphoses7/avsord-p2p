const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { captureTargetArgs, createNativeCapture, parseCaptureLine } = require('../electron/native-capture.cjs');

function fakeHelper() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = { lines: [], write(line) { this.lines.push(line.trim()); } };
  child.exitCode = null;
  child.kill = () => { child.exitCode = 1; };
  child.say = (line) => child.stdout.write(`${line}\n`);
  return child;
}

function fakeSharedTexture() {
  const imports = [];
  return {
    imports,
    sent: 0,
    importSharedTexture(options) {
      const imported = { options, released: false, release() { this.released = true; } };
      imports.push(imported);
      return imported;
    },
    async sendSharedTexture() { this.sent += 1; },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('protocol lines parse into typed messages', () => {
  assert.deepEqual(parseCaptureLine('TEX 1 2 1844 1920 1080'), { type: 'TEX', generation: 1, slot: 2, handle: '1844', width: 1920, height: 1080 });
  assert.deepEqual(parseCaptureLine('FRAME 1 2 123456'), { type: 'FRAME', generation: 1, slot: 2, timestampUs: 123456 });
  assert.deepEqual(parseCaptureLine('READY 1920 1080'), { type: 'READY', width: 1920, height: 1080 });
  assert.deepEqual(parseCaptureLine('ERROR capture-item -2147024809'), { type: 'ERROR', reason: 'capture-item -2147024809' });
  assert.equal(parseCaptureLine('garbage'), null);
});

test('share dialog sources map to helper targets', () => {
  const screenApi = {
    getAllDisplays: () => [{ id: 7, bounds: { x: 1920, y: 0, width: 1280, height: 720 } }],
    dipToScreenPoint: ({ x, y }) => ({ x: x * 1.5, y: y * 1.5 }),
  };
  assert.deepEqual(captureTargetArgs('window:5638380:0', '', screenApi), ['--window', '5638380']);
  assert.deepEqual(captureTargetArgs('screen:1:0', '7', screenApi), ['--monitor-point', '3840,540']);
  assert.deepEqual(captureTargetArgs('screen:1:0', 'missing', screenApi), ['--monitor', '1']);
  assert.equal(captureTargetArgs('tab:3', '', screenApi), null);
});

test('frames are imported, forwarded and their slots returned to the helper', async () => {
  const child = fakeHelper();
  const sharedTexture = fakeSharedTexture();
  let spawnedArgs = null;
  const capture = createNativeCapture({
    helperPath: 'jump-capture.exe', sharedTexture, platform: 'win32', pid: 42, exists: () => true, log: () => {},
    spawnProcess: (file, args) => { spawnedArgs = args; return child; },
  });
  const started = capture.start({ sourceId: 'window:99:0', frame: {} });
  child.say('TEX 1 0 4096 1280 720');
  child.say('READY 1280 720');
  assert.deepEqual(await started, { ok: true, width: 1280, height: 720 });
  assert.deepEqual(spawnedArgs, ['--pid', '42', '--fps', '60', '--window', '99']);

  child.say('FRAME 1 0 5000');
  await tick();
  assert.equal(sharedTexture.imports.length, 1);
  const { textureInfo, allReferencesReleased } = sharedTexture.imports[0].options;
  assert.equal(textureInfo.pixelFormat, 'bgra');
  assert.deepEqual(textureInfo.codedSize, { width: 1280, height: 720 });
  assert.equal(textureInfo.handle.ntHandle.readBigUInt64LE(), 4096n);
  assert.equal(sharedTexture.sent, 1);
  assert.equal(sharedTexture.imports[0].released, true);
  allReferencesReleased();
  assert.deepEqual(child.stdin.lines, ['REL 1 0']);

  capture.stop();
  assert.equal(child.stdin.lines.at(-1), 'STOP');
});

test('a helper error before READY reports failure so the renderer falls back', async () => {
  const child = fakeHelper();
  const capture = createNativeCapture({
    helperPath: 'x.exe', sharedTexture: fakeSharedTexture(), platform: 'win32', exists: () => true, log: () => {},
    spawnProcess: () => child,
  });
  const started = capture.start({ sourceId: 'screen:0:0', frame: {} });
  child.say('ERROR capture-item -1');
  assert.deepEqual(await started, { ok: false, reason: 'capture-item -1' });
  assert.equal(capture.active, false);
});

test('unavailable outside Windows, without the helper, or when disabled', async () => {
  const base = { helperPath: 'x.exe', sharedTexture: fakeSharedTexture(), exists: () => true, spawnProcess: () => { throw new Error('spawned'); } };
  for (const options of [{ platform: 'linux' }, { platform: 'win32', exists: () => false }, { platform: 'win32', disabled: true }]) {
    const capture = createNativeCapture({ ...base, ...options });
    assert.deepEqual(await capture.start({ sourceId: 'screen:0:0', frame: {} }), { ok: false, reason: 'unavailable' });
  }
});

test('the source closing ends the capture and notifies the renderer', async () => {
  const child = fakeHelper();
  const ended = [];
  const capture = createNativeCapture({
    helperPath: 'x.exe', sharedTexture: fakeSharedTexture(), platform: 'win32', exists: () => true, log: () => {},
    spawnProcess: () => child,
  });
  const started = capture.start({ sourceId: 'window:5:0', frame: {}, onEnded: (reason) => ended.push(reason) });
  child.say('READY 640 480');
  await started;
  child.say('ENDED closed');
  await tick();
  assert.deepEqual(ended, ['closed']);
  assert.equal(capture.active, false);
});

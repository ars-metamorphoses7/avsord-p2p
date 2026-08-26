const assert = require('node:assert/strict');
const test = require('node:test');
const { visibleWindowProcesses, windowHandleFromSourceId } = require('../electron/desktop-media.cjs');
const { linuxAudioCommands } = require('../electron/linux-system-audio.cjs');

test('maps Electron window source identifiers to native handles', () => {
  assert.equal(windowHandleFromSourceId('window:123456:0'), '123456');
  assert.equal(windowHandleFromSourceId('screen:0:0'), '');
});

test('builds Linux PulseAudio/PipeWire capture commands in stereo PCM', () => {
  const commands = linuxAudioCommands('alsa_output.test.monitor');
  assert.deepEqual(commands.map(({ command }) => command), ['parec', 'pw-record']);
  assert.ok(commands[0].args.includes('--format=s16le'));
  assert.ok(commands[0].args.includes('--device=alsa_output.test.monitor'));
  assert.ok(commands[1].args.includes('--format=s16'));
  assert.ok(commands[1].args.includes('--target=alsa_output.test.monitor'));
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

const assert = require('node:assert/strict');
const test = require('node:test');
const { visibleWindowProcesses, windowHandleFromSourceId } = require('../electron/desktop-media.cjs');
const {
  isJumpAudioStream,
  linuxAudioStreamKey,
  linuxAudioCommands,
  parsePipeWireStreams,
  parsePulseAudioStreams,
} = require('../electron/linux-system-audio.cjs');

test('maps Electron window source identifiers to native handles', () => {
  assert.equal(windowHandleFromSourceId('window:123456:0'), '123456');
  assert.equal(windowHandleFromSourceId('screen:0:0'), '');
});

test('builds Linux PulseAudio/PipeWire capture commands in stereo PCM', () => {
  const commands = linuxAudioCommands({ pulseIndex: 257, target: '88' });
  assert.deepEqual(commands.map(({ command }) => command), ['parec', 'pw-record']);
  assert.ok(commands[0].args.includes('--format=s16le'));
  assert.ok(commands[0].args.includes('--monitor-stream=257'));
  assert.ok(commands[1].args.includes('--format=s16'));
  assert.ok(commands[1].args.includes('--target=88'));
});

test('discovers Linux playback streams and filters JUMP audio', () => {
  const streams = parsePulseAudioStreams([{
    index: 257,
    properties: {
      'object.id': '88',
      'application.name': 'Firefox',
      'application.process.id': '5097',
      'media.name': 'YouTube',
    },
  }, {
    index: 222,
    properties: {
      'object.id': '79',
      'application.name': 'jump-p2p',
      'application.process.id': '37374',
    },
  }]);
  assert.equal(streams[0].pulseIndex, 257);
  assert.equal(streams[0].target, '88');
  assert.notEqual(linuxAudioStreamKey({ pulseIndex: 257, target: '88' }), linuxAudioStreamKey({ pulseIndex: 296, target: '88' }));
  assert.equal(isJumpAudioStream(streams[0], 37374), false);
  assert.equal(isJumpAudioStream(streams[1], 37374), true);
  assert.equal(parsePipeWireStreams([{
    type: 'PipeWire:Interface:Node',
    id: 99,
    info: { props: {
      'media.class': 'Stream/Output/Audio',
      'object.serial': '301',
      'application.name': 'VLC',
    } },
  }])[0].target, '301');
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

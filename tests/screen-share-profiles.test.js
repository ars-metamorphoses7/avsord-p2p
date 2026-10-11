import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCREEN_SHARE_PROFILES,
  STREAM_LEVELS,
  applyStreamSender,
  configureVideoSender,
  evenScreenCaptureConstraints,
  evaluatePlaybackBufferAdaptation,
  evaluateStream,
  h264ProfileRank,
  initialPlaybackBufferAdaptation,
  initialStreamState,
  isSoftwareH264Encoder,
  normalizeScreenShareProfileId,
  safeVideoSenderScale,
  screenCaptureConstraints,
  screenShareCodecOrder,
  streamEncodingParameters,
} from '../src/media/screenShareProfiles.js';

function fakeSender(settings = { width: 1920, height: 1080 }) {
  return {
    calls: 0,
    track: { getSettings: () => settings },
    parameters: { encodings: [{}] },
    getParameters() { return structuredClone(this.parameters); },
    async setParameters(parameters) { this.calls += 1; this.parameters = parameters; },
  };
}

const HEALTHY = {
  availableOutgoingBitrate: 20_000_000,
  captureFps: 60,
  framesPerSecond: 60,
  qualityLimitationReason: 'none',
  powerEfficientEncoder: true,
  encoderImplementation: 'MediaFoundationVideoEncodeAccelerator',
  codec: { mimeType: 'video/H264' },
};

function run(samples, state = initialStreamState()) {
  const changes = [];
  for (const diagnostics of samples) {
    const previous = state;
    state = evaluateStream(state, diagnostics);
    if (state.level !== previous.level || state.temporalLevel !== previous.temporalLevel) {
      changes.push({ sample: state.sampleCount, level: state.level, temporalLevel: state.temporalLevel, reason: state.reason });
    }
  }
  return { state, changes };
}

const repeat = (count, diagnostics) => Array.from({ length: count }, () => diagnostics);

test('there is a single automatic mode up to 1080p60', () => {
  assert.deepEqual(Object.keys(SCREEN_SHARE_PROFILES), ['auto']);
  const constraints = screenCaptureConstraints('auto', 'window:123:0');
  assert.equal(constraints.mandatory.maxWidth, 1920);
  assert.equal(constraints.mandatory.maxHeight, 1080);
  assert.equal(constraints.mandatory.maxFrameRate, 60);
  assert.equal(SCREEN_SHARE_PROFILES.auto.contentHint, 'motion');
});

test('legacy profile ids from old clients and saved settings map to auto', () => {
  for (const id of ['performance', 'quality', 'competitive', 'fluid', 'balanced', 'detail', 'unknown', undefined]) {
    assert.equal(normalizeScreenShareProfileId(id), 'auto');
  }
});

test('field replay: a clean link with a 52 FPS capture never changes resolution', () => {
  // 389e4c86: 0 loss, 27 ms RTT, ~52 FPS received; the old controller switched
  // resolution 63 times in 14 minutes on this input.
  const { state, changes } = run(repeat(600, { ...HEALTHY, captureFps: 52, framesPerSecond: 52 }));
  assert.deepEqual(changes, []);
  assert.equal(state.level, 0);
  assert.equal(state.frameRate, 60);
});

test('a starved capture (heavy game or static screen) never costs resolution', () => {
  for (const fps of [15, 3, 0.5]) {
    const { changes } = run(repeat(200, { ...HEALTHY, captureFps: fps, framesPerSecond: fps }));
    assert.deepEqual(changes, [], `capture ${fps} FPS`);
  }
});

test('missing stats are neutral', () => {
  const { changes } = run(repeat(200, {
    availableOutgoingBitrate: null, captureFps: null, framesPerSecond: null, qualityLimitationReason: 'none',
  }));
  assert.deepEqual(changes, []);
});

test('the GCC ramp-up at startup is not judged as low bandwidth', () => {
  const ramp = [500_000, 900_000, 1_500_000, 2_500_000, 4_000_000, 6_000_000, 9_000_000, 12_000_000]
    .map((availableOutgoingBitrate) => ({ ...HEALTHY, availableOutgoingBitrate }));
  const { changes } = run([...ramp, ...repeat(100, HEALTHY)]);
  assert.deepEqual(changes, []);
});

test('isolated estimate dips stay at the current resolution', () => {
  const dip = { ...HEALTHY, availableOutgoingBitrate: 1_000_000 };
  const pattern = [...repeat(10, HEALTHY), dip, dip, ...repeat(4, HEALTHY), dip, HEALTHY, dip, ...repeat(5, HEALTHY)];
  const { changes } = run([...pattern, ...pattern, ...pattern, ...pattern]);
  assert.deepEqual(changes, []);
});

test('a sustained low estimate steps down one level at a time with a hold between steps', () => {
  const { state, changes } = run([
    ...repeat(10, HEALTHY),
    ...repeat(30, { ...HEALTHY, availableOutgoingBitrate: 1_500_000 }),
  ]);
  assert.deepEqual(changes.map((change) => [change.level, change.reason]), [[1, 'bandwidth'], [2, 'bandwidth']]);
  assert.ok(changes[1].sample - changes[0].sample >= 6);
  assert.equal(state.level, STREAM_LEVELS.length - 1);
});

test('recovery waits, then restores one level; a failed retry doubles the wait', () => {
  const low = { ...HEALTHY, availableOutgoingBitrate: 3_000_000 };
  let { state, changes } = run([...repeat(10, HEALTHY), ...repeat(8, low)]);
  assert.equal(state.level, 1);
  const downAt = changes[0].sample;

  ({ state, changes } = run(repeat(30, HEALTHY), state));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].level, 0);
  assert.equal(changes[0].reason, 'recovery');
  assert.equal(changes[0].sample - downAt, 20);

  ({ state, changes } = run(repeat(8, low), state));
  assert.equal(state.level, 1);
  assert.equal(state.upgradeWaitSamples, 40);
  const failedAt = changes[0].sample;

  ({ state, changes } = run(repeat(39 - (state.sampleCount - failedAt), HEALTHY), state));
  assert.deepEqual(changes, []);
  ({ state, changes } = run(repeat(1, HEALTHY), state));
  assert.equal(state.level, 0);
  assert.equal(changes[0].sample - failedAt, 40);
});

test('recovery needs estimate headroom for the richer level', () => {
  const low = { ...HEALTHY, availableOutgoingBitrate: 3_000_000 };
  let { state } = run([...repeat(10, HEALTHY), ...repeat(8, low)]);
  assert.equal(state.level, 1);
  // Above the 720p floor but below 1.5x the 1080p floor.
  ({ state } = run(repeat(100, { ...HEALTHY, availableOutgoingBitrate: 5_000_000 }), state));
  assert.equal(state.level, 1);
});

test('an encoder that drops captured frames loses pixels, then cadence', () => {
  const behind = { ...HEALTHY, captureFps: 60, framesPerSecond: 35 };
  const { state, changes } = run([...repeat(10, HEALTHY), ...repeat(40, behind)]);
  assert.deepEqual(changes.map((change) => [change.level, change.temporalLevel, change.reason]), [
    [1, 0, 'encoder'],
    [2, 0, 'encoder'],
    [2, 1, 'encoder'],
  ]);
  assert.equal(state.frameRate, 30);
});

test('a 30 FPS cap does not look like an encoder deficit', () => {
  let state = { ...initialStreamState(), temporalLevel: 1, frameRate: 30, level: 2 };
  ({ state } = run(repeat(15, { ...HEALTHY, captureFps: 60, framesPerSecond: 30 }), state));
  assert.equal(state.temporalLevel, 1);
  assert.equal(state.level, 2);
});

test('a software encoder starts at 720p30', () => {
  const { state, changes } = run([{ ...HEALTHY, powerEfficientEncoder: false, encoderImplementation: 'libvpx', codec: { mimeType: 'video/VP8' }, framesEncoded: 10 }]);
  assert.deepEqual(changes.map((change) => [change.level, change.temporalLevel, change.reason]), [[1, 1, 'software-encoder-start']]);
  assert.equal(state.softwareEncoder, true);
  assert.deepEqual(initialStreamState({ softwareEncoder: true }).frameRate, 30);
});

test('sender gets a fixed 1080p60 ceiling that never follows the estimate', async () => {
  const sender = fakeSender();
  const state = initialStreamState();
  assert.equal(await applyStreamSender(sender, state, { peerCount: 2 }), true);
  assert.deepEqual(
    [sender.parameters.encodings[0].maxBitrate, sender.parameters.encodings[0].maxFramerate, sender.parameters.encodings[0].scaleResolutionDownBy],
    [20_000_000, 60, 1],
  );
  assert.equal(sender.parameters.degradationPreference, 'maintain-resolution');
  await applyStreamSender(sender, evaluateStream(state, { ...HEALTHY, availableOutgoingBitrate: 2_000_000 }), { peerCount: 2 });
  assert.equal(sender.calls, 1, 'an unchanged operating point must not reconfigure the encoder');
});

test('lower levels scale the real source and keep even dimensions', async () => {
  const sender = fakeSender();
  await applyStreamSender(sender, { ...initialStreamState(), level: 1 }, { sourceWidth: 1920, sourceHeight: 1080 });
  assert.equal(Math.round(1080 / sender.parameters.encodings[0].scaleResolutionDownBy), 720);
  assert.equal(sender.parameters.encodings[0].maxBitrate, 10_000_000);

  const ultrawide = streamEncodingParameters({ level: 2, temporalLevel: 1 }, { sourceWidth: 1920, sourceHeight: 804 });
  const height = Math.round(804 / ultrawide.scaleResolutionDownBy);
  assert.ok(height >= 360 && height % 2 === 0);
  assert.equal(Math.round(1920 / ultrawide.scaleResolutionDownBy) % 2, 0);
  assert.equal(ultrawide.maxFramerate, 30);
});

test('large meshes share the uplink ceiling', () => {
  assert.equal(streamEncodingParameters(initialStreamState(), {}, 2).maxBitrate, 20_000_000);
  assert.equal(streamEncodingParameters(initialStreamState(), {}, 3).maxBitrate, 15_000_000);
});

test('configuring a reused sender clears an old adaptive screen scale', async () => {
  const sender = fakeSender();
  sender.parameters.encodings[0].scaleResolutionDownBy = 2;
  await configureVideoSender(sender, 'auto', 1);
  assert.equal(sender.parameters.encodings[0].scaleResolutionDownBy, 1);
});

test('codec policy keeps H.264 first when hardware encoding is available', () => {
  assert.deepEqual(screenShareCodecOrder('auto', {
    hardwareVideoEncoding: true,
    videoEncode: 'enabled',
  }), ['video/H264', 'video/VP9', 'video/VP8']);
});

test('codec policy avoids OpenH264 when the runtime reports software-only encoding', () => {
  assert.deepEqual(screenShareCodecOrder('auto', {
    hardwareVideoEncoding: false,
    videoEncode: 'disabled_software',
  }), ['video/VP8', 'video/H264', 'video/VP9']);
  assert.deepEqual(screenShareCodecOrder('auto', {
    hardwareVideoEncoding: false,
    videoEncode: 'disabled_software',
    preferredSoftwareCodec: 'VP9',
  }), ['video/VP9', 'video/H264', 'video/VP8']);
});

test('actual H.264 implementation overrides an optimistic GPU capability probe', () => {
  assert.equal(isSoftwareH264Encoder({
    codec: { mimeType: 'video/H264' },
    encoderImplementation: 'OpenH264',
    powerEfficientEncoder: false,
  }), true);
  assert.equal(isSoftwareH264Encoder({
    codec: { mimeType: 'video/H264' },
    encoderImplementation: 'VaapiVideoEncoder',
    powerEfficientEncoder: true,
  }), false);
  assert.equal(isSoftwareH264Encoder({
    codec: { mimeType: 'video/VP8' },
    encoderImplementation: 'libvpx',
    powerEfficientEncoder: false,
  }), false);
});

test('sender scale keeps arbitrary H.264 window dimensions even', () => {
  const scale = safeVideoSenderScale(2, { sourceWidth: 1918, sourceHeight: 1080 });
  assert.equal(Math.round(1918 / scale) % 2, 0);
  assert.equal(Math.round(1080 / scale) % 2, 0);
  assert.ok(Math.abs(scale - 2) < 0.02);
});

test('sender scale finds even dimensions between width and height rounding boundaries', () => {
  for (const dimensions of [
    { sourceWidth: 401, sourceHeight: 402, requestedScale: 4 / 3 },
    { sourceWidth: 641, sourceHeight: 362, requestedScale: 1 },
  ]) {
    const scale = safeVideoSenderScale(dimensions.requestedScale, dimensions);
    assert.equal(Math.round(dimensions.sourceWidth / scale) % 2, 0);
    assert.equal(Math.round(dimensions.sourceHeight / scale) % 2, 0);
    assert.ok(Math.round(dimensions.sourceHeight / scale) >= 360);
  }
});

test('odd capture dimensions request a one-pixel crop before H.264', () => {
  assert.deepEqual(evenScreenCaptureConstraints('auto', { width: 1279, height: 721 }), {
    width: { exact: 1278 },
    height: { exact: 720 },
    frameRate: { ideal: 60, max: 60 },
    resizeMode: 'crop-and-scale',
  });
  assert.equal(evenScreenCaptureConstraints('auto', { width: 1280, height: 720 }), null);
});

test('compatibility receiver buffer grows on jitter/freezes and decays slowly', () => {
  let state = evaluatePlaybackBufferAdaptation(initialPlaybackBufferAdaptation('auto'), 'auto', {
    jitterMs: 5, freezeCount: 0, framesDropped: 0,
  });
  assert.equal(state.targetMs, 140);
  state = evaluatePlaybackBufferAdaptation(state, 'auto', { jitterMs: 60, freezeCount: 1, framesDropped: 0 });
  assert.equal(state.targetMs, 360);
  assert.equal(state.reason, 'freeze-protection');
  for (let sample = 0; sample < 5; sample += 1) {
    state = evaluatePlaybackBufferAdaptation(state, 'auto', { jitterMs: 0, freezeCount: 1, framesDropped: 0 });
  }
  assert.equal(state.targetMs, 345);
  assert.equal(state.reason, 'stable-decay');
});

test('H.264 High is preferred over Main and Baseline, packetization-mode 1 first', () => {
  const codec = (fmtp) => ({ mimeType: 'video/H264', sdpFmtpLine: fmtp });
  const ordered = [
    codec('level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f'),
    codec('level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=640020'),
    codec('level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f'),
    codec('level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640020'),
    codec('level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'),
  ].sort((a, b) => h264ProfileRank(a) - h264ProfileRank(b)).map((entry) => /packetization-mode=(\d);profile-level-id=(\w+)/.exec(entry.sdpFmtpLine).slice(1).join(':'));
  assert.deepEqual(ordered, ['1:640020', '0:640020', '1:4d001f', '1:42e01f', '1:42001f']);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const {
  FIELD_DIAGNOSTICS_PREFERENCE_FILENAME,
  STREAM_DIAGNOSTICS_SWITCH,
  fieldDiagnosticsRelaunchArguments,
  fieldDiagnosticsPreferencePath,
  normalizeFieldDiagnosticsPreference,
  openFieldDiagnosticsDirectory,
  readFieldDiagnosticsPreference,
  readBuildMetadata,
  resolveFieldDiagnosticsRelaunchOptions,
  resolveValidAppImagePath,
  requestFieldDiagnosticsRelaunch,
  resolveDiagnosticsBuildInfo,
  resolveStreamDiagnosticsActivation,
  writeFieldDiagnosticsPreference,
} = require('../electron/field-run-diagnostics.cjs');

test('diagnostics activation follows environment, CLI, preference, then off precedence', () => {
  assert.deepEqual(resolveStreamDiagnosticsActivation({ environment: {}, argv: ['jump.exe'] }), {
    enabled: false,
    activationSource: 'off',
    forcedByEnvironment: false,
  });
  assert.deepEqual(resolveStreamDiagnosticsActivation({ environment: {}, argv: ['jump.exe', STREAM_DIAGNOSTICS_SWITCH] }), {
    enabled: true,
    activationSource: 'cli',
    forcedByEnvironment: false,
  });
  assert.deepEqual(resolveStreamDiagnosticsActivation({
    environment: { JUMP_STREAM_DIAGNOSTICS: '1' },
    argv: ['jump.exe', STREAM_DIAGNOSTICS_SWITCH],
    persistedPreference: { enabled: false },
  }), {
    enabled: true,
    activationSource: 'environment',
    forcedByEnvironment: true,
  });
  assert.deepEqual(resolveStreamDiagnosticsActivation({
    environment: {},
    argv: ['jump.exe'],
    persistedPreference: { enabled: true },
  }), {
    enabled: true,
    activationSource: 'preference',
    forcedByEnvironment: false,
  });
  assert.deepEqual(resolveStreamDiagnosticsActivation({
    environment: {},
    argv: ['jump.exe'],
    persistedPreference: { enabled: false },
  }), {
    enabled: false,
    activationSource: 'off',
    forcedByEnvironment: false,
  });
});

test('field diagnostics preference is safe, boolean-only, and stored below userData', async () => {
  assert.equal(FIELD_DIAGNOSTICS_PREFERENCE_FILENAME, 'field-diagnostics.json');
  assert.equal(normalizeFieldDiagnosticsPreference({ enabled: true }), true);
  assert.equal(normalizeFieldDiagnosticsPreference({ enabled: 'true' }), null);
  assert.equal(normalizeFieldDiagnosticsPreference('invalid'), null);
  const userDataDirectory = path.join('test-user-data');
  assert.equal(fieldDiagnosticsPreferencePath(userDataDirectory), path.join(userDataDirectory, 'field-diagnostics.json'));

  const calls = [];
  await writeFieldDiagnosticsPreference('C:\\Users\\tester\\field-diagnostics.json', true, {
    mkdir: async (...args) => calls.push(['mkdir', ...args]),
    writeFile: async (...args) => calls.push(['writeFile', ...args]),
  });
  assert.equal(calls[0][0], 'mkdir');
  assert.deepEqual(JSON.parse(calls[1][2]), { enabled: true });
  assert.equal(calls[1][3], 'utf8');
  assert.deepEqual(await readFieldDiagnosticsPreference('ignored', async () => calls[1][2]), { enabled: true });
  assert.equal(await readFieldDiagnosticsPreference('ignored', async () => '{"enabled":"yes"}'), null);
  assert.equal(await readFieldDiagnosticsPreference('missing', async () => { throw new Error('missing'); }), null);
  await assert.rejects(() => writeFieldDiagnosticsPreference('ignored', 'yes'), TypeError);
});

test('enabling field diagnostics persists before relaunch and removes stale deep links/switches', async () => {
  const calls = [];
  const app = {
    relaunch: (options) => calls.push(['relaunch', options]),
    quit: () => calls.push(['quit']),
  };
  const result = await requestFieldDiagnosticsRelaunch({
    app,
    action: 'enable',
    activation: { enabled: false, activationSource: 'off', forcedByEnvironment: false },
    argv: ['jump.exe', '.', '--inspect=9229', STREAM_DIAGNOSTICS_SWITCH, 'jump://join?room=old'],
    preferencePath: 'C:\\Users\\tester\\field-diagnostics.json',
    writePreference: async (filePath, enabled) => calls.push(['write', filePath, enabled]),
  });
  assert.equal(result.relaunchRequested, true);
  assert.deepEqual(result.args, ['.', '--inspect=9229']);
  assert.equal(result.activationSource, 'preference');
  assert.deepEqual(calls, [
    ['write', 'C:\\Users\\tester\\field-diagnostics.json', true],
    ['relaunch', { args: ['.', '--inspect=9229'] }],
    ['quit'],
  ]);
});

test('disabling field diagnostics persists false, removes the legacy switch, and restarts', async () => {
  assert.deepEqual(
    fieldDiagnosticsRelaunchArguments(['jump.exe', '.', '--trace-warnings', STREAM_DIAGNOSTICS_SWITCH], false),
    ['.', '--trace-warnings'],
  );
  const calls = [];
  const result = await requestFieldDiagnosticsRelaunch({
    app: { relaunch: (options) => calls.push(['relaunch', options]), quit: () => calls.push(['quit']) },
    action: 'disable',
    activation: { enabled: true, activationSource: 'preference', forcedByEnvironment: false },
    argv: ['jump.exe', '.', STREAM_DIAGNOSTICS_SWITCH, 'jump://join?room=old'],
    environment: { JUMP_STREAM_DIAGNOSTICS: '1' },
    preferencePath: 'C:\\Users\\tester\\field-diagnostics.json',
    writePreference: async (_filePath, enabled) => calls.push(['write', enabled]),
  });
  assert.deepEqual(result, {
    relaunchRequested: true,
    action: 'disable',
    args: ['.'],
    execPath: null,
    activationSource: 'off',
  });
  assert.deepEqual(calls, [
    ['write', false],
    ['relaunch', { args: ['.'] }],
    ['quit'],
  ]);

  const forcedCalls = [];
  const forcedResult = await requestFieldDiagnosticsRelaunch({
    app: { relaunch: () => calls.push('relaunch'), quit: () => calls.push('quit') },
    action: 'disable',
    activation: { enabled: true, activationSource: 'environment', forcedByEnvironment: true },
    argv: ['jump.exe', STREAM_DIAGNOSTICS_SWITCH],
    preferencePath: 'C:\\Users\\tester\\field-diagnostics.json',
    writePreference: async () => forcedCalls.push('write'),
  });
  assert.deepEqual(forcedResult, {
    relaunchRequested: false,
    reason: 'environment-forced',
    activationSource: 'environment',
  });
  assert.deepEqual(forcedCalls, []);
});

test('relaunch failure leaves the persisted preference in place', async () => {
  const calls = [];
  const result = await requestFieldDiagnosticsRelaunch({
    app: {
      relaunch: () => { calls.push('relaunch'); throw new Error('appImage unavailable'); },
      quit: () => calls.push('quit'),
    },
    action: 'enable',
    activation: { enabled: false, activationSource: 'off', forcedByEnvironment: false },
    platform: 'linux',
    environment: { APPIMAGE: '/home/user/JUMP.AppImage' },
    argv: ['JUMP.AppImage', 'jump://join?room=old'],
    preferencePath: '/home/user/.config/JUMP/field-diagnostics.json',
    writePreference: async (_filePath, enabled) => calls.push(['write', enabled]),
    access: async () => {},
  });
  assert.deepEqual(result, {
    relaunchRequested: false,
    action: 'enable',
    reason: 'relaunch-failed',
    preferencePersisted: true,
    error: 'appImage unavailable',
  });
  assert.deepEqual(calls, [['write', true], 'relaunch']);
});

test('Linux AppImage uses a validated original executable, while deb and Windows use normal relaunch', async () => {
  const appImage = resolveFieldDiagnosticsRelaunchOptions({
    platform: 'linux',
    environment: { APPIMAGE: '/home/user/JUMP.AppImage' },
    argv: ['/tmp/.mount-JUMP/JUMP', '.', 'jump://join?room=old'],
  });
  assert.deepEqual(appImage, { args: ['.'], execPath: '/home/user/JUMP.AppImage' });
  assert.deepEqual(resolveFieldDiagnosticsRelaunchOptions({
    platform: 'linux',
    environment: {},
    argv: ['/usr/bin/JUMP', '.'],
  }), { args: ['.'] });
  assert.deepEqual(resolveFieldDiagnosticsRelaunchOptions({
    platform: 'win32',
    environment: { APPIMAGE: 'ignored' },
    argv: ['JUMP.exe', '.'],
  }), { args: ['.'] });
  assert.equal(await resolveValidAppImagePath({ APPIMAGE: '/home/user/JUMP.AppImage' }, async () => {}), '/home/user/JUMP.AppImage');
  assert.equal(await resolveValidAppImagePath({ APPIMAGE: '/home/user/missing.AppImage' }, async () => { throw new Error('missing'); }), '');
});

test('config build info uses a valid override first and otherwise reads embedded metadata', async () => {
  const metadata = await readBuildMetadata('embedded-build-metadata.json', async () => JSON.stringify({
    version: '1.0.25',
    commit: 'e304baaad71c3114290f06c790d228319132078d',
    builtAt: '2026-08-29T20:00:00.000Z',
  }));
  assert.deepEqual(resolveDiagnosticsBuildInfo({ appVersion: '43.4.1', buildMetadata: metadata }), {
    appVersion: '1.0.25',
    appCommit: 'e304baaad71c3114290f06c790d228319132078d',
  });
  assert.deepEqual(resolveDiagnosticsBuildInfo({
    appVersion: '1.0.25',
    commitOverride: 'diagnostics-integration-test',
    buildMetadata: metadata,
  }), {
    appVersion: '1.0.25',
    appCommit: 'diagnostics-integration-test',
  });
});

test('opening the diagnostics folder only uses the main-owned output directory', async () => {
  const calls = [];
  const result = await openFieldDiagnosticsDirectory({
    outputDirectory: 'C:\\Users\\receiver\\AppData\\Roaming\\JUMP\\diagnostics\\screen-share',
    mkdir: async (...args) => calls.push(['mkdir', ...args]),
    openPath: async (directory) => {
      calls.push(['openPath', directory]);
      return '';
    },
  });
  assert.deepEqual(result, {
    opened: true,
    outputDirectory: 'C:\\Users\\receiver\\AppData\\Roaming\\JUMP\\diagnostics\\screen-share',
    error: null,
  });
  assert.deepEqual(calls, [
    ['mkdir', 'C:\\Users\\receiver\\AppData\\Roaming\\JUMP\\diagnostics\\screen-share', { recursive: true }],
    ['openPath', 'C:\\Users\\receiver\\AppData\\Roaming\\JUMP\\diagnostics\\screen-share'],
  ]);
});

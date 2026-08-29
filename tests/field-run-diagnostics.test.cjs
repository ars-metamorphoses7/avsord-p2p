const assert = require('node:assert/strict');
const test = require('node:test');
const {
  STREAM_DIAGNOSTICS_SWITCH,
  fieldDiagnosticsRelaunchArguments,
  openFieldDiagnosticsDirectory,
  readBuildMetadata,
  requestFieldDiagnosticsRelaunch,
  resolveDiagnosticsBuildInfo,
  resolveStreamDiagnosticsActivation,
} = require('../electron/field-run-diagnostics.cjs');

test('diagnostics activation is off by default, accepts the CLI switch, and gives environment precedence', () => {
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
  }), {
    enabled: true,
    activationSource: 'environment',
    forcedByEnvironment: true,
  });
});

test('enabling field diagnostics relaunches once with relevant arguments and no stale deep link', () => {
  const calls = [];
  const app = {
    relaunch: (options) => calls.push(['relaunch', options]),
    quit: () => calls.push(['quit']),
  };
  const result = requestFieldDiagnosticsRelaunch({
    app,
    action: 'enable',
    activation: { enabled: false, activationSource: 'off', forcedByEnvironment: false },
    argv: ['jump.exe', '.', '--inspect=9229', STREAM_DIAGNOSTICS_SWITCH, 'jump://join?room=old'],
  });
  assert.equal(result.relaunchRequested, true);
  assert.deepEqual(result.args, ['.', '--inspect=9229', STREAM_DIAGNOSTICS_SWITCH]);
  assert.deepEqual(calls, [
    ['relaunch', { args: ['.', '--inspect=9229', STREAM_DIAGNOSTICS_SWITCH] }],
    ['quit'],
  ]);
});

test('disabling field diagnostics removes only its switch and respects an environment-forced mode', () => {
  assert.deepEqual(
    fieldDiagnosticsRelaunchArguments(['jump.exe', '.', '--trace-warnings', STREAM_DIAGNOSTICS_SWITCH], false),
    ['.', '--trace-warnings'],
  );
  const calls = [];
  const result = requestFieldDiagnosticsRelaunch({
    app: { relaunch: () => calls.push('relaunch'), quit: () => calls.push('quit') },
    action: 'disable',
    activation: { enabled: true, activationSource: 'environment', forcedByEnvironment: true },
    argv: ['jump.exe', STREAM_DIAGNOSTICS_SWITCH],
  });
  assert.deepEqual(result, {
    relaunchRequested: false,
    reason: 'environment-forced',
    activationSource: 'environment',
  });
  assert.deepEqual(calls, []);
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

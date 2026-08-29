const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const benchmarkPath = path.join(__dirname, 'screen-share-benchmark.e2e.cjs');
const electronPath = require('electron');

function runBenchmarkPolicyProbe(backend, benchmarkDisableFeatures = '') {
  const env = {
    ...process.env,
    JUMP_BENCH_CAPTURE_POLICY_ONLY: '1',
    JUMP_BENCH_DISABLE_FEATURES: benchmarkDisableFeatures,
  };
  delete env.JUMP_BENCH_ENABLE_FEATURES;
  if (backend === undefined) delete env.JUMP_SCREEN_CAPTURE_BACKEND;
  else env.JUMP_SCREEN_CAPTURE_BACKEND = backend;

  const output = execFileSync(electronPath, [benchmarkPath], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  return JSON.parse(output.trim());
}

test('benchmark bootstrap applies the effective Windows app.commandLine policy', {
  skip: process.platform !== 'win32',
}, () => {
  const defaultProbe = runBenchmarkPolicyProbe();
  assert.equal(defaultProbe.captureBackend.wgcScreenCapturerDisabled, true);
  assert.match(defaultProbe.chromiumSwitches.disableFeatures, /(?:^|,)AllowWgcScreenCapturer(?:,|$)/);

  const wgcProbe = runBenchmarkPolicyProbe('wgc');
  assert.equal(wgcProbe.captureBackend.wgcScreenCapturerDisabled, false);
  assert.doesNotMatch(wgcProbe.chromiumSwitches.disableFeatures, /(?:^|,)AllowWgcScreenCapturer(?:,|$)/);

  const existingFeatureProbe = runBenchmarkPolicyProbe(undefined, 'ExistingFeature');
  assert.match(existingFeatureProbe.chromiumSwitches.disableFeatures, /(?:^|,)ExistingFeature(?:,|$)/);
  assert.match(existingFeatureProbe.chromiumSwitches.disableFeatures, /(?:^|,)AllowWgcScreenCapturer(?:,|$)/);
});

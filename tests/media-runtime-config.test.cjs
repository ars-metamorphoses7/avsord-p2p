const assert = require('node:assert/strict');
const test = require('node:test');
const {
  WGC_SCREEN_CAPTURE_FEATURE,
  normalizeFeatureList,
  resolveWindowsScreenCaptureDisableFeatures,
} = require('../electron/media-runtime-config.cjs');

function features(value) {
  return normalizeFeatureList(value);
}

test('Windows default disables WGC', () => {
  assert.deepEqual(features(resolveWindowsScreenCaptureDisableFeatures({
    platform: 'win32',
    backend: '',
  })), [WGC_SCREEN_CAPTURE_FEATURE]);
});

test('explicit WGC does not add the disabled feature', () => {
  assert.deepEqual(features(resolveWindowsScreenCaptureDisableFeatures({
    platform: 'win32',
    backend: 'wgc',
  })), []);
});

test('Windows default preserves existing features without duplicates', () => {
  assert.deepEqual(features(resolveWindowsScreenCaptureDisableFeatures({
    platform: 'win32',
    backend: '',
    existingFeatures: 'A,B',
  })), ['A', 'B', WGC_SCREEN_CAPTURE_FEATURE]);
  assert.deepEqual(features(resolveWindowsScreenCaptureDisableFeatures({
    platform: 'win32',
    backend: '',
    existingFeatures: `A,B,${WGC_SCREEN_CAPTURE_FEATURE}`,
  })), ['A', 'B', WGC_SCREEN_CAPTURE_FEATURE]);
});

test('non-Windows platforms do not add the WGC feature', () => {
  assert.deepEqual(features(resolveWindowsScreenCaptureDisableFeatures({
    platform: 'linux',
    existingFeatures: 'A,B',
  })), ['A', 'B']);
});

test('the policy is idempotent', () => {
  const once = resolveWindowsScreenCaptureDisableFeatures({
    platform: 'win32',
    backend: '',
    existingFeatures: 'A,B',
  });
  const twice = resolveWindowsScreenCaptureDisableFeatures({
    platform: 'win32',
    backend: '',
    existingFeatures: once,
  });
  assert.equal(twice, once);
});

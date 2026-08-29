const WGC_SCREEN_CAPTURE_FEATURE = 'AllowWgcScreenCapturer';

function normalizeFeatureList(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(values
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean))];
}

function shouldDisableWgcScreenCapturer({ platform = process.platform, backend = '' } = {}) {
  return platform === 'win32'
    && String(backend ?? '').trim().toLowerCase() !== 'wgc';
}

function resolveWindowsScreenCaptureDisableFeatures({
  platform = process.platform,
  backend,
  existingFeatures = '',
} = {}) {
  const disabledFeatures = normalizeFeatureList(existingFeatures);
  if (shouldDisableWgcScreenCapturer({ platform, backend })) {
    disabledFeatures.push(WGC_SCREEN_CAPTURE_FEATURE);
  }
  return normalizeFeatureList(disabledFeatures).join(',');
}

function applyWindowsScreenCapturePolicy(commandLine, options = {}) {
  const platform = options.platform ?? process.platform;
  const backend = options.backend === undefined
    ? process.env.JUMP_SCREEN_CAPTURE_BACKEND
    : options.backend;
  const existingFeatures = commandLine.getSwitchValue('disable-features') || '';
  const finalFeatures = resolveWindowsScreenCaptureDisableFeatures({
    platform,
    backend,
    existingFeatures,
  });

  if (shouldDisableWgcScreenCapturer({ platform, backend }) && finalFeatures !== existingFeatures) {
    commandLine.appendSwitch('disable-features', finalFeatures);
  }
  return finalFeatures;
}

module.exports = {
  WGC_SCREEN_CAPTURE_FEATURE,
  normalizeFeatureList,
  shouldDisableWgcScreenCapturer,
  resolveWindowsScreenCaptureDisableFeatures,
  applyWindowsScreenCapturePolicy,
};

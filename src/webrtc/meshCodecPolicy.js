export function meshCodecPolicyForLocalCapabilities(capabilities = {}, profileId = 'performance') {
  const softwareOnly = capabilities.hardwareVideoEncoding === false
    || String(capabilities.videoEncode || '').toLowerCase() === 'disabled_software';
  return softwareOnly
    ? `software-only:${profileId}:${String(capabilities.preferredSoftwareCodec || 'auto').toLowerCase()}`
    : 'hardware-or-unknown';
}

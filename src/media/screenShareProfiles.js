export const SCREEN_SHARE_PROFILES = {
  auto: {
    id: 'auto',
    label: 'automático',
    description: 'até 1080p/60 · ajusta sozinho à rede e ao encoder',
    width: 1920,
    height: 1080,
    frameRate: 60,
    // The stream controller below owns spatial degradation. Chromium's own
    // maintain-framerate adaptation can stack a hidden scale on top and fall
    // to 240p/OpenH264.
    degradationPreference: 'maintain-resolution',
    contentHint: 'motion',
    codecOrder: ['video/H264', 'video/VP9', 'video/VP8'],
    // Chromium M150 defaults to software WebRTC encoding below 360p.
    minimumEncodedHeight: 360,
    // Only used by the "Compatibilidade" receiver playback policy.
    playbackBufferMs: 140,
    maxPlaybackBufferMs: 360,
  },
};

export const SCREEN_SHARE_ADAPT_INTERVAL_MS = 1_500;

/**
 * Operating points of the automatic stream. GCC owns the bitrate inside a
 * level; `maxBitrate` is only a ceiling and is never derived from the
 * bandwidth estimate. `floorBitrate` is the estimate below which the level
 * looks worse than the next one down.
 */
export const STREAM_LEVELS = [
  { height: 1080, maxBitrate: 12_000_000, floorBitrate: 4_500_000 },
  { height: 720, maxBitrate: 7_000_000, floorBitrate: 2_200_000 },
  { height: 540, maxBitrate: 4_000_000, floorBitrate: 0 },
];
export const STREAM_FRAME_RATES = [60, 30];

const STREAM_WINDOW = 8;
const STREAM_PRESSURE_VOTES = 6;
const STREAM_HEADROOM_RATIO = 1.5;
// GCC needs a few seconds to ramp after start; never judge it earlier.
const STREAM_STARTUP_SAMPLES = 8;
const STREAM_MIN_HOLD_SAMPLES = 6;
const STREAM_UPGRADE_WAIT_SAMPLES = 20;
const STREAM_MAX_UPGRADE_WAIT_SAMPLES = 160;

// Older builds and saved settings used performance/quality (and earlier
// aliases). There is a single automatic mode now; every id maps to it.
export function normalizeScreenShareProfileId() {
  return 'auto';
}

export function screenShareProfile(profileId) {
  return SCREEN_SHARE_PROFILES[normalizeScreenShareProfileId(profileId)];
}

export function screenSharePlaybackBuffer(profileId) {
  return screenShareProfile(profileId).playbackBufferMs;
}

export function initialPlaybackBufferAdaptation(profileId) {
  const profile = screenShareProfile(profileId);
  return {
    profileId: profile.id,
    targetMs: profile.playbackBufferMs,
    stableSamples: 0,
    freezeCount: null,
    framesDropped: null,
    reason: 'initial',
  };
}

/**
 * Receiver-side jitter protection. Chromium's fixed low-latency target works
 * well on a clean LAN but turns bursty Wi-Fi/VPN delivery into visible pauses.
 * Grow quickly on jitter/freezes and decay slowly so the buffer does not chase
 * every sample and oscillate playback latency.
 */
export function evaluatePlaybackBufferAdaptation(previous, profileId, diagnostics = {}) {
  const profile = screenShareProfile(profileId);
  const current = previous?.profileId === profile.id
    ? previous
    : initialPlaybackBufferAdaptation(profile.id);
  const finiteNonNegative = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const jitterMs = finiteNonNegative(diagnostics.jitterMs) ?? 0;
  const freezeCount = finiteNonNegative(diagnostics.freezeCount);
  const framesDropped = finiteNonNegative(diagnostics.framesDropped);
  const freezeDelta = freezeCount !== null && current.freezeCount !== null
    ? Math.max(0, freezeCount - current.freezeCount)
    : 0;
  const droppedDelta = framesDropped !== null && current.framesDropped !== null
    ? Math.max(0, framesDropped - current.framesDropped)
    : 0;
  const pressure = freezeDelta > 0 || droppedDelta >= 2 || jitterMs >= 45;
  const excessJitterMs = Math.max(0, jitterMs - 10);
  const desiredMs = Math.min(
    profile.maxPlaybackBufferMs,
    Math.round(profile.playbackBufferMs + (excessJitterMs * 4) + (freezeDelta * 90) + (droppedDelta * 15)),
  );
  let targetMs = Number(current.targetMs) || profile.playbackBufferMs;
  let stableSamples = pressure ? 0 : (Number(current.stableSamples) || 0) + 1;
  let reason = current.reason;
  if (pressure || desiredMs > targetMs + 15) {
    targetMs = Math.max(targetMs, desiredMs);
    stableSamples = 0;
    reason = freezeDelta > 0 ? 'freeze-protection'
      : droppedDelta >= 2 ? 'drop-protection'
        : 'jitter-protection';
  } else if (stableSamples >= 5 && targetMs > profile.playbackBufferMs) {
    targetMs = Math.max(profile.playbackBufferMs, targetMs - 15);
    stableSamples = 0;
    reason = 'stable-decay';
  } else if (targetMs === profile.playbackBufferMs) {
    reason = 'baseline';
  }
  return {
    profileId: profile.id,
    targetMs,
    stableSamples,
    freezeCount,
    framesDropped,
    jitterMs,
    freezeDelta,
    droppedDelta,
    reason,
  };
}

export function screenCaptureConstraints(profileId, sourceId = '') {
  const profile = screenShareProfile(profileId);
  if (sourceId) {
    return {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: profile.width,
        maxHeight: profile.height,
        maxFrameRate: profile.frameRate,
      },
    };
  }
  return {
    width: { ideal: profile.width, max: profile.width },
    height: { ideal: profile.height, max: profile.height },
    frameRate: { ideal: profile.frameRate, max: profile.frameRate },
  };
}

export function evenScreenCaptureConstraints(profileId, settings = {}) {
  const profile = screenShareProfile(profileId);
  const width = positiveDimension(settings.width);
  const height = positiveDimension(settings.height);
  if (width === null || height === null || (Math.round(width) % 2 === 0 && Math.round(height) % 2 === 0)) {
    return null;
  }
  const evenWidth = Math.max(2, Math.floor(width / 2) * 2);
  const evenHeight = Math.max(2, Math.floor(height / 2) * 2);
  return {
    width: { exact: evenWidth },
    height: { exact: evenHeight },
    frameRate: { ideal: profile.frameRate, max: profile.frameRate },
    resizeMode: 'crop-and-scale',
  };
}

function positiveDimension(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Bound sender scaling by the actual source height and nudge the result to an
 * even-by-even H.264 frame. Chromium's hardware H.264 path rejects odd frame
 * dimensions, while scales derived from arbitrary window aspect ratios can
 * otherwise yield values such as 959x540.
 */
export function safeVideoSenderScale(requestedScale, dimensions = {}, minimumHeight = 360) {
  const requested = Math.max(1, Number(requestedScale) || 1);
  const sourceWidth = positiveDimension(dimensions.sourceWidth);
  const sourceHeight = positiveDimension(dimensions.sourceHeight);
  if (sourceHeight === null) return requested;

  const floor = Math.max(2, Number(minimumHeight) || 360);
  const maximumSafeScale = Math.max(1, sourceHeight / floor);
  const bounded = Math.min(requested, maximumSafeScale);
  if (sourceWidth === null || sourceHeight < floor) return bounded;

  const minimumEvenHeight = Math.max(2, Math.ceil(floor / 2) * 2);
  const maximumEvenHeight = Math.floor((sourceHeight + 0.5) / 2) * 2;
  let best = null;
  for (let targetHeight = minimumEvenHeight; targetHeight <= maximumEvenHeight; targetHeight += 2) {
    const heightScaleLow = sourceHeight / (targetHeight + 0.5);
    const heightScaleHigh = sourceHeight / (targetHeight - 0.5);
    const possibleScaleLow = Math.max(1, heightScaleLow);
    const possibleScaleHigh = Math.min(maximumSafeScale, heightScaleHigh);
    if (possibleScaleLow > possibleScaleHigh) continue;
    const minimumWidth = Math.max(2, Math.floor(sourceWidth / possibleScaleHigh) - 1);
    const maximumWidth = Math.ceil(sourceWidth / possibleScaleLow) + 1;
    let targetWidth = minimumWidth % 2 === 0 ? minimumWidth : minimumWidth + 1;
    for (; targetWidth <= maximumWidth; targetWidth += 2) {
      const widthScaleLow = sourceWidth / (targetWidth + 0.5);
      const widthScaleHigh = sourceWidth / (targetWidth - 0.5);
      const overlapLow = Math.max(possibleScaleLow, widthScaleLow);
      const overlapHigh = Math.min(possibleScaleHigh, widthScaleHigh);
      if (overlapLow > overlapHigh) continue;
      const epsilon = Math.max(1e-9, (overlapHigh - overlapLow) * 1e-6);
      const candidates = [
        bounded,
        (overlapLow + overlapHigh) / 2,
        overlapLow + epsilon,
        overlapHigh - epsilon,
      ].map((scale) => Math.max(overlapLow, Math.min(overlapHigh, scale)));
      for (const scale of candidates) {
        const predictedWidth = Math.round(sourceWidth / scale);
        const predictedHeight = Math.round(sourceHeight / scale);
        if (predictedWidth < 2 || predictedWidth % 2 !== 0
            || predictedHeight < floor || predictedHeight % 2 !== 0) continue;
        const distance = Math.abs(Math.log(scale / bounded));
        // On an exact tie, preserve slightly more detail instead of degrading it.
        const score = distance + (scale > bounded ? 1e-9 : 0);
        if (!best || score < best.score) best = { scale, score };
      }
    }
  }
  return best?.scale ?? bounded;
}

function streamBitrate(level, peerCount = 1) {
  // A mesh uploads one encoded stream per peer and every peer connection runs
  // its own GCC. Share the ceiling only for larger meshes; two viewers at full
  // budget fit typical uplinks and GCC still backs off on a real bottleneck.
  const peers = Math.max(1, Number(peerCount) || 1);
  return Math.round(STREAM_LEVELS[level].maxBitrate * (peers >= 3 ? 0.75 : 1));
}

function streamScale(level, dimensions = {}, minimumHeight = 360) {
  const sourceHeight = positiveDimension(dimensions.sourceHeight);
  const requested = sourceHeight === null ? 1 : Math.max(1, sourceHeight / STREAM_LEVELS[level].height);
  return safeVideoSenderScale(requested, dimensions, minimumHeight);
}

function clampLevel(value, levels) {
  return Math.min(levels.length - 1, Math.max(0, Number(value) || 0));
}

function isSoftwareVideoEncoder(diagnostics = {}) {
  return diagnostics.powerEfficientEncoder === false || isSoftwareH264Encoder(diagnostics);
}

export function initialStreamState({ softwareEncoder = false } = {}) {
  return {
    level: softwareEncoder ? 1 : 0,
    temporalLevel: softwareEncoder ? 1 : 0,
    frameRate: STREAM_FRAME_RATES[softwareEncoder ? 1 : 0],
    scale: 1,
    sampleCount: 0,
    lastChangeSample: 0,
    lastUpgradeSample: null,
    upgradeWaitSamples: STREAM_UPGRADE_WAIT_SAMPLES,
    votes: [],
    softwareEncoder,
    reason: softwareEncoder ? 'software-encoder-start' : 'initial',
  };
}

/**
 * Stable automatic policy. Field runs showed a clean link (0 loss, 27 ms RTT)
 * oscillating 720p↔540p↔360p every ~13 s because the previous controller
 * judged FPS ratios every 1.5 s and capped bitrate below GCC's estimate; each
 * switch cost a keyframe and a visible freeze. Pixels now change only on
 * sustained evidence: the bandwidth estimate below the level floor, or an
 * encoder that drops captured frames. A capture that delivers fewer frames
 * (heavy game, static screen) is never a reason to lose resolution. Recovery
 * backs off exponentially when a retry fails.
 */
export function evaluateStream(previous, diagnostics = {}) {
  const state = { ...(previous || initialStreamState()) };
  state.sampleCount += 1;
  const lastLevel = STREAM_LEVELS.length - 1;
  const lastTemporal = STREAM_FRAME_RATES.length - 1;

  const change = (level, temporalLevel, reason) => {
    const upgrade = level < state.level || temporalLevel < state.temporalLevel;
    if (!upgrade && state.lastUpgradeSample !== null
        && state.sampleCount - state.lastUpgradeSample <= STREAM_UPGRADE_WAIT_SAMPLES) {
      state.upgradeWaitSamples = Math.min(STREAM_MAX_UPGRADE_WAIT_SAMPLES, state.upgradeWaitSamples * 2);
    }
    state.level = level;
    state.temporalLevel = temporalLevel;
    state.frameRate = STREAM_FRAME_RATES[temporalLevel];
    state.lastChangeSample = state.sampleCount;
    state.lastUpgradeSample = upgrade ? state.sampleCount : state.lastUpgradeSample;
    state.votes = [];
    state.reason = reason;
    return state;
  };

  if (!state.softwareEncoder && Number(diagnostics.framesEncoded ?? 1) > 0
      && isSoftwareVideoEncoder(diagnostics)) {
    state.softwareEncoder = true;
    if (state.level === 0 && state.temporalLevel === 0) return change(1, 1, 'software-encoder-start');
  }

  const finite = (value) => (value === null || value === undefined || value === ''
    || !Number.isFinite(Number(value)) ? null : Number(value));
  const estimate = finite(diagnostics.availableOutgoingBitrate);
  const bwe = estimate !== null && estimate > 0 ? estimate : null;
  const captureFps = finite(diagnostics.captureFps);
  const encodeFps = finite(diagnostics.framesPerSecond);
  const expectedFps = captureFps === null ? null : Math.min(captureFps, state.frameRate);
  const encoderBehind = expectedFps !== null && expectedFps >= 10 && encodeFps !== null
    && encodeFps < expectedFps * 0.75;
  const encoder = encoderBehind || diagnostics.qualityLimitationReason === 'cpu';
  const bandwidth = bwe !== null && bwe < STREAM_LEVELS[state.level].floorBitrate;
  const headroom = !encoder && bwe !== null && state.level > 0
    && bwe >= STREAM_LEVELS[state.level - 1].floorBitrate * STREAM_HEADROOM_RATIO;
  state.votes = [...state.votes, { bandwidth, encoder, headroom }].slice(-STREAM_WINDOW);

  if (state.sampleCount <= STREAM_STARTUP_SAMPLES
      || state.sampleCount - state.lastChangeSample < STREAM_MIN_HOLD_SAMPLES
      || state.votes.length < STREAM_WINDOW) return state;

  const count = (key) => state.votes.filter((vote) => vote[key]).length;
  if (count('bandwidth') >= STREAM_PRESSURE_VOTES && state.level < lastLevel) {
    return change(state.level + 1, state.temporalLevel, 'bandwidth');
  }
  if (count('encoder') >= STREAM_PRESSURE_VOTES) {
    if (state.level < lastLevel) return change(state.level + 1, state.temporalLevel, 'encoder');
    if (state.temporalLevel < lastTemporal) return change(state.level, state.temporalLevel + 1, 'encoder');
  }
  const calm = state.votes.every((vote) => !vote.bandwidth && !vote.encoder);
  if (!calm || state.sampleCount - state.lastChangeSample < state.upgradeWaitSamples) return state;
  if (state.temporalLevel > 0) return change(state.level, state.temporalLevel - 1, 'recovery');
  if (state.level > 0 && count('headroom') >= STREAM_PRESSURE_VOTES) {
    return change(state.level - 1, state.temporalLevel, 'recovery');
  }
  return state;
}

export function streamEncodingParameters(state, dimensions = {}, peerCount = 1) {
  const level = clampLevel(state?.level, STREAM_LEVELS);
  return {
    maxBitrate: streamBitrate(level, peerCount),
    maxFramerate: STREAM_FRAME_RATES[clampLevel(state?.temporalLevel, STREAM_FRAME_RATES)],
    scaleResolutionDownBy: streamScale(level, dimensions, SCREEN_SHARE_PROFILES.auto.minimumEncodedHeight),
  };
}

/**
 * Write the operating point to the sender only when it changes. Bitrate is a
 * fixed ceiling per level: chasing every estimate sample reconfigures the
 * encoder and starves GCC's own ramp-up.
 */
export async function applyStreamSender(sender, state, { peerCount = 1, sourceWidth, sourceHeight } = {}) {
  if (!sender?.setParameters || !sender?.getParameters) return false;
  const profile = SCREEN_SHARE_PROFILES.auto;
  const parameters = sender.getParameters();
  parameters.encodings ??= [{}];
  const encoding = parameters.encodings[0];
  const trackSettings = sender.track?.getSettings?.() || {};
  const next = streamEncodingParameters(state, {
    sourceWidth: positiveDimension(sourceWidth) ?? positiveDimension(trackSettings.width),
    sourceHeight: positiveDimension(sourceHeight) ?? positiveDimension(trackSettings.height),
  }, peerCount);
  if (state) state.scale = next.scaleResolutionDownBy;
  const currentScale = Math.max(1, Number(encoding.scaleResolutionDownBy) || 1);
  if (Math.abs(currentScale - next.scaleResolutionDownBy) < 0.01
      && Number(encoding.maxBitrate) === next.maxBitrate
      && Number(encoding.maxFramerate) === next.maxFramerate
      && parameters.degradationPreference === profile.degradationPreference) return true;
  Object.assign(encoding, next, { priority: 'high', networkPriority: 'high' });
  parameters.degradationPreference = profile.degradationPreference;
  try {
    await sender.setParameters(parameters);
    return true;
  } catch {
    return false;
  }
}

export async function configureVideoSender(sender, profileId, peerCount = 1) {
  // A sender is reused when screen share stops and the camera track comes
  // back. Never let an adaptive screen scale leak into that replacement (or
  // into the first samples of a newly selected screen).
  return applyStreamSender(sender, initialStreamState(), { peerCount });
}

export function screenShareCodecOrder(profileId, capabilities = {}) {
  const profile = screenShareProfile(profileId);
  const videoEncode = String(capabilities.videoEncode || '').toLowerCase();
  const softwareOnly = capabilities.hardwareVideoEncoding === false
    || videoEncode === 'disabled_software';
  if (!softwareOnly) return [...profile.codecOrder];
  const requested = String(capabilities.preferredSoftwareCodec || '').toUpperCase();
  const preferred = ['VP8', 'VP9', 'H264'].includes(requested)
    ? `video/${requested}`
    // libvpx VP8 avoided OpenH264's keyframe/pacer stalls while retaining more
    // FPS than VP9 on the software-only Intel/Linux benchmark. Hardware paths
    // continue to prefer H.264 above.
    : 'video/VP8';
  return [preferred, ...['video/H264', 'video/VP9', 'video/VP8'].filter((codec) => codec !== preferred)];
}

export function isSoftwareH264Encoder({
  codec,
  encoderImplementation,
  powerEfficientEncoder,
} = {}) {
  const mimeType = typeof codec === 'string' ? codec : codec?.mimeType;
  return /h264/i.test(String(mimeType || ''))
    && (powerEfficientEncoder === false
      || /openh264|ffmpeg|software/i.test(String(encoderImplementation || '')));
}

export function selectScreenShareSfuCodec(codecs = [], preferredMime = '') {
  const mime = preferredMime.toLowerCase();
  const candidates = codecs.filter(codec => codec.mimeType?.toLowerCase() === mime);
  return candidates.find(codec => mime === 'video/h264'
    && /^4200[0-9a-f]{2}$/i.test(String(codec.parameters?.['profile-level-id']))) || candidates[0];
}

export function observeSoftwareH264Fallback(previous, diagnostics = {}, trackId = '') {
  const software = Number(diagnostics.framesEncoded) > 0 && isSoftwareH264Encoder(diagnostics);
  const samples = software ? (previous?.trackId === trackId ? previous.samples || 0 : 0) + 1 : 0;
  // Initial reports can describe a temporary encoder during negotiation or
  // handoff. Do not permanently switch the track to VP8 on one report.
  return { trackId, samples, confirmed: samples >= 3 };
}

export function preferVideoCodecs(transceiver, profileId, capabilities = {}) {
  if (!transceiver?.setCodecPreferences || !globalThis.RTCRtpSender?.getCapabilities) return;
  const codecs = globalThis.RTCRtpSender.getCapabilities('video')?.codecs || [];
  const codecOrder = screenShareCodecOrder(profileId, capabilities);
  const order = new Map(codecOrder.map((mimeType, index) => [mimeType.toLowerCase(), index]));
  const sorted = [...codecs].sort((left, right) => {
    const leftRank = order.get(left.mimeType?.toLowerCase()) ?? 99;
    const rightRank = order.get(right.mimeType?.toLowerCase()) ?? 99;
    return leftRank - rightRank;
  });
  if (sorted.length) transceiver.setCodecPreferences(sorted);
  return codecOrder;
}

export const SCREEN_SHARE_PROFILES = {
  performance: {
    id: 'performance',
    label: 'desempenho',
    description: '60 FPS alvo · 270p–480p automático',
    width: 854,
    height: 480,
    frameRate: 60,
    maxBitrate: 4_000_000,
    minBitrate: 500_000,
    degradationPreference: 'maintain-framerate',
    contentHint: 'motion',
    codecOrder: ['video/H264', 'video/VP9', 'video/VP8'],
    adaptationScales: [1, 1.14, 1.33, 1.5, 1.78],
    playbackBufferMs: 220,
    severeFpsRatio: 0.72,
    pressureFpsRatio: 0.90,
    stableFpsRatio: 0.97,
    severeStep: 2,
    pressureSamples: 2,
    recoverySamples: 10,
  },
  quality: {
    id: 'quality',
    label: 'qualidade',
    description: 'até 1080p · 30 FPS automático',
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 8_000_000,
    minBitrate: 1_200_000,
    degradationPreference: 'balanced',
    contentHint: 'motion',
    codecOrder: ['video/H264', 'video/VP9', 'video/VP8'],
    adaptationScales: [1, 1.2, 1.5],
    playbackBufferMs: 260,
    severeFpsRatio: 0.65,
    pressureFpsRatio: 0.84,
    stableFpsRatio: 0.96,
    severeStep: 1,
    pressureSamples: 3,
    recoverySamples: 14,
  },
};

export const SCREEN_SHARE_ADAPT_INTERVAL_MS = 1_500;

const LEGACY_PROFILE_ALIASES = {
  competitive: 'performance',
  fluid: 'performance',
  balanced: 'quality',
  detail: 'quality',
};

export function normalizeScreenShareProfileId(profileId) {
  const normalized = LEGACY_PROFILE_ALIASES[profileId] || profileId;
  return SCREEN_SHARE_PROFILES[normalized] ? normalized : 'performance';
}

export function screenShareProfile(profileId) {
  return SCREEN_SHARE_PROFILES[normalizeScreenShareProfileId(profileId)];
}

export function screenSharePlaybackBuffer(profileId) {
  return screenShareProfile(profileId).playbackBufferMs;
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

export async function configureVideoSender(sender, profileId, peerCount = 1) {
  if (!sender?.setParameters || !sender?.getParameters) return false;
  const profile = screenShareProfile(profileId);
  const parameters = sender.getParameters();
  parameters.encodings ??= [{}];
  const encoding = parameters.encodings[0];
  // A mesh uploads one encoded stream per peer. Share the target budget when
  // the room grows so congestion does not collapse every stream at once.
  const meshFactor = Math.max(1, 1 + ((Math.max(1, peerCount) - 1) * 0.55));
  encoding.maxBitrate = Math.max(profile.minBitrate, Math.round(profile.maxBitrate / meshFactor));
  encoding.maxFramerate = profile.frameRate;
  encoding.priority = 'high';
  encoding.networkPriority = 'high';
  parameters.degradationPreference = profile.degradationPreference;
  try {
    await sender.setParameters(parameters);
    return true;
  } catch {
    return false;
  }
}

export async function adaptVideoSender(sender, profileId, peerCount, diagnostics = {}) {
  if (!sender?.setParameters || !sender?.getParameters) return false;
  const profile = screenShareProfile(profileId);
  const parameters = sender.getParameters();
  parameters.encodings ??= [{}];
  const encoding = parameters.encodings[0];
  const adaptationScale = Math.max(1, Number(diagnostics.adaptationScale) || 1);
  const currentScale = Math.max(1, Number(encoding.scaleResolutionDownBy) || 1);
  const meshFactor = Math.max(1, 1 + ((Math.max(1, peerCount) - 1) * 0.55));
  const profileBudget = Math.round(profile.maxBitrate / meshFactor);
  // Scale bitrate with pixel count. Otherwise a degraded 360p stream keeps a
  // 480p/1080p-sized budget, looks unnecessarily pristine and can continue
  // saturating the encoder or uplink without buying any more frames.
  const resolutionBudget = Math.max(
    profile.minBitrate,
    Math.round(profileBudget / (adaptationScale ** 2)),
  );
  const available = Number(diagnostics.availableOutgoingBitrate) || 0;
  // Leave transport headroom for Opus, retransmissions and signaling. A
  // flashing/full-motion screen otherwise fills the queue and loses frames.
  // `availableOutgoingBitrate` already belongs to this peer connection. The
  // mesh factor above accounts for the other uploads; dividing it by the peer
  // count again needlessly starves each individual receiver.
  const networkBudget = available > 0 ? Math.round(available * 0.78) : resolutionBudget;
  const targetBitrate = available > 0
    ? Math.max(450_000, Math.min(resolutionBudget, networkBudget))
    : resolutionBudget;
  const previousBitrate = Number(encoding.maxBitrate) || targetBitrate;
  // Bandwidth estimates are intentionally noisy. Chasing every sample makes
  // queues empty/fill in bursts and the receiver compensates by varying
  // playout. Downshift decisively, but recover capacity in small steps.
  const scalingDown = adaptationScale > currentScale + 0.01;
  const nextBitrate = targetBitrate < previousBitrate
    ? (scalingDown ? targetBitrate : Math.max(targetBitrate, Math.round(previousBitrate * 0.68)))
    : Math.min(targetBitrate, Math.round(previousBitrate * 1.08));
  const sameParameters = Math.abs(previousBitrate - nextBitrate) < 50_000
    && Math.abs(currentScale - adaptationScale) < 0.01
    && Number(encoding.maxFramerate) === profile.frameRate
    && parameters.degradationPreference === profile.degradationPreference;
  if (sameParameters) return true;

  encoding.maxBitrate = nextBitrate;
  encoding.maxFramerate = profile.frameRate;
  encoding.priority = 'high';
  encoding.networkPriority = 'high';
  // Never reconfigure the live desktop track here. Changing source constraints
  // can restart capture timestamps; sender-side GPU scaling keeps cadence
  // continuous while still reducing encoded pixels.
  encoding.scaleResolutionDownBy = adaptationScale;
  parameters.degradationPreference = profile.degradationPreference;
  try {
    await sender.setParameters(parameters);
    return true;
  } catch {
    return false;
  }
}

export function initialCaptureAdaptation(profileId) {
  return {
    profileId: screenShareProfile(profileId).id,
    level: 0,
    poorSamples: 0,
    stableSamples: 0,
    cooldownSamples: 0,
    fpsEma: 0,
    encodeEma: 0,
    scale: 1,
    reason: 'initial',
  };
}

export function evaluateCaptureAdaptation(previous, profileId, diagnostics = {}) {
  const profile = screenShareProfile(profileId);
  const current = previous?.profileId === profile.id ? previous : initialCaptureAdaptation(profile.id);
  const fpsSamples = [diagnostics.captureFps, diagnostics.framesPerSecond]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const measuredFps = fpsSamples.length ? Math.min(...fpsSamples) : 0;
  const fpsEma = measuredFps > 0 ? (current.fpsEma > 0 ? (current.fpsEma * 0.58) + (measuredFps * 0.42) : measuredFps) : current.fpsEma;
  const instantFpsRatio = measuredFps > 0 ? measuredFps / profile.frameRate : 1;
  const fpsRatio = fpsEma > 0 ? fpsEma / profile.frameRate : 1;
  const encodeBudgetMs = 1000 / profile.frameRate;
  const measuredEncode = Number(diagnostics.averageEncodeTimeMs) || 0;
  const encodeEma = measuredEncode > 0 ? (current.encodeEma > 0 ? (current.encodeEma * 0.58) + (measuredEncode * 0.42) : measuredEncode) : current.encodeEma;
  const instantEncodeRatio = measuredEncode / encodeBudgetMs;
  const encodeRatio = encodeEma / encodeBudgetMs;
  const limitation = diagnostics.qualityLimitationReason || 'none';
  // Decisions require both the latest sample and the rolling trend. This
  // reacts quickly to a real collapse without repeatedly downshifting after
  // the latest frame rate has already recovered.
  const severePressure = (fpsSamples.length > 0
    && instantFpsRatio < profile.severeFpsRatio
    && fpsRatio < profile.pressureFpsRatio)
    || (instantEncodeRatio > 1.08 && encodeRatio > 0.92);
  const moderatePressure = (fpsSamples.length > 0
    && instantFpsRatio < profile.pressureFpsRatio
    && fpsRatio < Math.min(0.95, profile.pressureFpsRatio + 0.04))
    || (instantEncodeRatio > 0.82 && encodeRatio > 0.76)
    || ['cpu', 'bandwidth'].includes(limitation);
  const stable = fpsSamples.length > 0
    && instantFpsRatio >= profile.stableFpsRatio
    && fpsRatio >= profile.stableFpsRatio - 0.02
    && encodeRatio < 0.66
    && !['cpu', 'bandwidth'].includes(limitation);
  let level = current.level;
  let poorSamples = moderatePressure ? current.poorSamples + 1 : 0;
  let stableSamples = stable ? current.stableSamples + 1 : 0;
  let cooldownSamples = Math.max(0, Number(current.cooldownSamples) - 1);
  let reason = current.reason;

  if (cooldownSamples > 0) {
    // Hold the current resolution long enough for congestion control and the
    // hardware encoder to settle before judging the next sample.
  } else if (severePressure) {
    level += profile.severeStep;
    poorSamples = 0;
    stableSamples = 0;
    cooldownSamples = 2;
    reason = instantFpsRatio < profile.severeFpsRatio ? 'fps-severe' : 'encode-severe';
  } else if (moderatePressure && poorSamples >= profile.pressureSamples) {
    level += 1;
    poorSamples = 0;
    stableSamples = 0;
    cooldownSamples = 2;
    reason = limitation !== 'none' ? limitation : instantEncodeRatio > 0.82 ? 'encode' : 'fps';
  } else if (stable && stableSamples >= profile.recoverySamples) {
    level -= 1;
    stableSamples = 0;
    poorSamples = 0;
    cooldownSamples = 5;
    reason = 'recovery';
  }

  level = Math.max(0, Math.min(profile.adaptationScales.length - 1, level));
  const scale = profile.adaptationScales[level];
  return {
    profileId: profile.id,
    level,
    poorSamples,
    stableSamples,
    cooldownSamples,
    scale,
    reason,
    targetFps: profile.frameRate,
    measuredFps,
    averageEncodeTimeMs: measuredEncode,
    fpsEma,
    encodeEma,
    effectiveWidth: Math.round(profile.width / scale),
    effectiveHeight: Math.round(profile.height / scale),
  };
}

export function preferVideoCodecs(transceiver, profileId) {
  if (!transceiver?.setCodecPreferences || !globalThis.RTCRtpSender?.getCapabilities) return;
  const profile = screenShareProfile(profileId);
  const codecs = globalThis.RTCRtpSender.getCapabilities('video')?.codecs || [];
  const order = new Map(profile.codecOrder.map((mimeType, index) => [mimeType.toLowerCase(), index]));
  const sorted = [...codecs].sort((left, right) => {
    const leftRank = order.get(left.mimeType?.toLowerCase()) ?? 99;
    const rightRank = order.get(right.mimeType?.toLowerCase()) ?? 99;
    return leftRank - rightRank;
  });
  if (sorted.length) transceiver.setCodecPreferences(sorted);
}

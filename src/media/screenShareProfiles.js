export const SCREEN_SHARE_PROFILES = {
  competitive: {
    id: 'competitive',
    label: 'estável',
    description: '540p · 60 FPS cadenciados',
    width: 960,
    height: 540,
    frameRate: 60,
    maxBitrate: 6_000_000,
    minBitrate: 1_200_000,
    degradationPreference: 'maintain-framerate',
    contentHint: 'motion',
    codecOrder: ['video/H264', 'video/VP9', 'video/VP8'],
    adaptationScales: [1, 1.2],
    playbackBufferMs: 220,
  },
  fluid: {
    id: 'fluid',
    label: 'fluido',
    description: '60 FPS · movimento e jogos',
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrate: 10_000_000,
    minBitrate: 2_200_000,
    degradationPreference: 'maintain-framerate',
    contentHint: 'motion',
    codecOrder: ['video/H264', 'video/VP9', 'video/VP8'],
    adaptationScales: [1, 1.25, 1.5],
    playbackBufferMs: 140,
  },
  balanced: {
    id: 'balanced',
    label: 'equilibrado',
    description: '30 FPS · uso geral',
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 5_000_000,
    minBitrate: 1_500_000,
    degradationPreference: 'balanced',
    contentHint: 'motion',
    codecOrder: ['video/H264', 'video/VP9', 'video/VP8'],
    adaptationScales: [1, 1.2, 1.45],
    playbackBufferMs: 180,
  },
  detail: {
    id: 'detail',
    label: 'detalhes',
    description: '24 FPS · texto e imagem',
    width: 2560,
    height: 1440,
    frameRate: 24,
    maxBitrate: 6_000_000,
    minBitrate: 1_800_000,
    degradationPreference: 'maintain-resolution',
    contentHint: 'detail',
    codecOrder: ['video/VP9', 'video/H264', 'video/VP8'],
    adaptationScales: [1, 1.15, 1.35],
    playbackBufferMs: 260,
  },
};

export const SCREEN_SHARE_ADAPT_INTERVAL_MS = 1_500;

export function screenShareProfile(profileId) {
  return SCREEN_SHARE_PROFILES[profileId] || SCREEN_SHARE_PROFILES.balanced;
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
  const meshFactor = Math.max(1, 1 + ((Math.max(1, peerCount) - 1) * 0.55));
  const profileBudget = Math.round(profile.maxBitrate / meshFactor);
  const available = Number(diagnostics.availableOutgoingBitrate) || 0;
  // Leave transport headroom for Opus, retransmissions and signaling. A
  // flashing/full-motion screen otherwise fills the queue and loses frames.
  // `availableOutgoingBitrate` already belongs to this peer connection. The
  // mesh factor above accounts for the other uploads; dividing it by the peer
  // count again needlessly starves each individual receiver.
  const networkBudget = available > 0 ? Math.round(available * 0.82) : profileBudget;
  const targetBitrate = available > 0
    ? Math.max(600_000, Math.min(profileBudget, networkBudget))
    : profileBudget;
  const previousBitrate = Number(encoding.maxBitrate) || targetBitrate;
  // Bandwidth estimates are intentionally noisy. Chasing every sample makes
  // queues empty/fill in bursts and the receiver compensates by varying
  // playout. Downshift decisively, but recover capacity in small steps.
  const nextBitrate = targetBitrate < previousBitrate
    ? Math.max(targetBitrate, Math.round(previousBitrate * 0.76))
    : Math.min(targetBitrate, Math.round(previousBitrate * 1.12));
  const adaptationScale = Math.max(1, Number(diagnostics.adaptationScale) || 1);
  const currentScale = Math.max(1, Number(encoding.scaleResolutionDownBy) || 1);
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
  const fpsEma = measuredFps > 0 ? (current.fpsEma > 0 ? (current.fpsEma * 0.68) + (measuredFps * 0.32) : measuredFps) : current.fpsEma;
  const fpsRatio = fpsEma > 0 ? fpsEma / profile.frameRate : 1;
  const encodeBudgetMs = 1000 / profile.frameRate;
  const measuredEncode = Number(diagnostics.averageEncodeTimeMs) || 0;
  const encodeEma = measuredEncode > 0 ? (current.encodeEma > 0 ? (current.encodeEma * 0.68) + (measuredEncode * 0.32) : measuredEncode) : current.encodeEma;
  const encodeRatio = encodeEma / encodeBudgetMs;
  const limitation = diagnostics.qualityLimitationReason || 'none';
  const severePressure = fpsSamples.length > 0 && (fpsRatio < 0.58 || encodeRatio > 1.05);
  const moderatePressure = (fpsSamples.length > 0 && fpsRatio < 0.84)
    || encodeRatio > 0.82
    || ['cpu', 'bandwidth'].includes(limitation);
  const stable = fpsSamples.length > 0
    && fpsRatio > 0.94
    && encodeRatio < 0.68
    && !['cpu', 'bandwidth'].includes(limitation);
  let level = current.level;
  let poorSamples = moderatePressure ? current.poorSamples + 1 : 0;
  let stableSamples = stable ? current.stableSamples + 1 : 0;
  let cooldownSamples = Math.max(0, Number(current.cooldownSamples) - 1);
  let reason = current.reason;

  if (cooldownSamples > 0) {
    // Hold the current resolution long enough for congestion control and the
    // hardware encoder to settle before judging the next sample.
  } else if (severePressure && poorSamples >= 2) {
    level += 1;
    poorSamples = 0;
    stableSamples = 0;
    cooldownSamples = 3;
    reason = fpsRatio < 0.58 ? 'fps-severe' : 'encode-severe';
  } else if (moderatePressure && poorSamples >= 3) {
    level += 1;
    poorSamples = 0;
    stableSamples = 0;
    cooldownSamples = 3;
    reason = limitation !== 'none' ? limitation : encodeRatio > 0.82 ? 'encode' : 'fps';
  } else if (stable && stableSamples >= 12) {
    level -= 1;
    stableSamples = 0;
    poorSamples = 0;
    cooldownSamples = 6;
    reason = 'recovery';
  }

  level = Math.max(0, Math.min(profile.adaptationScales.length - 1, level));
  return {
    profileId: profile.id,
    level,
    poorSamples,
    stableSamples,
    cooldownSamples,
    scale: profile.adaptationScales[level],
    reason,
    measuredFps,
    averageEncodeTimeMs: measuredEncode,
    fpsEma,
    encodeEma,
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

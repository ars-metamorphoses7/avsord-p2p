export const SCREEN_SHARE_PROFILES = {
  competitive: {
    id: 'competitive',
    label: 'competitivo',
    description: '720p · 60 FPS · jogo pesado',
    width: 1280,
    height: 720,
    frameRate: 60,
    maxBitrate: 8_000_000,
    minBitrate: 1_800_000,
    degradationPreference: 'maintain-framerate',
    contentHint: 'motion',
    codecOrder: ['video/H264', 'video/VP9', 'video/VP8'],
    adaptationScales: [1, 1.2, 1.4, 1.65],
  },
  fluid: {
    id: 'fluid',
    label: 'fluido',
    description: '60 FPS · movimento e jogos',
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrate: 12_000_000,
    minBitrate: 3_000_000,
    degradationPreference: 'maintain-framerate',
    contentHint: 'motion',
    codecOrder: ['video/H264', 'video/VP9', 'video/VP8'],
    adaptationScales: [1, 1.2, 1.45, 1.75, 2],
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
  },
};

export const SCREEN_SHARE_ADAPT_INTERVAL_MS = 1_500;

export function screenShareProfile(profileId) {
  return SCREEN_SHARE_PROFILES[profileId] || SCREEN_SHARE_PROFILES.balanced;
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
  const nextBitrate = available > 0
    ? Math.max(600_000, Math.min(profileBudget, networkBudget))
    : profileBudget;
  const adaptationScale = Math.max(1, Number(diagnostics.adaptationScale) || 1);
  const captureScaled = diagnostics.captureScaled === true;

  encoding.maxBitrate = nextBitrate;
  encoding.maxFramerate = profile.frameRate;
  encoding.priority = 'high';
  encoding.networkPriority = 'high';
  // Prefer scaling at the capture track because that saves capture/compositor
  // work as well as encoder work. Sender scaling remains the fallback for
  // Chromium builds that reject dynamic desktop-track constraints.
  encoding.scaleResolutionDownBy = captureScaled ? 1 : adaptationScale;
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
  const fpsRatio = measuredFps > 0 ? measuredFps / profile.frameRate : 1;
  const encodeBudgetMs = 1000 / profile.frameRate;
  const encodeRatio = (Number(diagnostics.averageEncodeTimeMs) || 0) / encodeBudgetMs;
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
  let reason = current.reason;

  if (severePressure) {
    level += 2;
    poorSamples = 0;
    stableSamples = 0;
    reason = fpsRatio < 0.58 ? 'fps-severe' : 'encode-severe';
  } else if (moderatePressure && poorSamples >= 2) {
    level += 1;
    poorSamples = 0;
    stableSamples = 0;
    reason = limitation !== 'none' ? limitation : encodeRatio > 0.82 ? 'encode' : 'fps';
  } else if (stable && stableSamples >= 6) {
    level -= 1;
    stableSamples = 0;
    poorSamples = 0;
    reason = 'recovery';
  }

  level = Math.max(0, Math.min(profile.adaptationScales.length - 1, level));
  return {
    profileId: profile.id,
    level,
    poorSamples,
    stableSamples,
    scale: profile.adaptationScales[level],
    reason,
    measuredFps,
    averageEncodeTimeMs: Number(diagnostics.averageEncodeTimeMs) || 0,
  };
}

export async function applyCaptureAdaptation(track, profileId, adaptation) {
  if (!track?.applyConstraints) return false;
  const profile = screenShareProfile(profileId);
  const scale = Math.max(1, Number(adaptation?.scale) || 1);
  try {
    await track.applyConstraints({
      width: { ideal: Math.round(profile.width / scale), max: Math.round(profile.width / scale) },
      height: { ideal: Math.round(profile.height / scale), max: Math.round(profile.height / scale) },
      frameRate: { ideal: profile.frameRate, max: profile.frameRate },
    });
    return true;
  } catch {
    return false;
  }
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

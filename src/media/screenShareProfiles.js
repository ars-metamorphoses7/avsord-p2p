export const SCREEN_SHARE_PROFILES = {
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
  },
  detail: {
    id: 'detail',
    label: 'detalhes',
    description: '20 FPS · texto e imagem',
    width: 2560,
    height: 1440,
    frameRate: 20,
    maxBitrate: 6_000_000,
    minBitrate: 1_800_000,
    degradationPreference: 'maintain-resolution',
    contentHint: 'detail',
    codecOrder: ['video/VP9', 'video/H264', 'video/VP8'],
  },
};

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
  const networkBudget = available > 0 ? Math.round((available * 0.82) / Math.max(1, peerCount)) : profileBudget;
  const nextBitrate = available > 0
    ? Math.max(600_000, Math.min(profileBudget, networkBudget))
    : profileBudget;
  const measuredFps = Number(diagnostics.framesPerSecond) || profile.frameRate;
  const constrained = diagnostics.qualityLimitationReason;
  const needsScale = ['cpu', 'bandwidth'].includes(constrained) && measuredFps < profile.frameRate * 0.82;

  encoding.maxBitrate = nextBitrate;
  encoding.maxFramerate = profile.frameRate;
  encoding.priority = 'high';
  encoding.networkPriority = 'high';
  encoding.scaleResolutionDownBy = needsScale ? (constrained === 'cpu' ? 1.35 : 1.2) : 1;
  parameters.degradationPreference = profile.degradationPreference;
  try {
    await sender.setParameters(parameters);
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

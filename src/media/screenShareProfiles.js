export const SCREEN_SHARE_PROFILES = {
  performance: {
    id: 'performance',
    label: 'desempenho',
    description: 'até 720p/60 · adapta GPU, CPU e rede',
    width: 1280,
    height: 720,
    frameRate: 60,
    maxBitrate: 8_000_000,
    // App-controlled scaling has a hard 360p floor. Chromium's own
    // maintain-framerate adaptation can stack another hidden scale on top and
    // fall to 240p/OpenH264, so preserve the configured resolution here and
    // let our stage-aware controller own spatial degradation.
    degradationPreference: 'maintain-resolution',
    contentHint: 'motion',
    codecOrder: ['video/H264', 'video/VP9', 'video/VP8'],
    // Chromium M150 defaults to software WebRTC encoding below 360p. Keeping
    // every level at or above that floor avoids turning an overloaded stream
    // into an even more expensive CPU encode.
    adaptationScales: [1, 4 / 3, 2],
    // Resolution is the first lever because it reduces encoder and transport
    // cost while preserving motion. On software encoders or very constrained
    // links, however, 360p60 can still miss every deadline. A temporal ladder
    // is the final safety valve instead of letting the stream freeze forever.
    adaptationFrameRates: [60, 30, 20, 15],
    // OpenH264 on low-end devices often needs several spatial trials before it
    // finally concedes that 60 FPS is unsustainable. Starting at 540p30 avoids
    // 10–15 seconds of visible rate-control collapse while recovery can still
    // probe 60 FPS after the measured encoder proves it has headroom.
    softwareSafeStart: { level: 1, temporalLevel: 1 },
    minimumEncodedHeight: 360,
    minimumAdaptiveBitrate: 300_000,
    playbackBufferMs: 140,
    maxPlaybackBufferMs: 360,
    severeFpsRatio: 0.72,
    pressureFpsRatio: 0.90,
    stableFpsRatio: 0.97,
    severeStep: 1,
    pressureSamples: 2,
    recoverySamples: 10,
    startupSamples: 3,
    networkPressureSamples: 4,
    packetPressureSamples: 2,
    packetLossPressureRatio: 0.02,
    retransmissionPressureRatio: 0.08,
    packetSendDelayPressureMs: 12,
  },
  quality: {
    id: 'quality',
    label: 'qualidade',
    description: 'até 1080p/30 · adapta GPU, CPU e rede',
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 8_000_000,
    degradationPreference: 'maintain-resolution',
    contentHint: 'motion',
    codecOrder: ['video/H264', 'video/VP9', 'video/VP8'],
    adaptationScales: [1, 1.2, 1.5],
    adaptationFrameRates: [30, 20, 15],
    softwareSafeStart: { level: 2, temporalLevel: 1 },
    minimumEncodedHeight: 360,
    minimumAdaptiveBitrate: 300_000,
    playbackBufferMs: 180,
    maxPlaybackBufferMs: 480,
    severeFpsRatio: 0.65,
    pressureFpsRatio: 0.84,
    stableFpsRatio: 0.96,
    severeStep: 1,
    pressureSamples: 3,
    recoverySamples: 14,
    startupSamples: 3,
    networkPressureSamples: 6,
    packetPressureSamples: 3,
    packetLossPressureRatio: 0.015,
    retransmissionPressureRatio: 0.06,
    packetSendDelayPressureMs: 16,
  },
};

export const SCREEN_SHARE_ADAPT_INTERVAL_MS = 1_500;
export const SCREEN_SHARE_BITRATE_INCREASE_INTERVAL_MS = 6_000;
// A probe is intentionally finite: at the adaptation cadence this is about
// 12 seconds of extra bitrate, followed by a separate retry cooldown.
export const RECOVERY_PROBE_MAX_SAMPLES = 8;
export const RECOVERY_PROBE_COOLDOWN_SAMPLES = 10;

const ENCODER_DOWNSCALE_OBSERVATION_SAMPLES = 3;
const ENCODER_DOWNSCALE_MIN_DELIVERY_GAIN = 0.08;
const ENCODER_DOWNSCALE_MIN_COST_REDUCTION = 0.15;
const INEFFECTIVE_DOWNSCALE_COOLDOWN_SAMPLES = 6;
const RECOVERY_PROBE_HEADROOM_RATIO = 1.22;
const BITRATE_QUANTUM = 50_000;
const CURRENT_HEALTH_FPS_MARGIN = 0.03;

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

/**
 * Nominal video budget for one peer at the selected spatial level.
 * Keep this independent from the last `maxBitrate` written to the sender: the
 * network controller needs to compare capacity with the demand of the current
 * operating point, otherwise a capped sender makes a weak link look healthy on
 * the very next sample.
 */
export function screenShareEncodingBitrate(profileId, peerCount = 1, scale = 1) {
  const profile = screenShareProfile(profileId);
  const normalizedPeerCount = Math.max(1, Number(peerCount) || 1);
  const meshFactor = Math.max(1, 1 + ((normalizedPeerCount - 1) * 0.55));
  const spatialScale = Math.max(1, Number(scale) || 1);
  // Cadence fallback is meant to buy more bits and encode time per frame. Do
  // not lower the nominal budget with FPS: OpenH264 otherwise enters continual
  // rate-control frame skipping precisely when the controller is trying to
  // stabilize it. A constrained link is still capped strictly to 78% of the
  // measured capacity below.
  return Math.max(
    profile.minimumAdaptiveBitrate,
    Math.round(profile.maxBitrate / meshFactor / (spatialScale ** 2)),
  );
}

/**
 * Temporary exploration ceiling for the next spatial operating point. Keep
 * it above the recovery gate so GCC can discover capacity, but never above
 * the profile's nominal maximum bitrate.
 */
export function screenShareRecoveryProbeBitrate(profileId, peerCount = 1, scale = 1) {
  const profile = screenShareProfile(profileId);
  const requiredBitrate = screenShareEncodingBitrate(profile.id, peerCount, scale);
  const requested = Math.ceil(
    (requiredBitrate * RECOVERY_PROBE_HEADROOM_RATIO) / BITRATE_QUANTUM,
  ) * BITRATE_QUANTUM;
  return Math.min(profile.maxBitrate, Math.max(requiredBitrate, requested));
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

export async function configureVideoSender(sender, profileId, peerCount = 1) {
  if (!sender?.setParameters || !sender?.getParameters) return false;
  const profile = screenShareProfile(profileId);
  const parameters = sender.getParameters();
  parameters.encodings ??= [{}];
  const encoding = parameters.encodings[0];
  // A mesh uploads one encoded stream per peer. Share the target budget when
  // the room grows so congestion does not collapse every stream at once.
  encoding.maxBitrate = screenShareEncodingBitrate(profile.id, peerCount, 1);
  encoding.maxFramerate = profile.frameRate;
  // A sender is reused when screen share stops and the camera track comes
  // back. Never let an adaptive screen scale leak into that replacement (or
  // into the first samples of a newly selected screen/profile).
  const trackSettings = sender.track?.getSettings?.() || {};
  encoding.scaleResolutionDownBy = safeVideoSenderScale(1, {
    sourceWidth: trackSettings.width,
    sourceHeight: trackSettings.height,
  }, profile.minimumEncodedHeight);
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
  const currentScale = Math.max(1, Number(encoding.scaleResolutionDownBy) || 1);
  const requestedScale = Math.max(1, Number(diagnostics.adaptationScale) || 1);
  const targetFrameRate = Math.max(
    1,
    Math.min(profile.frameRate, Number(diagnostics.targetFrameRate) || profile.frameRate),
  );
  // `scaleResolutionDownBy` is relative to the real captured dimensions, not
  // to the nominal profile. An ultrawide 1280x536 source scaled by 2 would
  // become 640x268 and can cross Chromium's hardware-encoder floor. Prefer
  // media-source/track dimensions; when only outbound stats exist, reconstruct
  // the unscaled height using the currently applied sender scale.
  const sourceHeight = positiveDimension(diagnostics.sourceHeight)
    ?? positiveDimension(diagnostics.trackHeight)
    ?? (() => {
      const encodedHeight = positiveDimension(diagnostics.frameHeight);
      return encodedHeight === null ? null : encodedHeight * currentScale;
    })();
  const sourceWidth = positiveDimension(diagnostics.sourceWidth)
    ?? positiveDimension(diagnostics.trackWidth)
    ?? (() => {
      const encodedWidth = positiveDimension(diagnostics.frameWidth);
      return encodedWidth === null ? null : encodedWidth * currentScale;
    })();
  const adaptationScale = safeVideoSenderScale(requestedScale, {
    sourceWidth,
    sourceHeight,
  }, profile.minimumEncodedHeight);
  // Scale bitrate with pixels, but deliberately retain the per-level budget
  // when cadence falls so software codecs receive more bits per frame.
  const resolutionBudget = screenShareEncodingBitrate(
    profile.id,
    peerCount,
    adaptationScale,
  );
  const available = Number(diagnostics.availableOutgoingBitrate) || 0;
  const packetLossRatio = Math.max(0, Number(diagnostics.packetLossRatio) || 0);
  const retransmissionRatio = Math.max(0, Number(diagnostics.retransmissionRatio) || 0);
  const averagePacketSendDelayMs = Math.max(0, Number(diagnostics.averagePacketSendDelayMs) || 0);
  const packetsDiscardedOnSend = Math.max(0, Number(diagnostics.packetsDiscardedOnSend) || 0);
  const transportPressure = packetLossRatio >= profile.packetLossPressureRatio
    || retransmissionRatio >= profile.retransmissionPressureRatio
    || averagePacketSendDelayMs >= profile.packetSendDelayPressureMs
    || packetsDiscardedOnSend > 0;
  const severeTransportPressure = packetLossRatio >= profile.packetLossPressureRatio * 2.5
    || retransmissionRatio >= profile.retransmissionPressureRatio * 1.75
    || averagePacketSendDelayMs >= profile.packetSendDelayPressureMs * 2
    || packetsDiscardedOnSend > 0;
  // Leave transport headroom for Opus, retransmissions and signaling. A
  // flashing/full-motion screen otherwise fills the queue and loses frames.
  // `availableOutgoingBitrate` already belongs to this peer connection. The
  // mesh factor above accounts for the other uploads; dividing it by the peer
  // count again needlessly starves each individual receiver.
  const transportHeadroom = severeTransportPressure ? 0.64 : transportPressure ? 0.70 : 0.78;
  const networkBudget = available > 0 ? Math.round(available * transportHeadroom) : resolutionBudget;
  const targetBitrate = available > 0
    ? Math.max(32_000, Math.min(resolutionBudget, networkBudget))
    : resolutionBudget;
  const requestedRecoveryProbeMaxBitrate = Number(diagnostics.recoveryProbeMaxBitrate) || 0;
  const recoveryProbeMaxBitrate = diagnostics.recoveryProbeActive === true
    && requestedRecoveryProbeMaxBitrate > resolutionBudget
    && !transportPressure
    && diagnostics.networkPressure !== true
    ? Math.min(profile.maxBitrate, requestedRecoveryProbeMaxBitrate)
    : null;
  const previousBitrate = Number(encoding.maxBitrate) || targetBitrate;
  const structuralChange = Math.abs(currentScale - adaptationScale) >= 0.01
    || Number(encoding.maxFramerate) !== targetFrameRate
    || parameters.degradationPreference !== profile.degradationPreference;
  const startupBitrateGuardActive = diagnostics.startupBitrateGuardActive === true;
  const capacityOnlyBitrateReduction = targetBitrate < previousBitrate
    && !transportPressure
    && !structuralChange;
  // Bandwidth estimates are intentionally noisy. Chasing every sample makes
  // queues empty/fill in bursts and the receiver compensates by varying
  // playout. A falling estimate is a hard ceiling: stepping down over several
  // samples leaves seconds of excess data queued and is perceived as a freeze.
  // Capacity recovery remains deliberately gradual.
  const materialCapacityDrop = targetBitrate < previousBitrate * 0.90;
  const spatialQualityRecovery = adaptationScale < currentScale - 0.01;
  let nextBitrate = targetBitrate < previousBitrate
    // Do not reset the encoder for every small estimator wobble. Severe or
    // material drops remain immediate; sub-10% pressure is absorbed by the
    // existing transport headroom until the estimate proves a real collapse.
    ? (severeTransportPressure || materialCapacityDrop ? targetBitrate : previousBitrate)
    : spatialQualityRecovery && !transportPressure
      // A rolled-back spatial trial restores many more pixels at once. The
      // target is already capped to 78% of measured capacity, so restore its
      // matching bitrate atomically instead of creating a multi-sample quality
      // ramp whose changing cap looks like transport oscillation.
      ? targetBitrate
      // Recovery updates are coalesced by the caller. A larger step at that
      // lower cadence preserves the old recovery time without asking
      // OpenH264/driver encoders for a keyframe every adaptation sample.
      : Math.min(targetBitrate, Math.round(previousBitrate * 1.40));
  if (startupBitrateGuardActive && capacityOnlyBitrateReduction && recoveryProbeMaxBitrate === null) {
    // GCC's first reports are often conservative. Do not turn a capacity-only
    // bootstrap estimate into a hard cap before the existing startup window
    // has elapsed; real transport pressure remains an immediate bypass.
    nextBitrate = previousBitrate;
  }
  if (recoveryProbeMaxBitrate !== null) nextBitrate = recoveryProbeMaxBitrate;
  if (!structuralChange && recoveryProbeMaxBitrate === null && nextBitrate > previousBitrate
      && diagnostics.allowBitrateIncrease === false) {
    nextBitrate = previousBitrate;
  }
  const sameParameters = Math.abs(previousBitrate - nextBitrate) < 50_000
    && Math.abs(currentScale - adaptationScale) < 0.01
    && Number(encoding.maxFramerate) === targetFrameRate
    && parameters.degradationPreference === profile.degradationPreference;
  if (sameParameters) return true;

  encoding.maxBitrate = nextBitrate;
  encoding.maxFramerate = targetFrameRate;
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
  const profile = screenShareProfile(profileId);
  return {
    profileId: profile.id,
    level: 0,
    temporalLevel: 0,
    frameRate: profile.adaptationFrameRates[0],
    currentOperatingPointHealthy: false,
    poorSamples: 0,
    stableSamples: 0,
    cooldownSamples: 0,
    sourceSamples: 0,
    networkSamples: 0,
    sampleCount: 0,
    fpsEma: 0,
    encodeEma: 0,
    scale: 1,
    reason: 'initial',
    recoveryProbeActive: false,
    recoveryProbeSamples: 0,
    recoveryProbeCooldownSamples: 0,
    recoveryProbeMaxBitrate: null,
    recoveryProbeReason: null,
    encoderTrial: null,
    downscaleEffectiveness: {
      status: 'idle',
      samplesObserved: 0,
      samplesRequired: ENCODER_DOWNSCALE_OBSERVATION_SAMPLES,
      requiredDeliveryGain: ENCODER_DOWNSCALE_MIN_DELIVERY_GAIN,
      requiredEncodeCostReductionRatio: ENCODER_DOWNSCALE_MIN_COST_REDUCTION,
    },
  };
}

export function evaluateCaptureAdaptation(previous, profileId, diagnostics = {}) {
  const profile = screenShareProfile(profileId);
  const current = previous?.profileId === profile.id ? previous : initialCaptureAdaptation(profile.id);
  const temporalLevel = Math.max(
    0,
    Math.min(
      profile.adaptationFrameRates.length - 1,
      Number.isInteger(current.temporalLevel) ? current.temporalLevel : 0,
    ),
  );
  const targetFrameRate = profile.adaptationFrameRates[temporalLevel];
  // A zero reported by getStats is a real stall. Undefined/null means that a
  // Chromium build did not expose that stage and must not trigger a blind
  // resolution downgrade.
  const numericFps = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const captureFps = numericFps(diagnostics.captureFps);
  const encodedFps = numericFps(diagnostics.framesPerSecond);
  const fpsSamples = [captureFps, encodedFps].filter((value) => value !== null);
  const measuredFps = fpsSamples.length ? Math.min(...fpsSamples) : 0;
  // Zero is a real stall and must pull the trend down. Only a completely
  // missing FPS path preserves the prior EMA.
  const hasFpsSample = fpsSamples.length > 0;
  const hasPriorFpsSample = (Number(current.sampleCount) || 0) > 0;
  const fpsEma = hasFpsSample
    ? (hasPriorFpsSample ? (current.fpsEma * 0.58) + (measuredFps * 0.42) : measuredFps)
    : current.fpsEma;
  const fpsRatio = hasFpsSample ? fpsEma / targetFrameRate : 1;
  const encodeBudgetMs = 1000 / targetFrameRate;
  const measuredEncodeSample = numericFps(diagnostics.averageEncodeTimeMs);
  const measuredEncode = measuredEncodeSample ?? 0;
  const encodeEma = measuredEncode > 0 ? (current.encodeEma > 0 ? (current.encodeEma * 0.58) + (measuredEncode * 0.42) : measuredEncode) : current.encodeEma;
  const instantEncodeRatio = measuredEncode / encodeBudgetMs;
  const encodeRatio = encodeEma / encodeBudgetMs;
  const limitation = diagnostics.qualityLimitationReason || 'none';
  const availableOutgoingBitrate = Number(diagnostics.availableOutgoingBitrate) || 0;
  const packetLossRatio = Math.max(0, Number(diagnostics.packetLossRatio) || 0);
  const retransmissionRatio = Math.max(0, Number(diagnostics.retransmissionRatio) || 0);
  const averagePacketSendDelayMs = Math.max(0, Number(diagnostics.averagePacketSendDelayMs) || 0);
  const packetsDiscardedOnSend = Math.max(0, Number(diagnostics.packetsDiscardedOnSend) || 0);
  const requiredBitrate = screenShareEncodingBitrate(
    profile.id,
    diagnostics.peerCount,
    profile.adaptationScales[current.level] || 1,
  );
  // Compare the estimate with the actual demand of this operating point, not
  // with maxBitrate (which is itself capped to the previous estimate). This
  // keeps sustained low capacity visible across samples.
  const networkHeadroomRatio = availableOutgoingBitrate > 0 && requiredBitrate > 0
    ? availableOutgoingBitrate / requiredBitrate
    : null;
  const capacityPressure = networkHeadroomRatio !== null && networkHeadroomRatio < 0.92;
  const packetLossPressure = packetLossRatio >= profile.packetLossPressureRatio;
  const retransmissionPressure = retransmissionRatio >= profile.retransmissionPressureRatio;
  const pacerPressure = averagePacketSendDelayMs >= profile.packetSendDelayPressureMs;
  const discardedPacketPressure = packetsDiscardedOnSend > 0;
  const transportPressure = packetLossPressure || retransmissionPressure || pacerPressure || discardedPacketPressure;
  const networkPressure = capacityPressure || transportPressure;
  let networkSamples = networkPressure ? (Number(current.networkSamples) || 0) + 1 : 0;
  const pressureSamplesRequired = discardedPacketPressure
    ? 1
    : transportPressure ? profile.packetPressureSamples : profile.networkPressureSamples;
  const actionableNetworkPressure = networkPressure
    && networkSamples >= pressureSamplesRequired;
  const recoveryScale = temporalLevel > 0
    ? profile.adaptationScales[current.level]
    : profile.adaptationScales[Math.max(0, current.level - 1)];
  const recoveryFrameRate = temporalLevel > 0
    ? profile.adaptationFrameRates[temporalLevel - 1]
    : targetFrameRate;
  const recoveryRequiredBitrate = screenShareEncodingBitrate(
    profile.id,
    diagnostics.peerCount,
    recoveryScale,
  );
  // Require extra capacity before restoring a richer operating point. Merely
  // fitting the current low level is not evidence that the next one will fit;
  // without this gate the controller bounces between 30 and 60 FPS forever.
  const networkRecoveryHeadroomRatio = availableOutgoingBitrate > 0
    ? availableOutgoingBitrate / recoveryRequiredBitrate
    : null;
  const networkRecoveryReady = current.level === 0 && temporalLevel === 0
    ? true
    : !transportPressure && (networkRecoveryHeadroomRatio === null || networkRecoveryHeadroomRatio >= 1.12);
  const currentScaleForRecovery = profile.adaptationScales[current.level] || 1;
  const projectedRecoveryEncodeMs = encodeEma > 0
    ? encodeEma * ((currentScaleForRecovery / recoveryScale) ** 2)
    : null;
  const recoveryEncodeBudgetMs = 1000 / recoveryFrameRate;
  const encoderRecoveryReady = current.level === 0 && temporalLevel === 0
    ? true
    : projectedRecoveryEncodeMs === null
      || projectedRecoveryEncodeMs < recoveryEncodeBudgetMs * 0.66;
  const hasPipelineFps = captureFps !== null && encodedFps !== null;
  const captureRatio = captureFps !== null ? captureFps / targetFrameRate : 1;
  const encodedRatio = encodedFps !== null ? encodedFps / targetFrameRate : 1;
  const expectedEncoderInputFps = captureFps === null
    ? targetFrameRate
    : Math.min(captureFps, targetFrameRate);
  const encoderDeliveryRatio = hasPipelineFps
    ? (expectedEncoderInputFps > 0
      ? encodedFps / expectedEncoderInputFps
      : (encodedFps === 0 ? 1 : 0))
    : 1;
  // Sender scaling happens after desktop capture. If the encoder is already
  // delivering virtually every captured frame with ample encode headroom,
  // reducing sender pixels cannot improve capture cadence. This was the exact
  // v1.0.17 failure: 30 source FPS became 30 encoded FPS at progressively
  // worse resolutions.
  const sourceLimited = hasPipelineFps
    && captureRatio < profile.pressureFpsRatio
    && encoderDeliveryRatio >= 0.92
    && instantEncodeRatio < 0.65
    && limitation !== 'cpu'
    && !networkPressure;
  // Health of the current operating point is distinct from proof that the
  // next, richer point will fit. A source delivering 57/60 FPS with virtually
  // no encoder loss is healthy even though it is below the nominal 60 FPS;
  // use the rolling FPS trend so normal capture jitter does not erase health
  // every 1.5-second sample. The nominal stableFpsRatio remains the recovery
  // gate; this tolerance only classifies the current point as healthy.
  const currentHealthFpsRatio = Math.max(
    profile.pressureFpsRatio,
    profile.stableFpsRatio - CURRENT_HEALTH_FPS_MARGIN,
  );
  const currentOperatingPointHealthy = hasPipelineFps
    && !sourceLimited
    && fpsRatio >= currentHealthFpsRatio
    && encoderDeliveryRatio >= 0.92
    && encodeRatio < 0.66
    && limitation !== 'cpu'
    && !networkPressure;
  const fpsPipelinePressure = hasPipelineFps
    && !sourceLimited
    && encodedRatio < profile.pressureFpsRatio
    && encoderDeliveryRatio < 0.90;
  // Decisions require both the latest sample and the rolling trend. Absolute
  // FPS alone is not actionable unless source and encoder statistics identify
  // an actual downstream loss.
  const severePressure = (fpsPipelinePressure
    && encodedRatio < profile.severeFpsRatio
    && fpsRatio < profile.pressureFpsRatio)
    || (instantEncodeRatio > 1.08 && encodeRatio > 0.92);
  const moderatePressure = (fpsPipelinePressure
    && fpsRatio < Math.min(0.95, profile.pressureFpsRatio + 0.04))
    || (instantEncodeRatio > 0.82
      && encodeRatio > 0.76
      // High encoder utilization is not a failure while virtually every
      // captured frame still meets its deadline. Treat it as pressure only
      // after delivery starts slipping, a deadline is missed, or Chromium
      // explicitly reports CPU limitation.
      && (encoderDeliveryRatio < 0.94 || instantEncodeRatio > 1 || limitation === 'cpu'))
    || limitation === 'cpu';
  const stable = currentOperatingPointHealthy
    && networkRecoveryReady
    && encoderRecoveryReady;
  const sampleCount = (Number(current.sampleCount) || 0) + 1;
  const observingStartup = sampleCount <= profile.startupSamples;
  const startupBitrateGuardActive = observingStartup;
  const encoderImplementation = String(diagnostics.encoderImplementation || '');
  const softwareEncoder = diagnostics.powerEfficientEncoder === false
    || /openh264|libvpx|ffmpeg|software/i.test(encoderImplementation);
  let level = current.level;
  let nextTemporalLevel = temporalLevel;
  const levelBeforeDecision = level;
  const temporalLevelBeforeDecision = nextTemporalLevel;
  let poorSamples = moderatePressure && !observingStartup ? current.poorSamples + 1 : 0;
  let stableSamples = currentOperatingPointHealthy ? current.stableSamples + 1 : 0;
  let sourceSamples = sourceLimited ? (Number(current.sourceSamples) || 0) + 1 : 0;
  let cooldownSamples = Math.max(0, Number(current.cooldownSamples) - 1);
  let reason = current.reason;
  let recoveryProbeActive = current.recoveryProbeActive === true;
  let recoveryProbeSamples = recoveryProbeActive
    ? Math.max(0, Number(current.recoveryProbeSamples) || 0)
    : 0;
  let recoveryProbeCooldownSamples = Math.max(
    0,
    (Number(current.recoveryProbeCooldownSamples) || 0) - 1,
  );
  let recoveryProbeMaxBitrate = Number(current.recoveryProbeMaxBitrate) || null;
  let recoveryProbeReason = current.recoveryProbeReason || null;
  let recoveryProbeAbortReason = null;
  if (recoveryProbeActive && (
    level === 0
    || temporalLevel > 0
    || !currentOperatingPointHealthy
    || networkPressure
    || !encoderRecoveryReady
  )) {
    recoveryProbeActive = false;
    recoveryProbeMaxBitrate = null;
    recoveryProbeAbortReason = !currentOperatingPointHealthy ? 'current-operating-point-unhealthy'
      : networkPressure ? 'transport-or-network-pressure'
        : !encoderRecoveryReady ? 'encoder-recovery-not-ready'
          : temporalLevel > 0 ? 'temporal-level-active' : 'level-zero';
    recoveryProbeReason = 'spatial-recovery-probe-aborted';
    recoveryProbeSamples = 0;
    recoveryProbeCooldownSamples = Math.max(recoveryProbeCooldownSamples, 2);
    cooldownSamples = Math.max(cooldownSamples, 3);
    reason = recoveryProbeReason;
  } else if (recoveryProbeActive) {
    recoveryProbeSamples += 1;
    if (!networkRecoveryReady && recoveryProbeSamples >= RECOVERY_PROBE_MAX_SAMPLES) {
      recoveryProbeActive = false;
      recoveryProbeSamples = 0;
      recoveryProbeCooldownSamples = RECOVERY_PROBE_COOLDOWN_SAMPLES;
      recoveryProbeMaxBitrate = null;
      recoveryProbeReason = 'spatial-recovery-probe-timeout';
      recoveryProbeAbortReason = 'insufficient-next-point-headroom';
      reason = recoveryProbeReason;
    }
  }
  let encoderTrial = current.encoderTrial ? { ...current.encoderTrial } : null;
  let downscaleEffectiveness = current.downscaleEffectiveness || {
    status: 'idle',
    samplesObserved: 0,
    samplesRequired: ENCODER_DOWNSCALE_OBSERVATION_SAMPLES,
    requiredDeliveryGain: ENCODER_DOWNSCALE_MIN_DELIVERY_GAIN,
    requiredEncodeCostReductionRatio: ENCODER_DOWNSCALE_MIN_COST_REDUCTION,
  };
  let downscaleTriggerReason = null;
  let trialHandled = false;
  let bottleneck = 'unknown';
  if (sourceLimited) bottleneck = 'source';
  else if (networkPressure) bottleneck = 'network';
  else if (moderatePressure || severePressure) bottleneck = 'encoder';
  else if (currentOperatingPointHealthy) bottleneck = 'healthy';
  const lastSpatialTrialWasIneffective = downscaleEffectiveness.status === 'ineffective'
    && downscaleEffectiveness.fromLevel === level
    && downscaleEffectiveness.toLevel === level + 1;
  const trialBaselineDelivery = numericFps(downscaleEffectiveness.baselineDeliveryRatio);
  const trialBaselineEncodeRatio = numericFps(downscaleEffectiveness.baselineEncodeRatio);
  const deliveryDeterioratedSinceTrial = trialBaselineDelivery !== null
    && encoderDeliveryRatio < Math.min(0.85, trialBaselineDelivery - 0.08);
  const encodeDeterioratedSinceTrial = trialBaselineEncodeRatio !== null
    && instantEncodeRatio >= Math.max(1.08, trialBaselineEncodeRatio + 0.15);
  // An ineffective spatial trial must not be retried on the same steady-state
  // measurements every few seconds. That loop was itself a visible 540p/360p
  // quality oscillation. Retry only after the encoder materially worsens;
  // network pressure remains free to downshift independently.
  const spatialRetryBlocked = lastSpatialTrialWasIneffective
    && !deliveryDeterioratedSinceTrial
    && !encodeDeterioratedSinceTrial;

  // A spatial downscale is a hypothesis, not a permanent conclusion. Compare
  // three post-change samples against the pre-change delivery/cost baseline.
  // While observing, do not stack another resolution change on top: otherwise
  // it becomes impossible to know which level helped.
  if (encoderTrial) {
    if (level !== encoderTrial.toLevel) {
      downscaleEffectiveness = {
        ...downscaleEffectiveness,
        status: 'canceled',
        canceledReason: 'level-changed-during-observation',
      };
      encoderTrial = null;
      reason = 'encoder-downscale-observation-canceled';
      trialHandled = true;
    } else {
      const deliveryComparable = encoderTrial.baselineDeliveryRatio !== null
        && hasPipelineFps;
      const encodeComparable = encoderTrial.baselineEncodeTimeMs !== null
        && encoderTrial.baselineEncodeTimeMs > 0
        && measuredEncodeSample !== null;
      encoderTrial.samplesObserved += 1;
      if (deliveryComparable) {
        encoderTrial.deliverySum += encoderDeliveryRatio;
        encoderTrial.deliverySamples += 1;
      }
      if (encodeComparable) {
        encoderTrial.encodeTimeSum += measuredEncodeSample;
        encoderTrial.encodeTimeSamples += 1;
      }
      const observedDeliveryRatio = encoderTrial.deliverySamples > 0
        ? encoderTrial.deliverySum / encoderTrial.deliverySamples
        : null;
      const observedEncodeTimeMs = encoderTrial.encodeTimeSamples > 0
        ? encoderTrial.encodeTimeSum / encoderTrial.encodeTimeSamples
        : null;
      const deliveryGain = observedDeliveryRatio === null
        || encoderTrial.baselineDeliveryRatio === null
        ? null
        : observedDeliveryRatio - encoderTrial.baselineDeliveryRatio;
      const encodeCostReductionRatio = observedEncodeTimeMs === null
        || !(encoderTrial.baselineEncodeTimeMs > 0)
        ? null
        : (encoderTrial.baselineEncodeTimeMs - observedEncodeTimeMs)
          / encoderTrial.baselineEncodeTimeMs;
      const baselineEncodeRatio = encoderTrial.baselineEncodeBudgetMs > 0
        && encoderTrial.baselineEncodeTimeMs !== null
        ? encoderTrial.baselineEncodeTimeMs / encoderTrial.baselineEncodeBudgetMs
        : null;
      const observedEncodeRatio = encoderTrial.baselineEncodeBudgetMs > 0
        && observedEncodeTimeMs !== null
        ? observedEncodeTimeMs / encoderTrial.baselineEncodeBudgetMs
        : null;
      downscaleEffectiveness = {
        status: 'observing',
        triggerReason: encoderTrial.triggerReason,
        fromLevel: encoderTrial.fromLevel,
        toLevel: encoderTrial.toLevel,
        samplesObserved: encoderTrial.samplesObserved,
        samplesRequired: ENCODER_DOWNSCALE_OBSERVATION_SAMPLES,
        requiredDeliveryGain: ENCODER_DOWNSCALE_MIN_DELIVERY_GAIN,
        requiredEncodeCostReductionRatio: ENCODER_DOWNSCALE_MIN_COST_REDUCTION,
        baselineDeliveryRatio: encoderTrial.baselineDeliveryRatio,
        observedDeliveryRatio,
        deliveryGain,
        baselineEncodeTimeMs: encoderTrial.baselineEncodeTimeMs,
        observedEncodeTimeMs,
        encodeCostReductionRatio,
        baselineEncodeRatio,
        observedEncodeRatio,
      };

      if (encoderTrial.samplesObserved < ENCODER_DOWNSCALE_OBSERVATION_SAMPLES) {
        poorSamples = 0;
        stableSamples = 0;
        sourceSamples = 0;
        reason = 'encoder-downscale-observation';
        trialHandled = true;
      } else {
        const deliveryRecovered = encoderTrial.baselineDeliveryRatio !== null
          && encoderTrial.baselineDeliveryRatio < 0.90
          && observedDeliveryRatio !== null
          && observedDeliveryRatio >= 0.92;
        const materialDeliveryGain = deliveryGain !== null
          && deliveryGain >= ENCODER_DOWNSCALE_MIN_DELIVERY_GAIN;
        const materialEncodeCostReduction = encodeCostReductionRatio !== null
          && encodeCostReductionRatio >= ENCODER_DOWNSCALE_MIN_COST_REDUCTION;
        // Lower CPU cost alone does not justify throwing away readable screen
        // detail when the old level already met its frame deadline. Keep the
        // spatial reduction only when it restores delivery or rescues an
        // encoder that was actually taking longer than one frame budget.
        const encodeDeadlineRescued = materialEncodeCostReduction
          && baselineEncodeRatio !== null
          && baselineEncodeRatio >= 1
          && observedEncodeRatio !== null
          && observedEncodeRatio <= 0.90;
        const comparableSamples = encoderTrial.deliverySamples
          + encoderTrial.encodeTimeSamples;
        const effective = deliveryRecovered
          || materialDeliveryGain
          || encodeDeadlineRescued;
        downscaleEffectiveness = {
          ...downscaleEffectiveness,
          status: effective ? 'effective' : comparableSamples > 0 ? 'ineffective' : 'unproven',
          materialDeliveryGain,
          materialEncodeCostReduction,
          encodeDeadlineRescued,
        };
        poorSamples = 0;
        stableSamples = 0;
        sourceSamples = 0;
        bottleneck = 'encoder';
        encoderTrial = null;
        trialHandled = true;
        if (effective) {
          cooldownSamples = Math.max(cooldownSamples, 2);
          reason = 'encoder-downscale-effective';
        } else {
          level = downscaleEffectiveness.fromLevel;
          cooldownSamples = INEFFECTIVE_DOWNSCALE_COOLDOWN_SAMPLES;
          reason = downscaleEffectiveness.status === 'unproven'
            ? 'encoder-downscale-unproven-rollback'
            : 'encoder-downscale-ineffective-rollback';
        }
      }
    }
  }

  if (trialHandled) {
    // Trial observation/result owns this sample.
  } else if (softwareEncoder && sampleCount === 1 && level === 0 && nextTemporalLevel === 0) {
    // An actual outbound stats sample is stronger evidence than the generic
    // GPU feature flag. Start software codecs at a sustainable pixel rate so
    // low-end devices do not spend 10–20 seconds visibly collapsing through
    // every hardware-oriented level first. Normal recovery can still probe
    // richer levels later when the measured encoder has headroom.
    level = profile.softwareSafeStart.level;
    nextTemporalLevel = profile.softwareSafeStart.temporalLevel;
    poorSamples = 0;
    stableSamples = 0;
    cooldownSamples = 2;
    reason = 'software-encoder-safe-start';
    bottleneck = 'encoder';
  } else if (cooldownSamples > 0) {
    // Hold the current resolution long enough for congestion control and the
    // hardware encoder to settle before judging the next sample.
  } else if (observingStartup && (severePressure || moderatePressure)) {
    // Hardware encoders and GCC need a few reports to initialize. Acting on
    // their first low/"bandwidth" samples caused an immediate quality plunge
    // before either stage had reached steady state.
    reason = 'startup-observation';
  } else if (sourceLimited && level > 0 && sourceSamples >= 2) {
    // Undo an earlier encoder/network downshift when it no longer helps. A
    // source-limited cadence should retain spatial quality rather than waiting
    // forever for an impossible 60 FPS recovery signal.
    level -= 1;
    poorSamples = 0;
    stableSamples = 0;
    sourceSamples = 0;
    cooldownSamples = 2;
    reason = 'source-limited-recovery';
  } else if (actionableNetworkPressure) {
    // Once the capacity deficit survives the startup/ramp-up window, reduce
    // the encoded pixel rate instead of squeezing the same 720p/1080p stream
    // into an ever smaller bitrate. Spatial detail is reduced first; cadence
    // becomes the last-resort safety valve at the bottom spatial level.
    if (level < profile.adaptationScales.length - 1) {
      level += 1;
      reason = 'network-spatial-downshift';
    } else if (nextTemporalLevel < profile.adaptationFrameRates.length - 1) {
      nextTemporalLevel += 1;
      reason = 'network-temporal-downshift';
    } else {
      reason = 'network-minimum-operating-point';
    }
    poorSamples = 0;
    stableSamples = 0;
    networkSamples = 0;
    cooldownSamples = 2;
    bottleneck = 'network';
  } else if (severePressure) {
    if (level < profile.adaptationScales.length - 1 && !spatialRetryBlocked) {
      level += profile.severeStep;
      reason = fpsPipelinePressure ? 'encoder-fps-severe' : 'encode-severe';
      downscaleTriggerReason = reason;
    } else if (nextTemporalLevel < profile.adaptationFrameRates.length - 1) {
      if (level === profile.adaptationScales.length - 1) {
        nextTemporalLevel += 1;
        reason = 'encoder-temporal-severe';
      } else {
        reason = 'encoder-downscale-ineffective-hold';
      }
    }
    poorSamples = 0;
    stableSamples = 0;
    cooldownSamples = 2;
  } else if (moderatePressure && poorSamples >= profile.pressureSamples) {
    if (level < profile.adaptationScales.length - 1 && !spatialRetryBlocked) {
      level += 1;
      reason = limitation === 'cpu' ? 'cpu' : instantEncodeRatio > 0.82 ? 'encode' : 'encoder-fps';
      downscaleTriggerReason = reason;
    } else if (nextTemporalLevel < profile.adaptationFrameRates.length - 1) {
      if (level === profile.adaptationScales.length - 1) {
        nextTemporalLevel += 1;
        reason = 'encoder-temporal';
      } else {
        reason = 'encoder-downscale-ineffective-hold';
      }
    }
    poorSamples = 0;
    stableSamples = 0;
    cooldownSamples = 2;
  } else if (!recoveryProbeActive
      && level > 0
      && temporalLevel === 0
      && currentOperatingPointHealthy
      && !networkPressure
      && encoderRecoveryReady
      && !networkRecoveryReady
      && recoveryProbeCooldownSamples === 0
      && stableSamples >= profile.recoverySamples) {
    recoveryProbeActive = true;
    recoveryProbeSamples = 0;
    recoveryProbeMaxBitrate = screenShareRecoveryProbeBitrate(
      profile.id,
      diagnostics.peerCount,
      recoveryScale,
    );
    recoveryProbeReason = 'insufficient-next-point-headroom';
    recoveryProbeAbortReason = null;
    reason = 'spatial-recovery-probe';
  } else if (stable && stableSamples >= profile.recoverySamples) {
    if (nextTemporalLevel > 0) {
      nextTemporalLevel -= 1;
      reason = 'temporal-recovery';
    } else {
      level -= 1;
      reason = 'recovery';
    }
    recoveryProbeActive = false;
    recoveryProbeSamples = 0;
    recoveryProbeCooldownSamples = 0;
    recoveryProbeMaxBitrate = null;
    recoveryProbeReason = null;
    stableSamples = 0;
    poorSamples = 0;
    cooldownSamples = 5;
  } else if (recoveryProbeActive) {
    reason = 'spatial-recovery-probe';
  } else if (sourceLimited) {
    reason = 'source-limited';
  } else if (networkPressure) {
    // `adaptVideoSender` already follows the measured transport budget on the
    // first sample. Wait for sustained pressure before also changing pixels or
    // cadence, so a normal GCC startup ramp does not destroy spatial quality.
    reason = actionableNetworkPressure ? 'network-bitrate-only' : 'network-observation';
  }

  level = Math.max(0, Math.min(profile.adaptationScales.length - 1, level));
  nextTemporalLevel = Math.max(
    0,
    Math.min(profile.adaptationFrameRates.length - 1, nextTemporalLevel),
  );
  if (downscaleTriggerReason && level > levelBeforeDecision) {
    encoderTrial = {
      triggerReason: downscaleTriggerReason,
      fromLevel: levelBeforeDecision,
      toLevel: level,
      samplesObserved: 0,
      baselineDeliveryRatio: hasPipelineFps ? encoderDeliveryRatio : null,
      baselineEncodeTimeMs: measuredEncodeSample,
      baselineEncodeBudgetMs: encodeBudgetMs,
      deliverySum: 0,
      deliverySamples: 0,
      encodeTimeSum: 0,
      encodeTimeSamples: 0,
    };
    downscaleEffectiveness = {
      status: 'observing',
      triggerReason: downscaleTriggerReason,
      fromLevel: levelBeforeDecision,
      toLevel: level,
      samplesObserved: 0,
      samplesRequired: ENCODER_DOWNSCALE_OBSERVATION_SAMPLES,
      requiredDeliveryGain: ENCODER_DOWNSCALE_MIN_DELIVERY_GAIN,
      requiredEncodeCostReductionRatio: ENCODER_DOWNSCALE_MIN_COST_REDUCTION,
      baselineDeliveryRatio: encoderTrial.baselineDeliveryRatio,
      observedDeliveryRatio: null,
      deliveryGain: null,
      baselineEncodeTimeMs: encoderTrial.baselineEncodeTimeMs,
      observedEncodeTimeMs: null,
      encodeCostReductionRatio: null,
    };
  }
  const scale = profile.adaptationScales[level];
  const frameRate = profile.adaptationFrameRates[nextTemporalLevel];
  return {
    profileId: profile.id,
    level,
    temporalLevel: nextTemporalLevel,
    poorSamples,
    stableSamples,
    sourceSamples,
    networkSamples,
    sampleCount,
    cooldownSamples,
    scale,
    frameRate,
    currentOperatingPointHealthy,
    reason,
    targetFps: frameRate,
    measuredFps,
    captureFps: captureFps ?? 0,
    encodedFps: encodedFps ?? 0,
    encoderDeliveryRatio,
    bottleneck,
    sourceLimited,
    networkPressure,
    capacityPressure,
    transportPressure,
    packetLossPressure,
    retransmissionPressure,
    pacerPressure,
    discardedPacketPressure,
    packetLossRatio,
    retransmissionRatio,
    averagePacketSendDelayMs,
    packetsDiscardedOnSend,
    startupBitrateGuardActive,
    pressureSamplesRequired,
    networkSustained: actionableNetworkPressure,
    networkHeadroomRatio,
    requiredBitrate,
    recoveryRequiredBitrate,
    networkRecoveryHeadroomRatio,
    networkRecoveryReady,
    recoveryProbeActive,
    recoveryProbeSamples,
    recoveryProbeCooldownSamples,
    recoveryProbeMaxBitrate,
    recoveryProbeReason,
    recoveryProbeAbortReason,
    projectedRecoveryEncodeMs,
    encoderRecoveryReady,
    encoderTrial,
    downscaleEffectiveness,
    averageEncodeTimeMs: measuredEncode,
    fpsEma,
    encodeEma,
    effectiveWidth: Math.round(profile.width / scale),
    effectiveHeight: Math.round(profile.height / scale),
    temporalChanged: nextTemporalLevel !== temporalLevelBeforeDecision,
    softwareEncoder,
    encoderImplementation: encoderImplementation || null,
  };
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

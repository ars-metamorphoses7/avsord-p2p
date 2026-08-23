export const SCREEN_SHARE_PROFILES = {
  performance: {
    id: 'performance',
    label: 'desempenho',
    description: '60 FPS alvo · 360p–720p automático',
    width: 1280,
    height: 720,
    frameRate: 60,
    maxBitrate: 8_000_000,
    minBitrate: 1_200_000,
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
    minimumEncodedHeight: 360,
    playbackBufferMs: 140,
    severeFpsRatio: 0.72,
    pressureFpsRatio: 0.90,
    stableFpsRatio: 0.97,
    severeStep: 1,
    pressureSamples: 2,
    recoverySamples: 10,
    startupSamples: 3,
    networkPressureSamples: 4,
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
    degradationPreference: 'maintain-resolution',
    contentHint: 'motion',
    codecOrder: ['video/H264', 'video/VP9', 'video/VP8'],
    adaptationScales: [1, 1.2, 1.5],
    minimumEncodedHeight: 360,
    playbackBufferMs: 180,
    severeFpsRatio: 0.65,
    pressureFpsRatio: 0.84,
    stableFpsRatio: 0.96,
    severeStep: 1,
    pressureSamples: 3,
    recoverySamples: 14,
    startupSamples: 3,
    networkPressureSamples: 6,
  },
};

export const SCREEN_SHARE_ADAPT_INTERVAL_MS = 1_500;

const ENCODER_DOWNSCALE_OBSERVATION_SAMPLES = 3;
const ENCODER_DOWNSCALE_MIN_DELIVERY_GAIN = 0.08;
const ENCODER_DOWNSCALE_MIN_COST_REDUCTION = 0.15;
const INEFFECTIVE_DOWNSCALE_COOLDOWN_SAMPLES = 6;

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
  const meshFactor = Math.max(1, 1 + ((Math.max(1, peerCount) - 1) * 0.55));
  encoding.maxBitrate = Math.max(profile.minBitrate, Math.round(profile.maxBitrate / meshFactor));
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
    sourceSamples: 0,
    networkSamples: 0,
    sampleCount: 0,
    fpsEma: 0,
    encodeEma: 0,
    scale: 1,
    reason: 'initial',
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
  const fpsRatio = hasFpsSample ? fpsEma / profile.frameRate : 1;
  const encodeBudgetMs = 1000 / profile.frameRate;
  const measuredEncodeSample = numericFps(diagnostics.averageEncodeTimeMs);
  const measuredEncode = measuredEncodeSample ?? 0;
  const encodeEma = measuredEncode > 0 ? (current.encodeEma > 0 ? (current.encodeEma * 0.58) + (measuredEncode * 0.42) : measuredEncode) : current.encodeEma;
  const instantEncodeRatio = measuredEncode / encodeBudgetMs;
  const encodeRatio = encodeEma / encodeBudgetMs;
  const limitation = diagnostics.qualityLimitationReason || 'none';
  const availableOutgoingBitrate = Number(diagnostics.availableOutgoingBitrate) || 0;
  const configuredMaxBitrate = Number(diagnostics.configuredMaxBitrate) || 0;
  const networkHeadroomRatio = availableOutgoingBitrate > 0 && configuredMaxBitrate > 0
    ? availableOutgoingBitrate / configuredMaxBitrate
    : null;
  const networkPressure = limitation === 'bandwidth'
    && (networkHeadroomRatio === null || networkHeadroomRatio < 0.92);
  const networkSamples = networkPressure ? (Number(current.networkSamples) || 0) + 1 : 0;
  const actionableNetworkPressure = networkPressure
    && networkSamples >= profile.networkPressureSamples;
  const hasPipelineFps = captureFps !== null && encodedFps !== null;
  const captureRatio = captureFps !== null ? captureFps / profile.frameRate : 1;
  const encodedRatio = encodedFps !== null ? encodedFps / profile.frameRate : 1;
  const encoderDeliveryRatio = hasPipelineFps
    ? (captureFps > 0 ? encodedFps / captureFps : (encodedFps === 0 ? 1 : 0))
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
    || (instantEncodeRatio > 0.82 && encodeRatio > 0.76)
    || limitation === 'cpu';
  const stable = (encodedFps !== null || captureFps !== null)
    && !sourceLimited
    && encodedRatio >= profile.stableFpsRatio
    && fpsRatio >= profile.stableFpsRatio - 0.02
    && encodeRatio < 0.66
    && limitation !== 'cpu'
    && !networkPressure;
  const sampleCount = (Number(current.sampleCount) || 0) + 1;
  const observingStartup = sampleCount <= profile.startupSamples;
  let level = current.level;
  const levelBeforeDecision = level;
  let poorSamples = moderatePressure && !observingStartup ? current.poorSamples + 1 : 0;
  let stableSamples = stable ? current.stableSamples + 1 : 0;
  let sourceSamples = sourceLimited ? (Number(current.sourceSamples) || 0) + 1 : 0;
  let cooldownSamples = Math.max(0, Number(current.cooldownSamples) - 1);
  let reason = current.reason;
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
  else if (moderatePressure || severePressure) bottleneck = 'encoder';
  else if (networkPressure) bottleneck = 'network';
  else if (stable) bottleneck = 'healthy';

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
        const comparableSamples = encoderTrial.deliverySamples
          + encoderTrial.encodeTimeSamples;
        const effective = deliveryRecovered
          || materialDeliveryGain
          || materialEncodeCostReduction;
        downscaleEffectiveness = {
          ...downscaleEffectiveness,
          status: effective ? 'effective' : comparableSamples > 0 ? 'ineffective' : 'unproven',
          materialDeliveryGain,
          materialEncodeCostReduction,
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
  } else if (severePressure) {
    level += profile.severeStep;
    poorSamples = 0;
    stableSamples = 0;
    cooldownSamples = 2;
    reason = fpsPipelinePressure ? 'encoder-fps-severe' : 'encode-severe';
    downscaleTriggerReason = reason;
  } else if (moderatePressure && poorSamples >= profile.pressureSamples) {
    level += 1;
    poorSamples = 0;
    stableSamples = 0;
    cooldownSamples = 2;
    reason = limitation === 'cpu' ? 'cpu' : instantEncodeRatio > 0.82 ? 'encode' : 'encoder-fps';
    downscaleTriggerReason = reason;
  } else if (stable && stableSamples >= profile.recoverySamples) {
    level -= 1;
    stableSamples = 0;
    poorSamples = 0;
    cooldownSamples = 5;
    reason = 'recovery';
  } else if (sourceLimited) {
    reason = 'source-limited';
  } else if (networkPressure) {
    // `adaptVideoSender` already follows the measured transport budget. A
    // bandwidth-only signal must not destroy spatial quality without evidence
    // that the encoder itself is failing to deliver captured frames.
    reason = actionableNetworkPressure ? 'network-bitrate-only' : 'network-observation';
  }

  level = Math.max(0, Math.min(profile.adaptationScales.length - 1, level));
  if (downscaleTriggerReason && level > levelBeforeDecision) {
    encoderTrial = {
      triggerReason: downscaleTriggerReason,
      fromLevel: levelBeforeDecision,
      toLevel: level,
      samplesObserved: 0,
      baselineDeliveryRatio: hasPipelineFps ? encoderDeliveryRatio : null,
      baselineEncodeTimeMs: measuredEncodeSample,
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
  return {
    profileId: profile.id,
    level,
    poorSamples,
    stableSamples,
    sourceSamples,
    networkSamples,
    sampleCount,
    cooldownSamples,
    scale,
    reason,
    targetFps: profile.frameRate,
    measuredFps,
    captureFps: captureFps ?? 0,
    encodedFps: encodedFps ?? 0,
    encoderDeliveryRatio,
    bottleneck,
    sourceLimited,
    networkPressure,
    networkSustained: actionableNetworkPressure,
    networkHeadroomRatio,
    encoderTrial,
    downscaleEffectiveness,
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

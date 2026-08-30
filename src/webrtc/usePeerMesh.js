import { useCallback, useEffect, useRef } from 'react';
import {
  SCREEN_SHARE_ADAPT_INTERVAL_MS,
  SCREEN_SHARE_BITRATE_INCREASE_INTERVAL_MS,
  adaptVideoSender,
  configureVideoSender,
  evaluatePlaybackBufferAdaptation,
  evaluateCaptureAdaptation,
  initialPlaybackBufferAdaptation,
  initialCaptureAdaptation,
  isSoftwareH264Encoder,
  preferVideoCodecs,
  screenShareProfile,
  screenSharePlaybackBuffer,
} from '../media/screenShareProfiles.js';
import {
  createScreenShareAudioTelemetrySnapshot,
  createScreenShareTelemetrySnapshot,
} from '../media/screenShareTelemetry.js';
import {
  createScreenShareDiagnosticsSession,
  createScreenShareAudioSample,
  createScreenShareReceiverSample,
  createScreenShareSenderSample,
  flushScreenShareDiagnosticsSession,
  isScreenShareDiagnosticsEnabled,
} from '../media/screenShareDiagnostics.js';

const ICE_RESTART_DELAY_MS = 4_000;
const ICE_RESTART_RETRY_MS = 10_000;
const MAX_ICE_RESTARTS = 3;

export const PEER_CONNECTION_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};

function enqueuePeerTask(slot, task, onError) {
  const run = () => task();
  slot.signalChain = slot.signalChain.then(run, run).catch((error) => {
    onError(error);
    return false;
  });
  return slot.signalChain;
}

function enqueueSenderMutation(slot, senderKey, task) {
  slot.senderMutationChains ||= {};
  const run = () => task(slot?.[senderKey] || null);
  const previous = slot.senderMutationChains[senderKey] || Promise.resolve();
  const result = previous.then(run, run);
  // Keep the queue usable after one rejected mutation while returning the
  // original result to the caller so its normal error path still runs.
  slot.senderMutationChains[senderKey] = result.catch(() => false);
  return result;
}

function senderParameterSnapshot(sender) {
  if (!sender?.getParameters) return null;
  const parameters = sender.getParameters();
  return {
    trackId: sender.track?.id || null,
    degradationPreference: parameters.degradationPreference || null,
    encodings: (parameters.encodings || []).map((encoding) => ({
      active: encoding.active ?? null,
      maxBitrate: Number(encoding.maxBitrate) || null,
      maxFramerate: Number(encoding.maxFramerate) || null,
      scaleResolutionDownBy: Number(encoding.scaleResolutionDownBy) || null,
      scalabilityMode: encoding.scalabilityMode || null,
    })),
  };
}

function primaryEncoding(snapshot) {
  return snapshot?.encodings?.[0] || {};
}

function safeAudioTrackSettings(track) {
  try {
    return track?.getSettings?.() || null;
  } catch {
    return null;
  }
}

function createAudioTelemetryPath(reports, previous, track, direction, timestampMs, runId, previousRunId) {
  if (!track) return null;
  return createScreenShareAudioTelemetrySnapshot(reports, previous, {
    direction,
    trackIdentifier: track.id || null,
    trackSettings: safeAudioTrackSettings(track),
    timestampMs,
    runId,
    previousRunId,
  });
}

function createAudioTelemetrySet(reports, slot, previous, direction, timestampMs, runId) {
  const outbound = direction === 'outbound';
  const previousRunId = outbound ? slot.audioSenderTelemetryRunId : slot.audioReceiverTelemetryRunId;
  return {
    microphoneOutbound: outbound
      ? createAudioTelemetryPath(reports, previous?.microphoneOutbound, slot.audioSender?.track, 'outbound', timestampMs, runId, previousRunId)
      : null,
    microphoneInbound: outbound
      ? null
      : createAudioTelemetryPath(reports, previous?.microphoneInbound, slot.audioTransceiver?.receiver?.track, 'inbound', timestampMs, runId, previousRunId),
    screenAudioOutbound: outbound
      ? createAudioTelemetryPath(reports, previous?.screenAudioOutbound, slot.screenAudioSender?.track, 'outbound', timestampMs, runId, previousRunId)
      : null,
    screenAudioInbound: outbound
      ? null
      : createAudioTelemetryPath(reports, previous?.screenAudioInbound, slot.screenAudioTransceiver?.receiver?.track, 'inbound', timestampMs, runId, previousRunId),
  };
}

function createAudioSamples(telemetrySet) {
  if (!telemetrySet) return null;
  return Object.fromEntries(Object.entries(telemetrySet).map(([path, telemetry]) => [
    path,
    createScreenShareAudioSample({ telemetry }),
  ]));
}

function ensureDiagnosticsSession(slot, key, options) {
  if (!isScreenShareDiagnosticsEnabled() || !options?.run?.runId) return null;
  const current = slot[key];
  if (current?.runId === options.run.runId) return current;
  if (current) void flushScreenShareDiagnosticsSession(current, 'run-replaced');
  const session = createScreenShareDiagnosticsSession({
    enabled: true,
    runId: options.run.runId,
    role: options.role,
    participantId: options.participantId,
    peerId: options.peerId,
    sourcePeerId: options.sourcePeerId,
    transportMode: options.transportMode,
    environment: options.environment || {},
    startedAtMs: options.run.startedAtMs,
    performanceTimeOriginMs: options.run.performanceTimeOriginMs,
    monotonicStartMs: options.run.monotonicStartMs,
    capture: options.run.capture,
    correlation: options.correlation,
  });
  slot[key] = session;
  return session;
}

function flushDiagnosticsOnSlot(slot, reason) {
  if (!slot) return;
  ['senderDiagnosticsSession', 'receiverDiagnosticsSession'].forEach((key) => {
    const session = slot[key];
    if (!session) return;
    void flushScreenShareDiagnosticsSession(session, reason);
    slot[key] = null;
  });
  if (slot.remoteBundle) slot.remoteBundle.screenShareDiagnosticsSession = null;
}

function encodingValueChanged(before, after, key) {
  return primaryEncoding(before)[key] !== primaryEncoding(after)[key];
}

function recordVideoSenderMutation(slot, type, before, after, details = {}) {
  if (!slot || !after) return null;
  const trackChanged = before?.trackId !== after.trackId;
  const structural = trackChanged
    || encodingValueChanged(before, after, 'maxFramerate')
    || encodingValueChanged(before, after, 'scaleResolutionDownBy')
    || before?.degradationPreference !== after.degradationPreference;
  const bitrate = encodingValueChanged(before, after, 'maxBitrate');
  const active = encodingValueChanged(before, after, 'active');
  if (!structural && !bitrate && !active && type === 'adapt') return null;

  slot.videoMutationCounts ||= { total: 0, structural: 0, bitrate: 0, active: 0, track: 0 };
  slot.videoMutationCounts.total += 1;
  if (structural) slot.videoMutationCounts.structural += 1;
  if (bitrate) slot.videoMutationCounts.bitrate += 1;
  if (active) slot.videoMutationCounts.active += 1;
  if (trackChanged) slot.videoMutationCounts.track += 1;
  const event = {
    sequence: slot.videoMutationCounts.total,
    type,
    timestampMs: Date.now(),
    peerId: slot.peerId || '',
    structural,
    bitrate,
    active,
    trackChanged,
    before,
    after,
    countersBeforeNextSample: {
      keyFramesEncoded: slot.videoTelemetry?.outbound?.keyFramesEncoded ?? null,
      hugeFramesSent: slot.videoTelemetry?.outbound?.hugeFramesSent ?? null,
      nackCount: slot.videoTelemetry?.outbound?.nackCount ?? null,
      pliCount: slot.videoTelemetry?.outbound?.pliCount ?? null,
      firCount: slot.videoTelemetry?.outbound?.firCount ?? null,
      bytesSent: slot.videoTelemetry?.outbound?.bytesSent ?? null,
    },
    ...details,
  };
  slot.lastVideoMutation = event;
  const beforeBitrate = Number(primaryEncoding(before).maxBitrate) || 0;
  const afterBitrate = Number(primaryEncoding(after).maxBitrate) || 0;
  if (bitrate && afterBitrate > beforeBitrate) {
    slot.lastVideoBitrateIncreaseAtMs = event.timestampMs;
  }
  slot.videoMutationHistory ||= [];
  slot.videoMutationHistory.push(event);
  if (slot.videoMutationHistory.length > 64) slot.videoMutationHistory.shift();
  if (globalThis.__jumpStreamTelemetry) {
    const events = globalThis.__jumpStreamTelemetry.events ||= [];
    events.push({ type: 'sender-mutation', ...event });
    if (events.length > 1_000) events.shift();
  }
  return event;
}

async function mutateVideoSender(slot, type, sender, operation, details = {}) {
  const before = senderParameterSnapshot(sender);
  const result = await operation(sender);
  const after = senderParameterSnapshot(sender);
  recordVideoSenderMutation(slot, type, before, after, details);
  return result;
}

function addIncomingTrack(stream, event) {
  const tracks = [...(event.streams?.[0]?.getTracks?.() || []), event.track];
  tracks.forEach((track) => {
    if (track && !stream.getTracks().includes(track)) stream.addTrack(track);
  });
}

function remoteTrackRole(pc, transceiver, track) {
  if (track?.kind === 'video') return 'video';
  const audioTransceivers = pc.getTransceivers().filter((entry) => entry.receiver.track?.kind === 'audio');
  return audioTransceivers.indexOf(transceiver) > 0 ? 'screenAudio' : 'microphone';
}

function streamForTrack(track) {
  return track ? new MediaStream([track]) : null;
}

function publishRemoteTrack(slot, peerId, event, remoteStreamsRef, setRemoteStreams, mountedRef) {
  const incoming = remoteStreamsRef.current.get(peerId) || new MediaStream();
  addIncomingTrack(incoming, event);
  remoteStreamsRef.current.set(peerId, incoming);
  slot.remoteBundle ||= {
    stream: incoming,
    videoStream: null,
    microphoneStream: null,
    screenAudioStream: null,
    screenShareDiagnosticsSession: null,
  };
  slot.remoteBundle.stream = incoming;
  const role = remoteTrackRole(slot.pc, event.transceiver, event.track);
  const roleStream = streamForTrack(event.track);
  if (role === 'video') slot.p2pVideoStream = roleStream;
  slot.remoteBundle[`${role}Stream`] = roleStream;
  if (mountedRef.current) setRemoteStreams((current) => ({ ...current, [peerId]: { ...slot.remoteBundle } }));
}

async function setSenderActive(sender, active) {
  if (!sender?.getParameters || !sender?.setParameters) return false;
  const parameters = sender.getParameters();
  parameters.encodings ??= [{}];
  parameters.encodings.forEach((encoding) => { encoding.active = Boolean(active); });
  try {
    await sender.setParameters(parameters);
    return true;
  } catch {
    return false;
  }
}

function setReceiverPlaybackBuffer(receiver, targetMs) {
  if (!receiver || !('jitterBufferTarget' in receiver)) return false;
  try {
    const nextTarget = Math.max(0, Number(targetMs) || 0);
    if (Math.abs((Number(receiver.jitterBufferTarget) || 0) - nextTarget) < 1) return true;
    receiver.jitterBufferTarget = nextTarget;
    return true;
  } catch {
    return false;
  }
}

function applySlotPlaybackProfile(slot, profileId) {
  if (!slot) return false;
  const nextProfile = screenShareProfile(profileId).id;
  if (slot.remotePlaybackProfile !== nextProfile) {
    slot.playbackAdaptation = initialPlaybackBufferAdaptation(nextProfile);
  }
  slot.remotePlaybackProfile = nextProfile;
  const targetMs = slot.playbackAdaptation?.targetMs
    ?? screenSharePlaybackBuffer(slot.remotePlaybackProfile);
  const videoApplied = setReceiverPlaybackBuffer(slot.videoTransceiver?.receiver, targetMs);
  const audioApplied = setReceiverPlaybackBuffer(slot.screenAudioTransceiver?.receiver, targetMs);
  return videoApplied || audioApplied;
}

function remoteDescriptionHasTrack(pc, transceiver) {
  const mid = String(transceiver?.mid ?? '');
  if (!mid) return false;
  const sections = String(pc.remoteDescription?.sdp || '').split(/\r?\nm=/);
  return sections.some((section) => section.includes(`a=mid:${mid}`) && /(?:^|\r?\n)a=msid:/m.test(section));
}

function codecCapabilitiesForRemotePolicy(policyKey, localCapabilities = {}) {
  const key = String(policyKey || '').toLowerCase();
  if (!key.startsWith('software-only:') && !key.startsWith('runtime-software:')) {
    return localCapabilities;
  }
  const requested = key.split(':').at(-1);
  return {
    ...localCapabilities,
    hardwareVideoEncoding: false,
    videoEncode: 'disabled_software',
    preferredSoftwareCodec: ['h264', 'vp8', 'vp9'].includes(requested)
      ? requested.toUpperCase() : 'VP8',
  };
}

/**
 * Owns the WebRTC mesh lifecycle. Chat/DataChannel protocol handling stays in
 * App, while SDP ordering, ICE recovery and media senders live here.
 */
export function usePeerMesh({
  peerConnectionsRef,
  pendingCandidatesRef,
  localPeerIdRef,
  audioStreamRef,
  cameraStreamRef,
  screenStreamRef,
  screenAudioSessionRef,
  screenShareRunRef,
  screenDiagnosticsConfigRef,
  videoProfileRef,
  remoteStreamsRef,
  sendSignal,
  attachDataChannel,
  clearRemoteCallMedia,
  setRemoteStreams,
  onPeerError,
}) {
  const mountedRef = useRef(true);
  const mediaCapabilitiesRef = useRef(null);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const getMediaCapabilities = globalThis.jumpDesktop?.getMediaCapabilities;
    if (typeof getMediaCapabilities !== 'function') return undefined;
    void getMediaCapabilities().then((capabilities) => {
      if (!cancelled) mediaCapabilitiesRef.current = capabilities || null;
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('meshDebug')) return undefined;
    globalThis.__jumpPeerMesh = { peerConnectionsRef, remoteStreamsRef };
    return () => { delete globalThis.__jumpPeerMesh; };
  }, [peerConnectionsRef, remoteStreamsRef]);

  useEffect(() => {
    let running = false;
    const telemetryEnabled = new URLSearchParams(window.location.search).has('streamTelemetry');
    const tuneVideo = async () => {
      if (running) return;
      running = true;
      try {
        const screenTrack = screenStreamRef.current?.getVideoTracks?.()[0] || null;
        const slots = [...peerConnectionsRef.current.values()].filter((slot) => (
          screenTrack && slot?.videoSender?.track === screenTrack && slot.pc.connectionState !== 'closed'
          && slot.screenWatching !== false && slot.screenViaSfu !== true
        ));
        if (!slots.length) return;
        const activePeerCount = slots.length;
        const trackSettings = screenTrack.getSettings?.() || {};
        const diagnosticsEnabled = isScreenShareDiagnosticsEnabled();
        const senderRunId = screenShareRunRef.current?.runId || null;
        const samples = (await Promise.all(slots.map(async (slot) => {
          try {
            const reports = await slot.pc.getStats(diagnosticsEnabled ? undefined : screenTrack);
            const timestampMs = performance.timeOrigin + performance.now();
            const telemetry = createScreenShareTelemetrySnapshot(reports, slot.videoTelemetry || null, {
              trackIdentifier: screenTrack.id,
              timestampMs,
              runId: senderRunId,
              previousRunId: slot.videoTelemetryRunId,
            });
            const audioTelemetry = diagnosticsEnabled
              ? createAudioTelemetrySet(
                reports,
                slot,
                slot.audioSenderTelemetry || null,
                'outbound',
                timestampMs,
                senderRunId,
              )
              : null;
            const diagnostics = {
              availableOutgoingBitrate: telemetry.network.availableOutgoingBitrate ?? 0,
              configuredMaxBitrate: Number(slot.videoSender.getParameters?.().encodings?.[0]?.maxBitrate) || 0,
              framesPerSecond: telemetry.derived.encodeFps,
              captureFps: telemetry.derived.captureFps,
              sourceWidth: telemetry.source.width,
              sourceHeight: telemetry.source.height,
              trackWidth: trackSettings.width ?? null,
              trackHeight: trackSettings.height ?? null,
              frameWidth: telemetry.outbound.frameWidth,
              frameHeight: telemetry.outbound.frameHeight,
              // Preserve null: unavailable encode timing is not a free/zero-cost
              // encode and must not make an adaptation trial look successful.
              averageEncodeTimeMs: telemetry.derived.averageEncodeTimeMs,
              qualityLimitationReason: telemetry.outbound.qualityLimitationReason || 'none',
              codec: telemetry.codec,
              sendBitrateBps: telemetry.derived.sendBitrateBps,
              remotePacketsLost: telemetry.remoteInbound.packetsLost,
              packetLossRatio: telemetry.derived.packetLossRatio,
              retransmissionRatio: telemetry.derived.retransmissionRatio,
              averagePacketSendDelayMs: telemetry.derived.averagePacketSendDelayMs,
              packetsDiscardedOnSend: telemetry.derived.packetsDiscardedOnSend,
              roundTripTimeMs: telemetry.derived.currentRoundTripTimeMs,
              peerCount: activePeerCount,
              encoderImplementation: telemetry.outbound.encoderImplementation,
              powerEfficientEncoder: telemetry.outbound.powerEfficientEncoder,
            };
            const hasFpsSample = diagnostics.captureFps !== null
              || diagnostics.framesPerSecond !== null;
            const softwareH264 = isSoftwareH264Encoder({
              codec: telemetry.codec,
              encoderImplementation: telemetry.outbound.encoderImplementation,
              powerEfficientEncoder: telemetry.outbound.powerEfficientEncoder,
            });
            return { slot, diagnostics, hasFpsSample, telemetry, softwareH264, audioTelemetry };
          } catch {
            // Never replay a stale measurement: one failed getStats call must
            // not advance startup guards or count three times inside a trial.
            return null;
          }
        }))).filter(Boolean);
        // Each RTCPeerConnection has its own encoder, congestion controller and
        // uplink estimate. A single weak viewer must not reduce quality for every
        // other viewer, so adaptation state and sender scale stay per peer.
        await Promise.all(samples.map(({ slot, diagnostics, hasFpsSample, telemetry, softwareH264, audioTelemetry }) => (
          enqueueSenderMutation(slot, 'videoSender', async (sender) => {
            const liveTrack = screenStreamRef.current?.getVideoTracks?.()[0] || null;
            if (!sender || liveTrack !== screenTrack || sender.track !== screenTrack
                || slot.screenWatching === false || slot.pc.connectionState === 'closed') return false;

            if (audioTelemetry) {
              slot.audioSenderTelemetry = audioTelemetry;
              slot.audioSenderTelemetryRunId = senderRunId;
            }

            if (softwareH264 && !String(slot.videoCodecPolicyKey).startsWith('runtime-software:')) {
              preferVideoCodecs(slot.videoTransceiver, videoProfileRef.current, {
                hardwareVideoEncoding: false,
                videoEncode: 'disabled_software',
                preferredSoftwareCodec: 'VP8',
              });
              slot.videoCodecPolicyKey = `runtime-software:${videoProfileRef.current}:vp8`;
              slot.videoTelemetry = null;
              slot.videoTelemetryRunId = senderRunId;
              slot.videoDiagnostics = null;
              slot.videoAdaptation = {
                ...initialCaptureAdaptation(videoProfileRef.current),
                trackId: screenTrack.id,
              };
              slot.requestNegotiation?.();
              return true;
            }

            slot.videoTelemetry = telemetry;
            slot.videoTelemetryRunId = senderRunId;
            slot.videoDiagnostics = diagnostics;
            if (telemetryEnabled) {
              slot.videoTelemetryHistory ||= [];
              slot.videoTelemetryHistory.push(telemetry);
              if (slot.videoTelemetryHistory.length > 240) slot.videoTelemetryHistory.shift();
            }
            const current = slot.videoAdaptation?.trackId === screenTrack.id
              && slot.videoAdaptation?.profileId === videoProfileRef.current
              ? slot.videoAdaptation
              : { ...initialCaptureAdaptation(videoProfileRef.current), trackId: screenTrack.id };
            // Transport-only samples can still tune bitrate, but only an actual
            // FPS observation advances the spatial controller and its trials.
            const nextAdaptation = hasFpsSample
              ? evaluateCaptureAdaptation(current, videoProfileRef.current, diagnostics)
              : current;
            nextAdaptation.trackId = screenTrack.id;
            slot.videoAdaptation = nextAdaptation;
            if (telemetryEnabled) {
              globalThis.__jumpStreamTelemetry ||= { version: 1, capture: null, events: [], render: {} };
              const events = globalThis.__jumpStreamTelemetry.events ||= [];
              events.push({
                type: 'adaptation-sample',
                timestampMs: Date.now(),
                peerId: slot.peerId || '',
                profileId: videoProfileRef.current,
                adaptation: { ...nextAdaptation },
                diagnostics: { ...diagnostics },
                fpsSample: hasFpsSample,
              });
              if (events.length > 1_000) events.shift();
            }
            const adaptationResult = await mutateVideoSender(slot, 'adapt', sender, () => adaptVideoSender(
              sender,
              videoProfileRef.current,
              activePeerCount,
              {
                ...diagnostics,
                allowBitrateIncrease: !slot.lastVideoBitrateIncreaseAtMs
                  || Date.now() - slot.lastVideoBitrateIncreaseAtMs
                    >= SCREEN_SHARE_BITRATE_INCREASE_INTERVAL_MS,
                adaptationScale: nextAdaptation.scale,
                targetFrameRate: nextAdaptation.frameRate,
                networkPressure: nextAdaptation.networkPressure,
                transportPressure: nextAdaptation.transportPressure,
                startupBitrateGuardActive: nextAdaptation.startupBitrateGuardActive,
                recoveryProbeActive: nextAdaptation.recoveryProbeActive,
                recoveryProbeMaxBitrate: nextAdaptation.recoveryProbeMaxBitrate,
              },
            ), {
              profileId: videoProfileRef.current,
              adaptationReason: nextAdaptation.reason,
              adaptationLevel: nextAdaptation.level,
              temporalLevel: nextAdaptation.temporalLevel,
              recoveryProbeActive: nextAdaptation.recoveryProbeActive,
              recoveryProbeSamples: nextAdaptation.recoveryProbeSamples,
              recoveryProbeCooldownSamples: nextAdaptation.recoveryProbeCooldownSamples,
              recoveryProbeMaxBitrate: nextAdaptation.recoveryProbeMaxBitrate,
              recoveryProbeReason: nextAdaptation.recoveryProbeReason,
            });
            const diagnosticsSession = ensureDiagnosticsSession(slot, 'senderDiagnosticsSession', {
              run: screenShareRunRef.current,
              role: 'sender',
              participantId: localPeerIdRef.current,
              peerId: slot.peerId,
              transportMode: 'mesh',
              environment: screenDiagnosticsConfigRef.current?.environment,
            });
            if (diagnosticsSession) {
              const senderSnapshot = senderParameterSnapshot(sender);
              diagnosticsSession.updateMetadata({
                capture: {
                  ...(screenShareRunRef.current?.capture || {}),
                  trackSettings,
                },
                transport: telemetry.network,
              });
              diagnosticsSession.recordSample(createScreenShareSenderSample({
                telemetry,
                adaptation: nextAdaptation,
                senderParameters: senderSnapshot,
                peerId: slot.peerId,
                trackSettings,
                peerCount: activePeerCount,
                audio: createAudioSamples(audioTelemetry),
              }));
            }
            return adaptationResult;
          })
        )));
      } finally {
        running = false;
      }
    };
    const timer = window.setInterval(() => { void tuneVideo(); }, SCREEN_SHARE_ADAPT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [localPeerIdRef, peerConnectionsRef, screenDiagnosticsConfigRef, screenShareRunRef, screenStreamRef, videoProfileRef]);

  useEffect(() => {
    const telemetryEnabled = new URLSearchParams(window.location.search).has('streamTelemetry');
    let running = false;
    const sampleReceivers = async () => {
      if (running) return;
      running = true;
      await Promise.all([...peerConnectionsRef.current.values()].map(async (slot) => {
        if (!slot?.pc || slot.pc.connectionState === 'closed') return;
        try {
          const receiverRunId = slot.remoteMediaState?.sharing
            ? slot.remoteMediaState.screenShareRunId || null
            : null;
          const reports = await slot.pc.getStats();
          const telemetry = createScreenShareTelemetrySnapshot(reports, slot.inboundVideoTelemetry || null, {
            timestampMs: performance.timeOrigin + performance.now(),
            runId: receiverRunId,
            previousRunId: slot.inboundVideoTelemetryRunId,
          });
          if (!telemetry.ids.inbound) return;
          slot.inboundVideoTelemetry = telemetry;
          slot.inboundVideoTelemetryRunId = receiverRunId;
          const audioTelemetry = isScreenShareDiagnosticsEnabled()
            ? createAudioTelemetrySet(
              reports,
              slot,
              slot.audioReceiverTelemetry || null,
              'inbound',
              telemetry.timestampMs,
              receiverRunId,
            )
            : null;
          if (audioTelemetry) {
            slot.audioReceiverTelemetry = audioTelemetry;
            slot.audioReceiverTelemetryRunId = receiverRunId;
          }
          const playbackProfile = slot.remotePlaybackProfile || 'performance';
          slot.playbackAdaptation = evaluatePlaybackBufferAdaptation(
            slot.playbackAdaptation,
            playbackProfile,
            {
              jitterMs: telemetry.derived.inboundJitterMs,
              freezeCount: telemetry.inbound.freezeCount,
              framesDropped: telemetry.inbound.framesDropped,
            },
          );
          setReceiverPlaybackBuffer(
            slot.videoTransceiver?.receiver,
            slot.playbackAdaptation.targetMs,
          );
          setReceiverPlaybackBuffer(
            slot.screenAudioTransceiver?.receiver,
            slot.playbackAdaptation.targetMs,
          );
          if (slot.remoteMediaState?.sharing && slot.remoteMediaState.screenShareRunId) {
            const receiverStartedAtMs = Date.now();
            const receiverMonotonicStartMs = performance.now();
            const senderAnnouncedStartedAtMs = slot.remoteMediaState.screenShareRunStartedAtMs || null;
            const diagnosticsSession = ensureDiagnosticsSession(slot, 'receiverDiagnosticsSession', {
              run: {
                runId: slot.remoteMediaState.screenShareRunId,
                startedAtMs: receiverStartedAtMs,
                performanceTimeOriginMs: performance.timeOrigin,
                monotonicStartMs: receiverMonotonicStartMs,
                capture: null,
              },
              correlation: { senderAnnouncedStartedAtMs },
              role: 'receiver',
              participantId: localPeerIdRef.current,
              peerId: localPeerIdRef.current,
              sourcePeerId: slot.peerId,
              transportMode: 'mesh',
              environment: screenDiagnosticsConfigRef.current?.environment,
            });
            if (diagnosticsSession) {
              if (slot.remoteBundle) {
                slot.remoteBundle.screenShareDiagnosticsSession = diagnosticsSession;
                setRemoteStreams((current) => ({
                  ...current,
                  [slot.peerId]: { ...slot.remoteBundle },
                }));
              }
              const receiver = slot.videoTransceiver?.receiver;
              diagnosticsSession.updateMetadata({ transport: telemetry.network });
              diagnosticsSession.recordSample(createScreenShareReceiverSample({
                telemetry,
                peerId: localPeerIdRef.current,
                sourcePeerId: slot.peerId,
                adaptation: slot.playbackAdaptation,
                receiver: {
                  configuredTargetMs: Number(receiver?.jitterBufferTarget) || null,
                  playbackTargetMs: slot.playbackAdaptation?.targetMs ?? null,
                },
                audio: createAudioSamples(audioTelemetry),
              }));
            }
          }
          if (telemetryEnabled) {
            slot.inboundVideoTelemetryHistory ||= [];
            slot.inboundVideoTelemetryHistory.push(telemetry);
            if (slot.inboundVideoTelemetryHistory.length > 240) slot.inboundVideoTelemetryHistory.shift();
          }
        } catch {
          // Telemetry is diagnostic-only and must never disturb the call.
        }
      }));
      running = false;
    };
    const timer = window.setInterval(() => { void sampleReceivers(); }, SCREEN_SHARE_ADAPT_INTERVAL_MS);
    void sampleReceivers();
    return () => window.clearInterval(timer);
  }, [localPeerIdRef, peerConnectionsRef, screenDiagnosticsConfigRef, setRemoteStreams]);

  const closePeer = useCallback((peerId) => {
    const slot = peerConnectionsRef.current.get(peerId);
    flushDiagnosticsOnSlot(slot, 'peer-closed');
    if (slot?.recoveryTimer) window.clearTimeout(slot.recoveryTimer);
    if (slot?.offerTimer) window.clearTimeout(slot.offerTimer);
    peerConnectionsRef.current.delete(peerId);
    pendingCandidatesRef.current.delete(peerId);
    slot?.pc.close();
    clearRemoteCallMedia(peerId);
  }, [clearRemoteCallMedia, peerConnectionsRef, pendingCandidatesRef]);

  const makeOffer = useCallback((peerId, { iceRestart = false } = {}) => {
    const slot = peerConnectionsRef.current.get(peerId);
    if (!slot || slot.pc.signalingState === 'closed') return Promise.resolve(false);
    slot.needsNegotiation = true;
    slot.needsIceRestart ||= iceRestart;

    return enqueuePeerTask(slot, async () => {
      if (slot.pc.signalingState !== 'stable') return false;
      await slot.mediaReady;
      slot.makingOffer = true;
      try {
        const restart = slot.needsIceRestart;
        slot.needsNegotiation = false;
        slot.needsIceRestart = false;
        const offer = await slot.pc.createOffer(restart ? { iceRestart: true } : undefined);
        await slot.pc.setLocalDescription(offer);
        sendSignal({
          type: 'signal',
          target: peerId,
          data: {
            type: 'offer',
            sdp: slot.pc.localDescription,
            codecPolicy: slot.videoCodecPolicyKey || 'hardware-or-unknown',
          },
        });
        return true;
      } finally {
        slot.makingOffer = false;
      }
    }, () => {
      slot.needsNegotiation = true;
      onPeerError?.('Não foi possível iniciar esta conexão P2P.');
    });
  }, [onPeerError, peerConnectionsRef, sendSignal]);

  const requestPeerNegotiation = useCallback((peerId, options = {}) => {
    const slot = peerConnectionsRef.current.get(peerId);
    if (!slot || slot.pc.signalingState === 'closed') return;
    slot.needsNegotiation = true;
    slot.needsIceRestart ||= Boolean(options.iceRestart);
    if (slot.offerTimer) return;
    slot.offerTimer = window.setTimeout(() => {
      slot.offerTimer = 0;
      void makeOffer(peerId, { iceRestart: slot.needsIceRestart });
    }, 0);
  }, [makeOffer, peerConnectionsRef]);

  const replacePeerTrack = useCallback(async (senderKey, track, streamOverride = null) => {
    const failed = [];
    await Promise.all([...peerConnectionsRef.current.entries()].map(async ([peerId, slot]) => {
      if (!slot?.[senderKey] || ['closed', 'failed'].includes(slot.pc.connectionState)) return;
      try {
        await enqueueSenderMutation(slot, senderKey, async (sender) => {
          if (!sender || ['closed', 'failed'].includes(slot.pc.connectionState)) return false;
          const previousTrack = sender.track;
          const outboundStream = track ? (streamOverride || new MediaStream([track])) : null;
          const transceiver = senderKey === 'audioSender'
            ? slot.audioTransceiver
            : senderKey === 'screenAudioSender'
              ? slot.screenAudioTransceiver
              : slot.videoTransceiver;
          if (track && transceiver) transceiver.direction = 'sendrecv';
          sender.setStreams?.(...(outboundStream ? [outboundStream] : []));
          slot[`${senderKey}Stream`] = outboundStream;
          const replaceAndConfigure = async () => {
            await sender.replaceTrack(track || null);
            if (senderKey === 'videoSender' && track) {
              await configureVideoSender(sender, videoProfileRef.current, peerConnectionsRef.current.size);
              const isScreenTrack = track === screenStreamRef.current?.getVideoTracks?.()[0];
              await setSenderActive(sender, isScreenTrack ? slot.screenWatching !== false : true);
            }
            return true;
          };
          if (senderKey === 'videoSender') {
            await mutateVideoSender(slot, 'replace-track', sender, replaceAndConfigure, {
              previousTrackId: previousTrack?.id || null,
              nextTrackId: track?.id || null,
              profileId: videoProfileRef.current,
            });
          } else {
            await replaceAndConfigure();
          }
          if (senderKey === 'screenAudioSender' && track) {
            await setSenderActive(sender, slot.screenWatching !== false);
          }
          // Chromium does not consistently emit the first remote `track` event
          // when a transceiver was negotiated without an msid. Only the sender
          // that attaches the first real track renegotiates; the receiver never
          // mirrors this from call-state, avoiding the old offer storm.
          const codecPolicyChanged = senderKey === 'videoSender'
            && slot.videoCodecRenegotiationPending;
          if (codecPolicyChanged) slot.videoCodecRenegotiationPending = false;
          if ((!previousTrack && track) || codecPolicyChanged) requestPeerNegotiation(peerId);
          return true;
        });
      } catch {
        failed.push(peerId);
      }
    }));
    if (failed.length) onPeerError?.('A mídia não pôde ser anexada a um dos participantes. Tente entrar na chamada novamente.');
    return failed.length === 0;
  }, [onPeerError, peerConnectionsRef, requestPeerNegotiation, screenStreamRef, videoProfileRef]);

  const setVideoEncodingProfile = useCallback(async (profileId, mediaCapabilities = {}) => {
    const normalizedProfileId = screenShareProfile(profileId).id;
    if (mediaCapabilities && Object.keys(mediaCapabilities).length) {
      mediaCapabilitiesRef.current = mediaCapabilities;
    }
    const effectiveCapabilities = mediaCapabilities && Object.keys(mediaCapabilities).length
      ? mediaCapabilities
      : mediaCapabilitiesRef.current || {};
    videoProfileRef.current = normalizedProfileId;
    const slots = [...peerConnectionsRef.current.values()].filter((slot) => slot?.videoSender);
    await Promise.all(slots.map((slot) => enqueueSenderMutation(slot, 'videoSender', async (sender) => {
      if (!sender || slot.pc.connectionState === 'closed') return false;
      const nextCodecPolicyKey = effectiveCapabilities.hardwareVideoEncoding === false
        || String(effectiveCapabilities.videoEncode || '').toLowerCase() === 'disabled_software'
        ? `software-only:${normalizedProfileId}:${String(effectiveCapabilities.preferredSoftwareCodec || 'auto').toLowerCase()}`
        : 'hardware-or-unknown';
      if (slot.videoCodecPolicyKey !== nextCodecPolicyKey) {
        preferVideoCodecs(slot.videoTransceiver, normalizedProfileId, effectiveCapabilities);
        slot.videoCodecPolicyKey = nextCodecPolicyKey;
        slot.videoCodecRenegotiationPending = true;
      }
      slot.videoAdaptation = initialCaptureAdaptation(normalizedProfileId);
      slot.videoTelemetry = null;
      slot.videoDiagnostics = null;
      if (!sender.track) return true;
      return mutateVideoSender(slot, 'profile', sender, () => (
        configureVideoSender(sender, normalizedProfileId, slots.length)
      ), { profileId: normalizedProfileId });
    })));
  }, [peerConnectionsRef, videoProfileRef]);

  const setPeerPlaybackProfile = useCallback((peerId, profileId) => {
    const slot = peerConnectionsRef.current.get(peerId);
    if (!slot || slot.pc.connectionState === 'closed') return false;
    return applySlotPlaybackProfile(slot, profileId);
  }, [peerConnectionsRef]);

  const setPeerScreenDelivery = useCallback(async (peerId, watching) => {
    const slot = peerConnectionsRef.current.get(peerId);
    if (!slot || slot.pc.connectionState === 'closed') return false;
    const nextWatching = Boolean(watching);
    if (slot.screenWatching !== nextWatching) {
      // Counters do not advance while the encoding is inactive. Reusing the
      // pre-pause snapshot would divide the next delta by the whole paused
      // interval and manufacture a low FPS sample on resume.
      slot.videoTelemetry = null;
      slot.videoDiagnostics = null;
      const activeTrack = screenStreamRef.current?.getVideoTracks?.()[0] || null;
      slot.videoAdaptation = activeTrack
        ? { ...initialCaptureAdaptation(videoProfileRef.current), trackId: activeTrack.id }
        : initialCaptureAdaptation(videoProfileRef.current);
    }
    slot.screenWatching = nextWatching;
    const activeScreenTrack = screenStreamRef.current?.getVideoTracks?.()[0];
    const tasks = [];
    if (activeScreenTrack && slot.videoSender?.track === activeScreenTrack) {
      tasks.push(enqueueSenderMutation(slot, 'videoSender', async (sender) => {
        if (sender?.track !== activeScreenTrack) return false;
        if (nextWatching) {
          const activePeerCount = [...peerConnectionsRef.current.values()].filter((candidate) => (
            candidate?.videoSender?.track === activeScreenTrack
            && candidate.screenWatching !== false && candidate.screenViaSfu !== true
            && candidate.pc.connectionState !== 'closed'
          )).length;
          await mutateVideoSender(slot, 'resume-configure', sender, () => (
            configureVideoSender(sender, videoProfileRef.current, activePeerCount)
          ), { profileId: videoProfileRef.current });
        }
        const active = nextWatching && slot.screenViaSfu !== true;
        return mutateVideoSender(slot, active ? 'resume' : 'pause', sender, () => (
          setSenderActive(sender, active)
        ), { watching: nextWatching, screenViaSfu: slot.screenViaSfu === true });
      }));
    }
    if (slot.screenAudioSender?.track) {
      tasks.push(enqueueSenderMutation(slot, 'screenAudioSender', (sender) => (
        sender?.track ? setSenderActive(sender, nextWatching) : false
      )));
    }
    await Promise.all(tasks);
    return true;
  }, [peerConnectionsRef, screenStreamRef, videoProfileRef]);

  const setPeerScreenTransport = useCallback(async (peerId, viaSfu) => {
    const slot = peerConnectionsRef.current.get(peerId);
    if (!slot || slot.pc.connectionState === 'closed') return false;
    slot.screenViaSfu = Boolean(viaSfu);
    const activeScreenTrack = screenStreamRef.current?.getVideoTracks?.()[0] || null;
    if (!activeScreenTrack || slot.videoSender?.track !== activeScreenTrack) return true;
    return enqueueSenderMutation(slot, 'videoSender', (sender) => (
      mutateVideoSender(
        slot,
        slot.screenViaSfu ? 'sfu-handoff' : 'mesh-fallback',
        sender,
        () => setSenderActive(
          sender,
          slot.screenViaSfu !== true && slot.screenWatching !== false,
        ),
        { screenViaSfu: slot.screenViaSfu },
      )
    ));
  }, [peerConnectionsRef, screenStreamRef]);

  const createPeerConnection = useCallback((peerId, initiator = false) => {
    const existing = peerConnectionsRef.current.get(peerId);
    if (existing && existing.pc.signalingState !== 'closed') return existing;

    const pc = new RTCPeerConnection(PEER_CONNECTION_CONFIG);
    // Only the offerer creates transceivers. The answerer lets the remote SDP
    // create them and binds its local tracks afterwards. Pre-creating them on
    // both sides can leave orphaned transceivers after a polite rollback.
    const audioTransceiver = initiator ? pc.addTransceiver('audio', { direction: 'sendrecv' }) : null;
    const videoTransceiver = initiator ? pc.addTransceiver('video', { direction: 'sendrecv' }) : null;
    // Desktop audio uses its own m-line. Receivers can now pause or change the
    // stream volume without muting the person's microphone.
    const screenAudioTransceiver = initiator ? pc.addTransceiver('audio', { direction: 'sendrecv' }) : null;
    if (videoTransceiver) preferVideoCodecs(
      videoTransceiver,
      videoProfileRef.current,
      mediaCapabilitiesRef.current || {},
    );
    const slot = {
      peerId,
      pc,
      audioTransceiver,
      videoTransceiver,
      screenAudioTransceiver,
      audioSender: audioTransceiver?.sender || null,
      videoSender: videoTransceiver?.sender || null,
      screenAudioSender: screenAudioTransceiver?.sender || null,
      dataChannel: null,
      makingOffer: false,
      needsNegotiation: false,
      needsIceRestart: false,
      isSettingRemoteAnswerPending: false,
      polite: String(localPeerIdRef.current).localeCompare(String(peerId)) > 0,
      ignoreOffer: false,
      signalChain: Promise.resolve(),
      recoveryTimer: 0,
      offerTimer: 0,
      iceRestartAttempts: 0,
      screenWatching: true,
      screenViaSfu: false,
      videoCodecPolicyKey: 'hardware-or-unknown',
      videoCodecRenegotiationPending: false,
      requestNegotiation: (options = {}) => requestPeerNegotiation(peerId, options),
      remotePlaybackProfile: '',
      mediaReady: Promise.resolve(),
    };
    peerConnectionsRef.current.set(peerId, slot);

    const clearRecoveryTimer = () => {
      if (slot.recoveryTimer) window.clearTimeout(slot.recoveryTimer);
      slot.recoveryTimer = 0;
    };
    const scheduleIceRecovery = (delay = ICE_RESTART_DELAY_MS) => {
      if (slot.recoveryTimer || slot.pc.signalingState === 'closed') return;
      slot.recoveryTimer = window.setTimeout(() => {
        slot.recoveryTimer = 0;
        if (!['disconnected', 'failed'].includes(pc.iceConnectionState)) return;
        if (slot.iceRestartAttempts >= MAX_ICE_RESTARTS) {
          closePeer(peerId);
          onPeerError?.('A conexão com um participante caiu após várias tentativas de recuperação.');
          return;
        }
        slot.iceRestartAttempts += 1;
        pc.restartIce?.();
        requestPeerNegotiation(peerId, { iceRestart: true });
        scheduleIceRecovery(ICE_RESTART_RETRY_MS);
      }, delay);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ type: 'signal', target: peerId, data: { type: 'candidate', candidate: event.candidate } });
    };
    pc.ontrack = (event) => {
      publishRemoteTrack(slot, peerId, event, remoteStreamsRef, setRemoteStreams, mountedRef);
    };
    pc.oniceconnectionstatechange = () => {
      if (['connected', 'completed'].includes(pc.iceConnectionState)) {
        clearRecoveryTimer();
        slot.iceRestartAttempts = 0;
      } else if (pc.iceConnectionState === 'disconnected') {
        scheduleIceRecovery();
      } else if (pc.iceConnectionState === 'failed') {
        clearRecoveryTimer();
        scheduleIceRecovery(0);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'closed' && peerConnectionsRef.current.get(peerId)?.pc === pc) closePeer(peerId);
    };
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === 'stable' && slot.needsNegotiation && !slot.offerTimer) requestPeerNegotiation(peerId);
    };
    pc.ondatachannel = (event) => attachDataChannel(peerId, event.channel);

    const audioStream = audioStreamRef.current;
    const videoStream = screenStreamRef.current || cameraStreamRef.current;
    const screenAudioStream = screenAudioSessionRef.current?.bridge?.stream || screenAudioSessionRef.current?.stream || null;
    const outboundShareStream = screenAudioSessionRef.current?.outboundStream || videoStream;
    const audioTrack = audioStream?.getAudioTracks()[0] || null;
    const videoTrack = videoStream?.getVideoTracks()[0] || null;
    const screenAudioTrack = screenAudioStream?.getAudioTracks?.()[0] || null;
    const initialMediaTasks = [];
    if (audioTrack && slot.audioSender) {
      initialMediaTasks.push(enqueueSenderMutation(slot, 'audioSender', async (sender) => {
        if (!sender) return false;
        sender.setStreams?.(audioStream);
        slot.audioSenderStream = audioStream;
        await sender.replaceTrack(audioTrack);
        return true;
      }));
    }
    if (videoTrack && slot.videoSender) {
      initialMediaTasks.push(enqueueSenderMutation(slot, 'videoSender', async (sender) => {
        if (!sender) return false;
        sender.setStreams?.(outboundShareStream);
        slot.videoSenderStream = outboundShareStream;
        return mutateVideoSender(slot, 'initial-track', sender, async () => {
          await sender.replaceTrack(videoTrack);
          await configureVideoSender(sender, videoProfileRef.current, peerConnectionsRef.current.size);
          return true;
        }, { profileId: videoProfileRef.current, nextTrackId: videoTrack.id });
      }));
    }
    if (screenAudioTrack && slot.screenAudioSender) {
      initialMediaTasks.push(enqueueSenderMutation(slot, 'screenAudioSender', async (sender) => {
        if (!sender) return false;
        sender.setStreams?.(outboundShareStream);
        slot.screenAudioSenderStream = outboundShareStream;
        await sender.replaceTrack(screenAudioTrack);
        return true;
      }));
    }
    slot.mediaReady = Promise.all(initialMediaTasks);
    if (initiator) {
      attachDataChannel(peerId, pc.createDataChannel('room-data', { ordered: true }));
      slot.offerTimer = window.setTimeout(() => {
        slot.offerTimer = 0;
        void makeOffer(peerId);
      }, 50);
    }
    return slot;
  }, [
    attachDataChannel,
    audioStreamRef,
    cameraStreamRef,
    closePeer,
    localPeerIdRef,
    makeOffer,
    onPeerError,
    peerConnectionsRef,
    remoteStreamsRef,
    requestPeerNegotiation,
    screenStreamRef,
    screenAudioSessionRef,
    sendSignal,
    setRemoteStreams,
    videoProfileRef,
  ]);

  const handlePeerSignal = useCallback((from, data) => {
    const slot = createPeerConnection(from, false);
    return enqueuePeerTask(slot, async () => {
      await slot.mediaReady;
      if (data.type === 'candidate') {
        if (slot.ignoreOffer) return false;
        if (slot.pc.remoteDescription) await slot.pc.addIceCandidate(data.candidate);
        else pendingCandidatesRef.current.set(from, [...(pendingCandidatesRef.current.get(from) || []), data.candidate]);
        return true;
      }

      if (data.type !== 'offer' && data.type !== 'answer') return false;
      const description = new RTCSessionDescription(data.sdp);
      const readyForOffer = !slot.makingOffer
        && (slot.pc.signalingState === 'stable' || slot.isSettingRemoteAnswerPending);
      const offerCollision = description.type === 'offer' && !readyForOffer;
      slot.ignoreOffer = !slot.polite && offerCollision;
      if (slot.ignoreOffer) return false;
      // A polite peer rolls its local offer back when glare occurs. The SDP in
      // that discarded offer may be the first one containing a newly attached
      // mic/screen track, so remember to publish those local changes again
      // after answering the competing offer.
      if (offerCollision) slot.needsNegotiation = true;

      slot.isSettingRemoteAnswerPending = description.type === 'answer';
      await slot.pc.setRemoteDescription(description);
      slot.isSettingRemoteAnswerPending = false;

      // Some Chromium builds occasionally omit `track` after a rapid socket
      // reconnect even though the negotiated receiver and msid are present.
      // Reconstruct the stream from negotiated receivers so playback never
      // depends on that event being delivered a second time.
      slot.pc.getTransceivers()
        .filter((transceiver) => transceiver.receiver.track && remoteDescriptionHasTrack(slot.pc, transceiver))
        .forEach((transceiver) => publishRemoteTrack(slot, from, {
          track: transceiver.receiver.track,
          transceiver,
          streams: [],
        }, remoteStreamsRef, setRemoteStreams, mountedRef));

      if (description.type === 'offer') {
        const transceivers = slot.pc.getTransceivers();
        const audioTransceivers = transceivers.filter((transceiver) => transceiver.receiver.track?.kind === 'audio');
        slot.audioTransceiver ||= audioTransceivers[0] || null;
        slot.videoTransceiver ||= transceivers.find((transceiver) => transceiver.receiver.track?.kind === 'video') || null;
        slot.screenAudioTransceiver ||= audioTransceivers[1] || null;
        if (slot.remotePlaybackProfile) applySlotPlaybackProfile(slot, slot.remotePlaybackProfile);
        if (slot.videoTransceiver) preferVideoCodecs(
          slot.videoTransceiver,
          videoProfileRef.current,
          codecCapabilitiesForRemotePolicy(
            data.codecPolicy,
            mediaCapabilitiesRef.current || {},
          ),
        );
        slot.audioSender ||= slot.audioTransceiver?.sender || null;
        slot.videoSender ||= slot.videoTransceiver?.sender || null;
        slot.screenAudioSender ||= slot.screenAudioTransceiver?.sender || null;
        const audioStream = audioStreamRef.current;
        const videoStream = screenStreamRef.current || cameraStreamRef.current;
        const screenAudioStream = screenAudioSessionRef.current?.bridge?.stream || screenAudioSessionRef.current?.stream || null;
        const outboundShareStream = screenAudioSessionRef.current?.outboundStream || videoStream;
        const audioTrack = audioStream?.getAudioTracks()[0] || null;
        const videoTrack = videoStream?.getVideoTracks()[0] || null;
        const screenAudioTrack = screenAudioStream?.getAudioTracks?.()[0] || null;
        const mediaTasks = [];
        if (audioTrack && slot.audioSender) {
          slot.audioTransceiver.direction = 'sendrecv';
          mediaTasks.push(enqueueSenderMutation(slot, 'audioSender', async (sender) => {
            if (!sender) return false;
            sender.setStreams?.(audioStream);
            slot.audioSenderStream = audioStream;
            await sender.replaceTrack(audioTrack);
            return true;
          }));
        }
        if (videoTrack && slot.videoSender) {
          slot.videoTransceiver.direction = 'sendrecv';
          mediaTasks.push(enqueueSenderMutation(slot, 'videoSender', async (sender) => {
            if (!sender) return false;
            sender.setStreams?.(outboundShareStream);
            slot.videoSenderStream = outboundShareStream;
            return mutateVideoSender(slot, 'answer-track', sender, async () => {
              await sender.replaceTrack(videoTrack);
              await configureVideoSender(sender, videoProfileRef.current, peerConnectionsRef.current.size);
              return true;
            }, { profileId: videoProfileRef.current, nextTrackId: videoTrack.id });
          }));
        }
        if (screenAudioTrack && slot.screenAudioSender) {
          slot.screenAudioTransceiver.direction = 'sendrecv';
          mediaTasks.push(enqueueSenderMutation(slot, 'screenAudioSender', async (sender) => {
            if (!sender) return false;
            sender.setStreams?.(outboundShareStream);
            slot.screenAudioSenderStream = outboundShareStream;
            await sender.replaceTrack(screenAudioTrack);
            return true;
          }));
        }
        slot.mediaReady = Promise.all(mediaTasks);
        await slot.mediaReady;
      }

      const pending = pendingCandidatesRef.current.get(from) || [];
      pendingCandidatesRef.current.delete(from);
      for (const candidate of pending) await slot.pc.addIceCandidate(candidate);

      if (description.type === 'offer') {
        if (slot.audioSender.track) slot.audioTransceiver.direction = 'sendrecv';
        if (slot.videoSender.track) slot.videoTransceiver.direction = 'sendrecv';
        if (slot.screenAudioSender?.track) slot.screenAudioTransceiver.direction = 'sendrecv';
        await slot.pc.setLocalDescription(await slot.pc.createAnswer());
        sendSignal({ type: 'signal', target: from, data: { type: 'answer', sdp: slot.pc.localDescription } });
      }
      return true;
    }, () => onPeerError?.('A conexão com este participante foi interrompida.'));
  }, [audioStreamRef, cameraStreamRef, createPeerConnection, onPeerError, peerConnectionsRef, pendingCandidatesRef, remoteStreamsRef, screenAudioSessionRef, screenStreamRef, sendSignal, setRemoteStreams, videoProfileRef]);

  const closeAllPeers = useCallback(() => {
    [...peerConnectionsRef.current.keys()].forEach(closePeer);
  }, [closePeer, peerConnectionsRef]);

  return {
    closePeer,
    closeAllPeers,
    createPeerConnection,
    handlePeerSignal,
    replacePeerTrack,
    requestPeerNegotiation,
    setPeerScreenDelivery,
    setPeerScreenTransport,
    setPeerPlaybackProfile,
    setVideoEncodingProfile,
  };
}

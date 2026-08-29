import { useCallback, useEffect, useRef } from 'react';
import {
  SCREEN_SHARE_ADAPT_INTERVAL_MS,
  SCREEN_SHARE_BITRATE_INCREASE_INTERVAL_MS,
  adaptVideoSender,
  evaluateCaptureAdaptation,
  initialCaptureAdaptation,
  isSoftwareH264Encoder,
  screenShareCodecOrder,
  screenShareEncodingBitrate,
  screenShareProfile,
} from '../media/screenShareProfiles.js';
import { createScreenShareTelemetrySnapshot } from '../media/screenShareTelemetry.js';
import {
  createScreenShareDiagnosticsSession,
  createScreenShareReceiverSample,
  createScreenShareSenderSample,
  flushScreenShareDiagnosticsSession,
  isScreenShareDiagnosticsEnabled,
} from '../media/screenShareDiagnostics.js';

const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_VIEWERS = 3;

function requestId() {
  return globalThis.crypto?.randomUUID?.()
    || `sfu-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isOpenTransport(transport) {
  return transport && !transport.closed && transport.connectionState !== 'failed';
}

function closeQuietly(entity) {
  try { entity?.close?.(); } catch { /* Already closed. */ }
}

function sfuSenderParameters(producer) {
  const parameters = producer?.rtpSender?.getParameters?.();
  if (!parameters) return null;
  return {
    trackId: producer.track?.id || null,
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

function ensureSfuDiagnosticsSession(slot, key, options) {
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
    transportMode: 'sfu',
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

/**
 * Adds an SFU screen-only path alongside the existing mesh. Camera, voice,
 * screen audio, chat and file transfer stay P2P. A publisher keeps each mesh
 * video sender alive until the corresponding SFU consumer confirms resume, so
 * any setup/driver/network failure falls back without interrupting playback.
 */
export function useScreenSfu({
  inCall,
  isSharing,
  localPeerIdRef,
  onError,
  peerConnectionsRef,
  remoteStreamsRef,
  screenStreamRef,
  screenShareRunRef,
  screenDiagnosticsConfigRef,
  sendSignal,
  setPeerScreenTransport,
  setRemoteStreams,
  videoProfileRef,
  viewerCount,
}) {
  const pendingRef = useRef(new Map());
  const deviceRef = useRef(null);
  const capabilitiesRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);
  const producerRef = useRef(null);
  const producerCodecPolicyRef = useRef(null);
  const producerDiagnosticsRef = useRef(null);
  const producerTelemetryRef = useRef(null);
  const producerAdaptationRef = useRef(null);
  const producerDiagnosticsSessionRef = useRef(null);
  const producerLastBitrateIncreaseAtRef = useRef(0);
  const runtimeCodecOverridesRef = useRef(new Map());
  const consumersRef = useRef(new Map());
  const sfuViewersRef = useRef(new Set());
  const publishChainRef = useRef(Promise.resolve(false));
  const mountedRef = useRef(true);
  const inCallRef = useRef(inCall);
  const viewerCountRef = useRef(viewerCount);
  inCallRef.current = inCall;
  viewerCountRef.current = viewerCount;

  const request = useCallback((action, data = {}) => new Promise((resolve, reject) => {
    const id = requestId();
    const timeout = window.setTimeout(() => {
      pendingRef.current.delete(id);
      reject(new Error(`SFU timeout: ${action}`));
    }, REQUEST_TIMEOUT_MS);
    pendingRef.current.set(id, {
      resolve: (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    });
    if (sendSignal({ type: 'sfu-request', requestId: id, action, data }) === false) {
      pendingRef.current.delete(id);
      window.clearTimeout(timeout);
      reject(new Error('Servidor de sinalização indisponível para o SFU.'));
    }
  }), [sendSignal]);

  const restoreMeshVideo = useCallback((peerId, consumer = null) => {
    const slot = peerConnectionsRef.current.get(peerId);
    if (!slot?.remoteBundle) return;
    const activeTrackId = slot.remoteBundle.videoStream?.getVideoTracks?.()[0]?.id;
    if (consumer && activeTrackId && activeTrackId !== consumer.track?.id) return;
    slot.remoteBundle.videoStream = slot.p2pVideoStream || null;
    slot.screenSfuConsumerId = '';
    if (mountedRef.current) {
      setRemoteStreams((current) => ({
        ...current,
        [peerId]: { ...slot.remoteBundle },
      }));
    }
  }, [peerConnectionsRef, setRemoteStreams]);

  const closeConsumer = useCallback((producerId, { notify = true } = {}) => {
    const entry = consumersRef.current.get(producerId);
    if (!entry) return false;
    consumersRef.current.delete(producerId);
    void flushScreenShareDiagnosticsSession(entry.receiverDiagnosticsSession, 'consumer-closed');
    entry.receiverDiagnosticsSession = null;
    restoreMeshVideo(entry.peerId, entry.consumer);
    if (notify) void request('close-consumer', { consumerId: entry.consumer.id }).catch(() => {});
    closeQuietly(entry.consumer);
    return true;
  }, [request, restoreMeshVideo]);

  const attachConsumer = useCallback((peerId, consumer) => {
    const slot = peerConnectionsRef.current.get(peerId);
    if (!slot) return false;
    const stream = new MediaStream([consumer.track]);
    const incoming = remoteStreamsRef.current.get(peerId) || new MediaStream();
    remoteStreamsRef.current.set(peerId, incoming);
    slot.remoteBundle ||= {
      stream: incoming,
      videoStream: null,
      microphoneStream: null,
      screenAudioStream: null,
      screenShareDiagnosticsSession: null,
    };
    slot.remoteBundle.stream = incoming;
    slot.remoteBundle.videoStream = stream;
    slot.screenSfuConsumerId = consumer.id;
    if (mountedRef.current) {
      setRemoteStreams((current) => ({
        ...current,
        [peerId]: { ...slot.remoteBundle },
      }));
    }
    return true;
  }, [peerConnectionsRef, remoteStreamsRef, setRemoteStreams]);

  const ensureDevice = useCallback(async () => {
    if (deviceRef.current?.loaded && capabilitiesRef.current) return capabilitiesRef.current;
    const capabilities = await request('capabilities');
    const { Device } = await import('mediasoup-client');
    const device = await Device.factory();
    await device.load({
      routerRtpCapabilities: capabilities.routerRtpCapabilities,
      preferLocalCodecsOrder: true,
    });
    deviceRef.current = device;
    capabilitiesRef.current = capabilities;
    return capabilities;
  }, [request]);

  const bindTransport = useCallback((transport) => {
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      request('connect-transport', { transportId: transport.id, dtlsParameters })
        .then(() => callback()).catch(errback);
    });
    transport.on('connectionstatechange', (state) => {
      if (!['failed', 'closed'].includes(state)) return;
      if (sendTransportRef.current === transport) sendTransportRef.current = null;
      if (recvTransportRef.current === transport) recvTransportRef.current = null;
      if (state === 'failed') closeQuietly(transport);
    });
    return transport;
  }, [request]);

  const ensureSendTransport = useCallback(async () => {
    if (isOpenTransport(sendTransportRef.current)) return sendTransportRef.current;
    const device = deviceRef.current;
    if (!device?.loaded) throw new Error('Dispositivo SFU ainda não foi carregado.');
    const options = await request('create-transport', { direction: 'send' });
    const transport = bindTransport(device.createSendTransport(options));
    transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
      request('produce', {
        transportId: transport.id,
        kind,
        rtpParameters,
        appData,
      }).then(({ id }) => callback({ id })).catch(errback);
    });
    sendTransportRef.current = transport;
    return transport;
  }, [bindTransport, request]);

  const ensureRecvTransport = useCallback(async () => {
    if (isOpenTransport(recvTransportRef.current)) return recvTransportRef.current;
    const device = deviceRef.current;
    if (!device?.loaded) throw new Error('Dispositivo SFU ainda não foi carregado.');
    const options = await request('create-transport', { direction: 'recv' });
    recvTransportRef.current = bindTransport(device.createRecvTransport(options));
    return recvTransportRef.current;
  }, [bindTransport, request]);

  const consumeProducer = useCallback(async ({ producerId, peerId }) => {
    if (!inCallRef.current || viewerCountRef.current < DEFAULT_MIN_VIEWERS
        || !producerId || !peerId || consumersRef.current.has(producerId)) return false;
    try {
      await ensureDevice();
      const transport = await ensureRecvTransport();
      const options = await request('consume', {
        transportId: transport.id,
        producerId,
        rtpCapabilities: deviceRef.current.recvRtpCapabilities,
      });
      const consumer = await transport.consume(options);
      const entry = {
        consumer,
        peerId: options.peerId || peerId,
        runId: options.screenShareRunId || options.appData?.screenShareRunId || null,
      };
      consumersRef.current.set(producerId, entry);
      consumer.on('transportclose', () => closeConsumer(producerId));
      consumer.on('trackended', () => closeConsumer(producerId));
      if (!attachConsumer(entry.peerId, consumer)) {
        consumersRef.current.delete(producerId);
        closeQuietly(consumer);
        return false;
      }
      await request('resume-consumer', { consumerId: consumer.id });
      return true;
    } catch {
      closeConsumer(producerId);
      return false;
    }
  }, [attachConsumer, closeConsumer, ensureDevice, ensureRecvTransport, request]);

  const syncRoom = useCallback(async () => {
    if (!inCallRef.current || viewerCountRef.current < DEFAULT_MIN_VIEWERS) return false;
    try {
      await ensureDevice();
      const { producers = [] } = await request('list-producers');
      await Promise.all(producers.map(consumeProducer));
      return true;
    } catch {
      return false;
    }
  }, [consumeProducer, ensureDevice, request]);

  const stopPublishing = useCallback(async ({ notify = true } = {}) => {
    const producer = producerRef.current;
    producerRef.current = null;
    void flushScreenShareDiagnosticsSession(producerDiagnosticsSessionRef.current, 'sfu-publishing-stopped');
    producerDiagnosticsSessionRef.current = null;
    producerDiagnosticsRef.current = null;
    producerTelemetryRef.current = null;
    producerAdaptationRef.current = null;
    if (producer && notify) {
      await request('close-producer', { producerId: producer.id }).catch(() => {});
    }
    closeQuietly(producer);
    const viewers = [...sfuViewersRef.current];
    sfuViewersRef.current.clear();
    await Promise.all(viewers.map((peerId) => setPeerScreenTransport(peerId, false)));
    return Boolean(producer);
  }, [request, setPeerScreenTransport]);

  const publish = useCallback(async (track) => {
    if (!track || viewerCount < DEFAULT_MIN_VIEWERS) {
      await stopPublishing();
      return false;
    }
    const capabilities = await ensureDevice();
    const minimum = Number(capabilities.minViewers) || DEFAULT_MIN_VIEWERS;
    if (!track || viewerCount < minimum) {
      await stopPublishing();
      return false;
    }
    if (producerRef.current?.track?.id === track.id && !producerRef.current.closed) return true;
    await stopPublishing();
    const transport = await ensureSendTransport();
    const profile = screenShareProfile(videoProfileRef.current);
    const getMediaCapabilities = globalThis.jumpDesktop?.getMediaCapabilities;
    const mediaCapabilities = typeof getMediaCapabilities === 'function'
      ? await getMediaCapabilities().catch(() => null) || {}
      : {};
    const runtimePreferredMime = runtimeCodecOverridesRef.current.get(track.id) || '';
    const codecOrder = screenShareCodecOrder(profile.id, mediaCapabilities);
    const preferredMime = (runtimePreferredMime || codecOrder[0]).toLowerCase();
    const softwareOnly = Boolean(runtimePreferredMime)
      || mediaCapabilities.hardwareVideoEncoding === false
      || String(mediaCapabilities.videoEncode || '').toLowerCase() === 'disabled_software';
    const initialAdaptation = initialCaptureAdaptation(profile.id);
    if (softwareOnly) {
      initialAdaptation.level = profile.softwareSafeStart.level;
      initialAdaptation.temporalLevel = profile.softwareSafeStart.temporalLevel;
      initialAdaptation.frameRate = profile.adaptationFrameRates[initialAdaptation.temporalLevel];
      initialAdaptation.scale = profile.adaptationScales[initialAdaptation.level];
      initialAdaptation.cooldownSamples = 2;
      initialAdaptation.reason = 'software-encoder-safe-start';
      initialAdaptation.softwareEncoder = true;
    }
    initialAdaptation.trackId = track.id;
    const initialScale = profile.adaptationScales[initialAdaptation.level] || 1;
    const initialFrameRate = profile.adaptationFrameRates[initialAdaptation.temporalLevel]
      || profile.frameRate;
    const initialBitrate = screenShareEncodingBitrate(profile.id, 1, initialScale);
    const codec = deviceRef.current.sendRtpCapabilities.codecs.find((entry) => (
      entry.mimeType?.toLowerCase() === preferredMime
    ));
    const producer = await transport.produce({
      track,
      stopTracks: false,
      codec,
      encodings: [{
        maxBitrate: initialBitrate,
        maxFramerate: initialFrameRate,
        scaleResolutionDownBy: initialScale,
        scalabilityMode: 'L1T1',
      }],
      // Keep codec FMTP stable across successive producers on the same
      // mediasoup send transport. Per-profile x-google-start-bitrate values
      // reuse the same payload type and Chromium rejects the next BUNDLE offer
      // as a codec collision. maxBitrate above remains the authoritative cap.
      appData: {
        mediaTag: 'screen',
        profileId: profile.id,
        ...(screenShareRunRef.current?.runId ? { screenShareRunId: screenShareRunRef.current.runId } : {}),
      },
    });
    producerRef.current = producer;
    producerAdaptationRef.current = initialAdaptation;
    producerCodecPolicyRef.current = runtimePreferredMime
      ? `runtime-software:${profile.id}:${runtimePreferredMime.split('/').at(-1)}`
      : `${mediaCapabilities.hardwareVideoEncoding === false ? 'software-only' : 'capability'}:${profile.id}:${preferredMime.split('/').at(-1)}`;
    producerDiagnosticsRef.current = {
      checked: false,
      codec: producer.rtpParameters?.codecs?.[0] || codec || null,
      encoderImplementation: null,
      powerEfficientEncoder: null,
    };
    producer.on('transportclose', () => {
      if (producerRef.current === producer) void stopPublishing({ notify: false });
    });
    return true;
  }, [ensureDevice, ensureSendTransport, stopPublishing, videoProfileRef, viewerCount]);

  const syncPublishing = useCallback((track) => {
    const run = () => publish(track).catch((error) => {
      void stopPublishing({ notify: false });
      onError?.(`SFU indisponível; o compartilhamento continua P2P. ${error?.message || ''}`.trim());
      return false;
    });
    publishChainRef.current = publishChainRef.current.then(run, run);
    return publishChainRef.current;
  }, [onError, publish, stopPublishing]);

  useEffect(() => {
    if (!isSharing) return undefined;
    let cancelled = false;
    let checking = false;
    const inspectProducer = async () => {
      const producer = producerRef.current;
      if (checking || !producer || producer.closed) return;
      checking = true;
      try {
        const reports = await producer.getStats();
        const values = [...reports.values()];
        const outbound = values.find((report) => (
          report.type === 'outbound-rtp'
          && (report.kind === 'video' || report.mediaType === 'video')
          && !report.isRemote
        ));
        if (!outbound) return;
        const codec = values.find((report) => report.id === outbound.codecId)
          || producer.rtpParameters?.codecs?.[0]
          || null;
        const diagnostics = {
          checked: Boolean(codec?.mimeType),
          codec,
          encoderImplementation: outbound.encoderImplementation || null,
          powerEfficientEncoder: outbound.powerEfficientEncoder ?? null,
        };
        producerDiagnosticsRef.current = diagnostics;
        const liveTrack = screenStreamRef.current?.getVideoTracks?.()[0] || null;
        if (!liveTrack || liveTrack !== producer.track) return;
        if (isSoftwareH264Encoder(diagnostics)
            && runtimeCodecOverridesRef.current.get(liveTrack.id) !== 'video/VP8') {
          runtimeCodecOverridesRef.current.set(liveTrack.id, 'video/VP8');
          await stopPublishing();
          if (!cancelled && screenStreamRef.current?.getVideoTracks?.()[0] === liveTrack) {
            await syncPublishing(liveTrack);
          }
          return;
        }

        const now = performance.timeOrigin + performance.now();
        const telemetry = createScreenShareTelemetrySnapshot(
          reports,
          producerTelemetryRef.current,
          { trackIdentifier: liveTrack.id, timestampMs: now },
        );
        producerTelemetryRef.current = telemetry;
        const trackSettings = liveTrack.getSettings?.() || {};
        const adaptationDiagnostics = {
          availableOutgoingBitrate: telemetry.network.availableOutgoingBitrate ?? 0,
          configuredMaxBitrate: Number(producer.rtpSender?.getParameters?.().encodings?.[0]?.maxBitrate) || 0,
          framesPerSecond: telemetry.derived.encodeFps,
          captureFps: telemetry.derived.captureFps,
          sourceWidth: telemetry.source.width,
          sourceHeight: telemetry.source.height,
          trackWidth: trackSettings.width ?? null,
          trackHeight: trackSettings.height ?? null,
          frameWidth: telemetry.outbound.frameWidth,
          frameHeight: telemetry.outbound.frameHeight,
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
          peerCount: 1,
          encoderImplementation: telemetry.outbound.encoderImplementation,
          powerEfficientEncoder: telemetry.outbound.powerEfficientEncoder,
        };
        const hasFpsSample = adaptationDiagnostics.captureFps !== null
          || adaptationDiagnostics.framesPerSecond !== null;
        const current = producerAdaptationRef.current?.trackId === liveTrack.id
          ? producerAdaptationRef.current
          : { ...initialCaptureAdaptation(videoProfileRef.current), trackId: liveTrack.id };
        const next = hasFpsSample
          ? evaluateCaptureAdaptation(current, videoProfileRef.current, adaptationDiagnostics)
          : current;
        next.trackId = liveTrack.id;
        const profile = screenShareProfile(videoProfileRef.current);
        const previousParameters = producer.rtpSender?.getParameters?.() || {};
        const previousEncoding = previousParameters.encodings?.[0] || {};
        const structuralChange = Math.abs(
          (Number(previousEncoding.scaleResolutionDownBy) || 1) - (Number(next.scale) || 1),
        ) >= 0.01 || Number(previousEncoding.maxFramerate) !== Number(next.frameRate);
        const allowBitrateIncrease = structuralChange
          || now - producerLastBitrateIncreaseAtRef.current >= SCREEN_SHARE_BITRATE_INCREASE_INTERVAL_MS;
        const applied = await adaptVideoSender(producer.rtpSender, profile.id, 1, {
          ...adaptationDiagnostics,
          adaptationScale: next.scale,
          targetFrameRate: next.frameRate,
          allowBitrateIncrease,
          networkPressure: next.networkPressure,
          transportPressure: next.transportPressure,
          startupBitrateGuardActive: next.startupBitrateGuardActive,
          recoveryProbeActive: next.recoveryProbeActive,
          recoveryProbeMaxBitrate: next.recoveryProbeMaxBitrate,
        });
        if (applied) {
          const nextBitrate = Number(producer.rtpSender?.getParameters?.().encodings?.[0]?.maxBitrate) || 0;
          if (nextBitrate > (Number(previousEncoding.maxBitrate) || 0)) {
            producerLastBitrateIncreaseAtRef.current = now;
          }
          producerAdaptationRef.current = next;
        }
        const run = screenShareRunRef.current;
        if (isScreenShareDiagnosticsEnabled() && run?.runId) {
          if (producerDiagnosticsSessionRef.current?.runId !== run.runId) {
            if (producerDiagnosticsSessionRef.current) {
              void flushScreenShareDiagnosticsSession(producerDiagnosticsSessionRef.current, 'run-replaced');
            }
            producerDiagnosticsSessionRef.current = createScreenShareDiagnosticsSession({
              enabled: true,
              runId: run.runId,
              role: 'sender',
              participantId: localPeerIdRef.current,
              peerId: localPeerIdRef.current,
              transportMode: 'sfu',
              environment: screenDiagnosticsConfigRef.current?.environment,
              startedAtMs: run.startedAtMs,
              performanceTimeOriginMs: run.performanceTimeOriginMs,
              monotonicStartMs: run.monotonicStartMs,
              capture: run.capture,
            });
          }
          const session = producerDiagnosticsSessionRef.current;
          if (session) {
            session.updateMetadata({
              capture: { ...(run.capture || {}), trackSettings },
              transport: telemetry.network,
            });
            session.recordSample(createScreenShareSenderSample({
              telemetry,
              adaptation: producerAdaptationRef.current || next,
              senderParameters: sfuSenderParameters(producer),
              peerId: localPeerIdRef.current,
              trackSettings,
              peerCount: 1,
            }));
          }
        }
      } catch {
        // A missing stats field must not interrupt the active SFU stream. The
        // next interval retries until an actual encoder is observable.
      } finally {
        checking = false;
      }
    };
    const firstTimer = window.setTimeout(() => void inspectProducer(), 1_500);
    const interval = window.setInterval(() => void inspectProducer(), SCREEN_SHARE_ADAPT_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(firstTimer);
      window.clearInterval(interval);
    };
  }, [isSharing, screenStreamRef, stopPublishing, syncPublishing]);

  useEffect(() => {
    if (!isScreenShareDiagnosticsEnabled()) return undefined;
    let running = false;
    const sampleConsumers = async () => {
      if (running) return;
      running = true;
      try {
        await Promise.all([...consumersRef.current.entries()].map(async ([producerId, entry]) => {
          if (typeof entry.consumer?.getStats !== 'function' || entry.consumer.closed) return;
          try {
            const reports = await entry.consumer.getStats();
            const telemetry = createScreenShareTelemetrySnapshot(
              reports,
              entry.telemetry || null,
              { timestampMs: performance.timeOrigin + performance.now() },
            );
            if (!telemetry.ids.inbound) return;
            entry.telemetry = telemetry;
            const slot = peerConnectionsRef.current.get(entry.peerId);
            const runId = entry.runId || slot?.remoteMediaState?.screenShareRunId || '';
            if (!runId) return;
            const run = {
              runId,
              startedAtMs: Date.now(),
              performanceTimeOriginMs: performance.timeOrigin,
              monotonicStartMs: performance.now(),
              capture: null,
            };
            const senderAnnouncedStartedAtMs = slot?.remoteMediaState?.screenShareRunStartedAtMs || null;
            const session = ensureSfuDiagnosticsSession(entry, 'receiverDiagnosticsSession', {
              run,
              correlation: { senderAnnouncedStartedAtMs },
              role: 'receiver',
              participantId: localPeerIdRef.current,
              peerId: localPeerIdRef.current,
              sourcePeerId: entry.peerId,
              environment: screenDiagnosticsConfigRef.current?.environment,
            });
            if (!session) return;
            if (slot?.remoteBundle) {
              slot.remoteBundle.screenShareDiagnosticsSession = session;
              setRemoteStreams((current) => ({
                ...current,
                [entry.peerId]: { ...slot.remoteBundle },
              }));
            }
            session.updateMetadata({ transport: telemetry.network });
            session.recordSample(createScreenShareReceiverSample({
              telemetry,
              peerId: localPeerIdRef.current,
              sourcePeerId: entry.peerId,
              receiver: { producerId },
            }));
          } catch {
            // Optional mediasoup stats must never affect the active consumer.
          }
        }));
      } finally {
        running = false;
      }
    };
    const timer = window.setInterval(() => { void sampleConsumers(); }, SCREEN_SHARE_ADAPT_INTERVAL_MS);
    void sampleConsumers();
    return () => window.clearInterval(timer);
  }, [localPeerIdRef, peerConnectionsRef, screenDiagnosticsConfigRef, setRemoteStreams]);

  const setConsumerWatching = useCallback(async (peerId, watching) => {
    const entry = [...consumersRef.current.values()].find((candidate) => candidate.peerId === peerId);
    if (!entry) return false;
    entry.consumer.pause?.();
    if (watching) entry.consumer.resume?.();
    await request(watching ? 'resume-consumer' : 'pause-consumer', {
      consumerId: entry.consumer.id,
    }).catch(() => {});
    return true;
  }, [request]);

  const reset = useCallback(async () => {
    await stopPublishing({ notify: false });
    [...consumersRef.current.keys()].forEach(closeConsumer);
    const transportIds = [sendTransportRef.current?.id, recvTransportRef.current?.id].filter(Boolean);
    await Promise.all(transportIds.map((transportId) => (
      request('close-transport', { transportId }).catch(() => {})
    )));
    closeQuietly(sendTransportRef.current);
    closeQuietly(recvTransportRef.current);
    sendTransportRef.current = null;
    recvTransportRef.current = null;
    deviceRef.current = null;
    capabilitiesRef.current = null;
    producerCodecPolicyRef.current = null;
    producerDiagnosticsRef.current = null;
    producerTelemetryRef.current = null;
    producerAdaptationRef.current = null;
    producerLastBitrateIncreaseAtRef.current = 0;
    runtimeCodecOverridesRef.current.clear();
  }, [closeConsumer, request, stopPublishing]);

  const handleSignalMessage = useCallback((message) => {
    if (message.type === 'sfu-response') {
      const pending = pendingRef.current.get(message.requestId);
      if (!pending) return true;
      pendingRef.current.delete(message.requestId);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(new Error(message.error || 'Falha no SFU.'));
      return true;
    }
    if (message.type === 'sfu-producer-added') {
      if (inCallRef.current && viewerCountRef.current >= DEFAULT_MIN_VIEWERS) void consumeProducer(message);
      return true;
    }
    if (message.type === 'sfu-producer-closed') {
      closeConsumer(message.producerId);
      return true;
    }
    if (message.type === 'sfu-consumer-ready') {
      if (message.producerId !== producerRef.current?.id) return true;
      sfuViewersRef.current.add(message.viewerPeerId);
      void setPeerScreenTransport(message.viewerPeerId, true);
      return true;
    }
    if (message.type === 'sfu-consumer-paused') {
      if (message.producerId !== producerRef.current?.id) return true;
      sfuViewersRef.current.delete(message.viewerPeerId);
      void setPeerScreenTransport(message.viewerPeerId, false);
      return true;
    }
    return false;
  }, [closeConsumer, consumeProducer, setPeerScreenTransport]);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('meshDebug')) return undefined;
    globalThis.__jumpScreenSfu = {
      capabilitiesRef,
      consumersRef,
      producerCodecPolicyRef,
      producerDiagnosticsRef,
      producerTelemetryRef,
      producerAdaptationRef,
      producerRef,
      recvTransportRef,
      sendTransportRef,
      sfuViewersRef,
    };
    return () => { delete globalThis.__jumpScreenSfu; };
  }, []);

  useEffect(() => {
    const track = isSharing ? screenStreamRef.current?.getVideoTracks?.()[0] || null : null;
    if (track) void syncPublishing(track);
    else void stopPublishing();
  }, [isSharing, screenStreamRef, stopPublishing, syncPublishing, viewerCount]);

  useEffect(() => {
    if (inCall) void syncRoom();
    else [...consumersRef.current.keys()].forEach(closeConsumer);
  }, [closeConsumer, inCall, syncRoom]);

  useEffect(() => () => {
    mountedRef.current = false;
    pendingRef.current.forEach((pending) => pending.reject(new Error('SFU encerrado.')));
    pendingRef.current.clear();
    void reset();
  }, [reset]);

  return {
    handleScreenSfuSignal: handleSignalMessage,
    resetScreenSfu: reset,
    setSfuConsumerWatching: setConsumerWatching,
    syncScreenSfuRoom: syncRoom,
  };
}

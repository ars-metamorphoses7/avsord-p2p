import { useCallback, useEffect, useRef } from 'react';
import {
  SCREEN_SHARE_ADAPT_INTERVAL_MS,
  adaptVideoSender,
  configureVideoSender,
  evaluateCaptureAdaptation,
  initialCaptureAdaptation,
  preferVideoCodecs,
  screenSharePlaybackBuffer,
} from '../media/screenShareProfiles.js';

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
  slot.remoteBundle ||= { stream: incoming, videoStream: null, microphoneStream: null, screenAudioStream: null };
  slot.remoteBundle.stream = incoming;
  const role = remoteTrackRole(slot.pc, event.transceiver, event.track);
  slot.remoteBundle[`${role}Stream`] = streamForTrack(event.track);
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
  slot.remotePlaybackProfile = profileId || 'fluid';
  const targetMs = screenSharePlaybackBuffer(slot.remotePlaybackProfile);
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
  videoProfileRef,
  remoteStreamsRef,
  sendSignal,
  attachDataChannel,
  clearRemoteCallMedia,
  setRemoteStreams,
  onPeerError,
}) {
  const mountedRef = useRef(true);
  const adaptationRef = useRef(initialCaptureAdaptation(videoProfileRef.current));

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('meshDebug')) return undefined;
    globalThis.__jumpPeerMesh = { peerConnectionsRef, remoteStreamsRef };
    return () => { delete globalThis.__jumpPeerMesh; };
  }, [peerConnectionsRef, remoteStreamsRef]);

  useEffect(() => {
    let running = false;
    const tuneVideo = async () => {
      if (running) return;
      running = true;
      const screenTrack = screenStreamRef.current?.getVideoTracks?.()[0] || null;
      const slots = [...peerConnectionsRef.current.values()].filter((slot) => (
        screenTrack && slot?.videoSender?.track === screenTrack && slot.pc.connectionState !== 'closed'
      ));
      if (!slots.length) {
        running = false;
        return;
      }
      if (adaptationRef.current.trackId !== screenTrack.id || adaptationRef.current.profileId !== videoProfileRef.current) {
        adaptationRef.current = { ...initialCaptureAdaptation(videoProfileRef.current), trackId: screenTrack.id };
      }
      const samples = await Promise.all(slots.map(async (slot) => {
        try {
          const reports = await slot.pc.getStats(slot.videoSender.track);
          const outbound = [...reports.values()].find((report) => report.type === 'outbound-rtp' && report.kind === 'video' && !report.isRemote);
          const mediaSource = [...reports.values()].find((report) => report.type === 'media-source' && report.kind === 'video');
          const transport = outbound?.transportId ? reports.get(outbound.transportId) : [...reports.values()].find((report) => report.type === 'transport');
          const pair = transport?.selectedCandidatePairId ? reports.get(transport.selectedCandidatePairId) : [...reports.values()].find((report) => report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded');
          const previous = slot.videoStatsSample;
          const elapsedSeconds = previous && Number(outbound?.timestamp) > previous.timestamp
            ? (Number(outbound.timestamp) - previous.timestamp) / 1000
            : 0;
          const encodedDelta = previous ? Number(outbound?.framesEncoded || 0) - previous.framesEncoded : 0;
          const encodeTimeDelta = previous ? Number(outbound?.totalEncodeTime || 0) - previous.totalEncodeTime : 0;
          const computedFps = elapsedSeconds > 0 && encodedDelta >= 0 ? encodedDelta / elapsedSeconds : 0;
          const averageEncodeTimeMs = encodedDelta > 0 && encodeTimeDelta >= 0 ? (encodeTimeDelta * 1000) / encodedDelta : 0;
          slot.videoStatsSample = {
            timestamp: Number(outbound?.timestamp) || performance.now(),
            framesEncoded: Number(outbound?.framesEncoded) || 0,
            totalEncodeTime: Number(outbound?.totalEncodeTime) || 0,
          };
          const diagnostics = {
            availableOutgoingBitrate: Number(pair?.availableOutgoingBitrate) || 0,
            framesPerSecond: computedFps || Number(outbound?.framesPerSecond) || 0,
            captureFps: Number(mediaSource?.framesPerSecond) || 0,
            averageEncodeTimeMs,
            qualityLimitationReason: outbound?.qualityLimitationReason || 'none',
          };
          slot.videoDiagnostics = diagnostics;
          return { slot, diagnostics };
        } catch {
          // Stats support varies slightly across Chromium builds. Static sender
          // parameters remain active when an adaptive sample is unavailable.
          return { slot, diagnostics: slot.videoDiagnostics || {} };
        }
      }));
      const limitations = samples.map(({ diagnostics }) => diagnostics.qualityLimitationReason || 'none');
      const aggregate = {
        captureFps: Math.min(...samples.map(({ diagnostics }) => Number(diagnostics.captureFps) || Infinity)),
        framesPerSecond: Math.min(...samples.map(({ diagnostics }) => Number(diagnostics.framesPerSecond) || Infinity)),
        averageEncodeTimeMs: Math.max(...samples.map(({ diagnostics }) => Number(diagnostics.averageEncodeTimeMs) || 0)),
        qualityLimitationReason: limitations.includes('cpu') ? 'cpu' : limitations.includes('bandwidth') ? 'bandwidth' : 'none',
      };
      if (!Number.isFinite(aggregate.captureFps)) aggregate.captureFps = 0;
      if (!Number.isFinite(aggregate.framesPerSecond)) aggregate.framesPerSecond = 0;
      const nextAdaptation = evaluateCaptureAdaptation(adaptationRef.current, videoProfileRef.current, aggregate);
      nextAdaptation.trackId = screenTrack.id;
      adaptationRef.current = nextAdaptation;
      await Promise.all(samples.map(({ slot, diagnostics }) => adaptVideoSender(
        slot.videoSender,
        videoProfileRef.current,
        slots.length,
        { ...diagnostics, adaptationScale: nextAdaptation.scale },
      )));
      running = false;
    };
    const timer = window.setInterval(() => { void tuneVideo(); }, SCREEN_SHARE_ADAPT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [peerConnectionsRef, screenStreamRef, videoProfileRef]);

  const closePeer = useCallback((peerId) => {
    const slot = peerConnectionsRef.current.get(peerId);
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
        sendSignal({ type: 'signal', target: peerId, data: { type: 'offer', sdp: slot.pc.localDescription } });
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
      const sender = slot?.[senderKey];
      if (!sender || ['closed', 'failed'].includes(slot.pc.connectionState)) return;
      try {
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
        await sender.replaceTrack(track || null);
        if (senderKey === 'videoSender' && track) {
          await configureVideoSender(sender, videoProfileRef.current, peerConnectionsRef.current.size);
          const isScreenTrack = track === screenStreamRef.current?.getVideoTracks?.()[0];
          await setSenderActive(sender, isScreenTrack ? slot.screenWatching !== false : true);
        }
        if (senderKey === 'screenAudioSender' && track) {
          await setSenderActive(sender, slot.screenWatching !== false);
        }
        // Chromium does not consistently emit the first remote `track` event
        // when a transceiver was negotiated without an msid. Only the sender
        // that attaches the first real track renegotiates; the receiver never
        // mirrors this from call-state, avoiding the old offer storm.
        if (!previousTrack && track) requestPeerNegotiation(peerId);
      } catch {
        failed.push(peerId);
      }
    }));
    if (failed.length) onPeerError?.('A mídia não pôde ser anexada a um dos participantes. Tente entrar na chamada novamente.');
    return failed.length === 0;
  }, [onPeerError, peerConnectionsRef, requestPeerNegotiation, screenStreamRef, videoProfileRef]);

  const setVideoEncodingProfile = useCallback(async (profileId) => {
    videoProfileRef.current = profileId;
    adaptationRef.current = initialCaptureAdaptation(profileId);
    const slots = [...peerConnectionsRef.current.values()].filter((slot) => slot?.videoSender?.track);
    await Promise.all(slots.map((slot) => configureVideoSender(slot.videoSender, profileId, slots.length)));
  }, [peerConnectionsRef, videoProfileRef]);

  const setPeerPlaybackProfile = useCallback((peerId, profileId) => {
    const slot = peerConnectionsRef.current.get(peerId);
    if (!slot || slot.pc.connectionState === 'closed') return false;
    return applySlotPlaybackProfile(slot, profileId);
  }, [peerConnectionsRef]);

  const setPeerScreenDelivery = useCallback(async (peerId, watching) => {
    const slot = peerConnectionsRef.current.get(peerId);
    if (!slot || slot.pc.connectionState === 'closed') return false;
    slot.screenWatching = Boolean(watching);
    const activeScreenTrack = screenStreamRef.current?.getVideoTracks?.()[0];
    const tasks = [];
    if (activeScreenTrack && slot.videoSender?.track === activeScreenTrack) tasks.push(setSenderActive(slot.videoSender, watching));
    if (slot.screenAudioSender?.track) tasks.push(setSenderActive(slot.screenAudioSender, watching));
    await Promise.all(tasks);
    return true;
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
    if (videoTransceiver) preferVideoCodecs(videoTransceiver, videoProfileRef.current);
    const slot = {
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
      slot.audioSender.setStreams?.(audioStream);
      slot.audioSenderStream = audioStream;
      initialMediaTasks.push(slot.audioSender.replaceTrack(audioTrack));
    }
    if (videoTrack && slot.videoSender) {
      slot.videoSender.setStreams?.(outboundShareStream);
      slot.videoSenderStream = outboundShareStream;
      initialMediaTasks.push(slot.videoSender.replaceTrack(videoTrack));
      initialMediaTasks.push(configureVideoSender(slot.videoSender, videoProfileRef.current, peerConnectionsRef.current.size));
    }
    if (screenAudioTrack && slot.screenAudioSender) {
      slot.screenAudioSender.setStreams?.(outboundShareStream);
      slot.screenAudioSenderStream = outboundShareStream;
      initialMediaTasks.push(slot.screenAudioSender.replaceTrack(screenAudioTrack));
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
        if (slot.videoTransceiver) preferVideoCodecs(slot.videoTransceiver, videoProfileRef.current);
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
          slot.audioSender.setStreams?.(audioStream);
          slot.audioSenderStream = audioStream;
          mediaTasks.push(slot.audioSender.replaceTrack(audioTrack));
        }
        if (videoTrack && slot.videoSender) {
          slot.videoTransceiver.direction = 'sendrecv';
          slot.videoSender.setStreams?.(outboundShareStream);
          slot.videoSenderStream = outboundShareStream;
          mediaTasks.push(slot.videoSender.replaceTrack(videoTrack));
          mediaTasks.push(configureVideoSender(slot.videoSender, videoProfileRef.current, peerConnectionsRef.current.size));
        }
        if (screenAudioTrack && slot.screenAudioSender) {
          slot.screenAudioTransceiver.direction = 'sendrecv';
          slot.screenAudioSender.setStreams?.(outboundShareStream);
          slot.screenAudioSenderStream = outboundShareStream;
          mediaTasks.push(slot.screenAudioSender.replaceTrack(screenAudioTrack));
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
    setPeerPlaybackProfile,
    setVideoEncodingProfile,
  };
}

import { useCallback, useEffect, useRef } from 'react';
import { adaptVideoSender, configureVideoSender, preferVideoCodecs } from '../media/screenShareProfiles.js';

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

function remoteDescriptionHasTrack(pc, kind) {
  const section = (pc.remoteDescription?.sdp || '').split(`m=${kind}`)[1]?.split(/\r?\nm=/)[0] || '';
  return /(?:^|\r?\n)a=msid:/m.test(section);
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
  videoProfileRef,
  remoteStreamsRef,
  sendSignal,
  attachDataChannel,
  clearRemoteCallMedia,
  setRemoteStreams,
  onPeerError,
}) {
  const mountedRef = useRef(true);

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
      const slots = [...peerConnectionsRef.current.values()].filter((slot) => slot?.videoSender?.track && slot.pc.connectionState !== 'closed');
      await Promise.all(slots.map(async (slot) => {
        try {
          const reports = await slot.pc.getStats(slot.videoSender.track);
          const outbound = [...reports.values()].find((report) => report.type === 'outbound-rtp' && report.kind === 'video' && !report.isRemote);
          const transport = outbound?.transportId ? reports.get(outbound.transportId) : [...reports.values()].find((report) => report.type === 'transport');
          const pair = transport?.selectedCandidatePairId ? reports.get(transport.selectedCandidatePairId) : [...reports.values()].find((report) => report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded');
          const diagnostics = {
            availableOutgoingBitrate: Number(pair?.availableOutgoingBitrate) || 0,
            framesPerSecond: Number(outbound?.framesPerSecond) || 0,
            qualityLimitationReason: outbound?.qualityLimitationReason || 'none',
          };
          slot.videoDiagnostics = diagnostics;
          await adaptVideoSender(slot.videoSender, videoProfileRef.current, slots.length, diagnostics);
        } catch {
          // Stats support varies slightly across Chromium builds. Static sender
          // parameters remain active when an adaptive sample is unavailable.
        }
      }));
      running = false;
    };
    const timer = window.setInterval(() => { void tuneVideo(); }, 2_500);
    return () => window.clearInterval(timer);
  }, [peerConnectionsRef, videoProfileRef]);

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

  const replacePeerTrack = useCallback(async (senderKey, track) => {
    const failed = [];
    await Promise.all([...peerConnectionsRef.current.entries()].map(async ([peerId, slot]) => {
      const sender = slot?.[senderKey];
      if (!sender || ['closed', 'failed'].includes(slot.pc.connectionState)) return;
      try {
        const previousTrack = sender.track;
        const outboundStream = track ? new MediaStream([track]) : null;
        const transceiver = senderKey === 'audioSender' ? slot.audioTransceiver : slot.videoTransceiver;
        if (track && transceiver) transceiver.direction = 'sendrecv';
        sender.setStreams?.(...(outboundStream ? [outboundStream] : []));
        slot[`${senderKey}Stream`] = outboundStream;
        await sender.replaceTrack(track || null);
        if (senderKey === 'videoSender' && track) {
          await configureVideoSender(sender, videoProfileRef.current, peerConnectionsRef.current.size);
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
  }, [onPeerError, peerConnectionsRef, requestPeerNegotiation, videoProfileRef]);

  const setVideoEncodingProfile = useCallback(async (profileId) => {
    videoProfileRef.current = profileId;
    const slots = [...peerConnectionsRef.current.values()].filter((slot) => slot?.videoSender?.track);
    await Promise.all(slots.map((slot) => configureVideoSender(slot.videoSender, profileId, slots.length)));
  }, [peerConnectionsRef, videoProfileRef]);

  const createPeerConnection = useCallback((peerId, initiator = false) => {
    const existing = peerConnectionsRef.current.get(peerId);
    if (existing && existing.pc.signalingState !== 'closed') return existing;

    const pc = new RTCPeerConnection(PEER_CONNECTION_CONFIG);
    // Only the offerer creates transceivers. The answerer lets the remote SDP
    // create them and binds its local tracks afterwards. Pre-creating them on
    // both sides can leave orphaned transceivers after a polite rollback.
    const audioTransceiver = initiator ? pc.addTransceiver('audio', { direction: 'sendrecv' }) : null;
    const videoTransceiver = initiator ? pc.addTransceiver('video', { direction: 'sendrecv' }) : null;
    if (videoTransceiver) preferVideoCodecs(videoTransceiver, videoProfileRef.current);
    const slot = {
      pc,
      audioTransceiver,
      videoTransceiver,
      audioSender: audioTransceiver?.sender || null,
      videoSender: videoTransceiver?.sender || null,
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
      const incoming = remoteStreamsRef.current.get(peerId) || new MediaStream();
      addIncomingTrack(incoming, event);
      remoteStreamsRef.current.set(peerId, incoming);
      if (mountedRef.current) setRemoteStreams((current) => ({ ...current, [peerId]: { stream: incoming } }));
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
    const audioTrack = audioStream?.getAudioTracks()[0] || null;
    const videoTrack = videoStream?.getVideoTracks()[0] || null;
    const initialMediaTasks = [];
    if (audioTrack && slot.audioSender) {
      slot.audioSender.setStreams?.(audioStream);
      slot.audioSenderStream = audioStream;
      initialMediaTasks.push(slot.audioSender.replaceTrack(audioTrack));
    }
    if (videoTrack && slot.videoSender) {
      slot.videoSender.setStreams?.(videoStream);
      slot.videoSenderStream = videoStream;
      initialMediaTasks.push(slot.videoSender.replaceTrack(videoTrack));
      initialMediaTasks.push(configureVideoSender(slot.videoSender, videoProfileRef.current, peerConnectionsRef.current.size));
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
      const negotiatedTracks = slot.pc.getReceivers()
        .map((receiver) => receiver.track)
        .filter((track) => track && remoteDescriptionHasTrack(slot.pc, track.kind));
      if (negotiatedTracks.length) {
        const incoming = remoteStreamsRef.current.get(from) || new MediaStream();
        negotiatedTracks.forEach((track) => {
          if (!incoming.getTracks().includes(track)) incoming.addTrack(track);
        });
        remoteStreamsRef.current.set(from, incoming);
        if (mountedRef.current) setRemoteStreams((current) => ({ ...current, [from]: { stream: incoming } }));
      }

      if (description.type === 'offer') {
        const transceivers = slot.pc.getTransceivers();
        slot.audioTransceiver ||= transceivers.find((transceiver) => transceiver.receiver.track?.kind === 'audio') || null;
        slot.videoTransceiver ||= transceivers.find((transceiver) => transceiver.receiver.track?.kind === 'video') || null;
        if (slot.videoTransceiver) preferVideoCodecs(slot.videoTransceiver, videoProfileRef.current);
        slot.audioSender ||= slot.audioTransceiver?.sender || null;
        slot.videoSender ||= slot.videoTransceiver?.sender || null;
        const audioStream = audioStreamRef.current;
        const videoStream = screenStreamRef.current || cameraStreamRef.current;
        const audioTrack = audioStream?.getAudioTracks()[0] || null;
        const videoTrack = videoStream?.getVideoTracks()[0] || null;
        const mediaTasks = [];
        if (audioTrack && slot.audioSender) {
          slot.audioTransceiver.direction = 'sendrecv';
          slot.audioSender.setStreams?.(audioStream);
          slot.audioSenderStream = audioStream;
          mediaTasks.push(slot.audioSender.replaceTrack(audioTrack));
        }
        if (videoTrack && slot.videoSender) {
          slot.videoTransceiver.direction = 'sendrecv';
          slot.videoSender.setStreams?.(videoStream);
          slot.videoSenderStream = videoStream;
          mediaTasks.push(slot.videoSender.replaceTrack(videoTrack));
          mediaTasks.push(configureVideoSender(slot.videoSender, videoProfileRef.current, peerConnectionsRef.current.size));
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
        await slot.pc.setLocalDescription(await slot.pc.createAnswer());
        sendSignal({ type: 'signal', target: from, data: { type: 'answer', sdp: slot.pc.localDescription } });
      }
      return true;
    }, () => onPeerError?.('A conexão com este participante foi interrompida.'));
  }, [audioStreamRef, cameraStreamRef, createPeerConnection, onPeerError, peerConnectionsRef, pendingCandidatesRef, remoteStreamsRef, screenStreamRef, sendSignal, setRemoteStreams, videoProfileRef]);

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
    setVideoEncodingProfile,
  };
}

import { useCallback, useEffect, useState } from 'react';
import { createDesktopAudioBridge } from '../media/desktopAudio.js';
import {
  evenScreenCaptureConstraints,
  screenCaptureConstraints,
  screenShareProfile,
} from '../media/screenShareProfiles.js';

function streamTelemetryStore() {
  if (!new URLSearchParams(window.location.search).has('streamTelemetry')) return null;
  globalThis.__jumpStreamTelemetry ||= { version: 1, capture: null, events: [], render: {} };
  return globalThis.__jumpStreamTelemetry;
}

function safeTrackSnapshot(track, method) {
  try {
    return track?.[method]?.() || null;
  } catch {
    return null;
  }
}

export function useScreenShare({
  announceCallState,
  cameraStreamRef,
  inCallRef,
  onShareStarted,
  onShareStopped,
  replacePeerTrack,
  screenAudioSessionRef,
  screenStreamRef,
  setIsSharing,
  setPermissionError,
  setVideoEncodingProfile,
  startCall,
  profileId,
  setProfileId,
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('video');
  const [videoSource, setVideoSource] = useState(null);
  const [audioSource, setAudioSource] = useState(null);
  const [includeAudio, setIncludeAudio] = useState(false);
  const [syncAudio, setSyncAudio] = useState(true);
  const [mediaCapabilities, setMediaCapabilities] = useState(null);

  const cancelPicker = useCallback(() => {
    setPickerOpen(false);
    setSources([]);
    setTab('video');
  }, []);

  const stopAudioSession = useCallback(async () => {
    const session = screenAudioSessionRef.current;
    screenAudioSessionRef.current = null;
    await replacePeerTrack('screenAudioSender', null);
    if (session) await session.stop();
  }, [replacePeerTrack, screenAudioSessionRef]);

  const stopScreenShare = useCallback(() => {
    const wasSharing = Boolean(screenStreamRef.current);
    const telemetry = streamTelemetryStore();
    if (wasSharing && telemetry) telemetry.events.push({ type: 'capture-stopped', timestampMs: Date.now() });
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    cancelPicker();
    void stopAudioSession();
    const fallbackTrack = cameraStreamRef.current?.getVideoTracks()[0] || null;
    void replacePeerTrack('videoSender', fallbackTrack);
    setIsSharing(false);
    announceCallState({ sharing: false, sharingAudio: false, sharingProfile: '' });
    if (wasSharing) onShareStopped?.();
  }, [announceCallState, cameraStreamRef, cancelPicker, onShareStopped, replacePeerTrack, screenStreamRef, setIsSharing, stopAudioSession]);

  const startScreenShare = useCallback(async ({ videoSource: selectedVideo = null, audioSource: selectedAudio = null, includeAudio: withAudio = false, profileId: selectedProfile = profileId } = {}) => {
    const desktop = globalThis.jumpDesktop;
    const desktopCapture = Boolean(selectedVideo?.id && desktop?.isDesktop);
    if (desktopCapture && !navigator.mediaDevices?.getUserMedia) {
      setPermissionError('O compartilhamento de tela não está disponível neste aplicativo.');
      return false;
    }
    if (!desktopCapture && !navigator.mediaDevices?.getDisplayMedia) {
      setPermissionError('O compartilhamento de tela não está disponível neste navegador.');
      return false;
    }

    cancelPicker();
    setPermissionError('');
    let videoStream = null;
    let audioBridge = null;
    let videoAttachAttempted = false;
    try {
      const profile = screenShareProfile(selectedProfile);
      videoStream = desktopCapture
        ? await navigator.mediaDevices.getUserMedia({ audio: false, video: screenCaptureConstraints(profile.id, selectedVideo.id) })
        : await navigator.mediaDevices.getDisplayMedia({ video: screenCaptureConstraints(profile.id), audio: false });
      const videoTrack = videoStream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('Nenhuma faixa de vídeo foi criada.');
      videoTrack.contentHint = profile.contentHint;
      let constraintError = '';
      let dimensionNormalization = null;
      // applyConstraints replaces the track's active constraint set. Passing
      // only frameRate here used to discard the 720p/1080p size ceiling from
      // getUserMedia, silently letting Chromium capture performance mode at
      // 1440x810 before sender scaling. Re-apply the complete standard set.
      await videoTrack.applyConstraints?.(screenCaptureConstraints(profile.id)).catch((error) => {
        constraintError = error?.message || String(error);
      });
      const evenConstraints = evenScreenCaptureConstraints(profile.id, safeTrackSnapshot(videoTrack, 'getSettings'));
      if (evenConstraints) {
        dimensionNormalization = { requested: evenConstraints, applied: false, error: '' };
        try {
          await videoTrack.applyConstraints?.(evenConstraints);
          const normalizedSettings = safeTrackSnapshot(videoTrack, 'getSettings') || {};
          dimensionNormalization.applied = Number(normalizedSettings.width) % 2 === 0
            && Number(normalizedSettings.height) % 2 === 0;
          if (!dimensionNormalization.applied) dimensionNormalization.error = 'capturer-returned-odd-dimensions';
        } catch (error) {
          dimensionNormalization.error = error?.message || String(error);
          constraintError = [constraintError, `even-dimensions: ${dimensionNormalization.error}`].filter(Boolean).join('; ');
        }
      }
      const telemetry = streamTelemetryStore();
      if (telemetry) {
        const requestedConstraints = screenCaptureConstraints(profile.id, selectedVideo?.id || '');
        telemetry.capture = {
          timestampMs: Date.now(),
          profileId: profile.id,
          source: selectedVideo ? {
            id: selectedVideo.id,
            name: selectedVideo.name || '',
            type: selectedVideo.type || '',
          } : { id: '', name: '', type: 'browser-picker' },
          requestedConstraints,
          trackSettings: safeTrackSnapshot(videoTrack, 'getSettings'),
          trackConstraints: safeTrackSnapshot(videoTrack, 'getConstraints'),
          trackCapabilities: safeTrackSnapshot(videoTrack, 'getCapabilities'),
          constraintError,
          dimensionNormalization,
        };
        telemetry.events.push({
          type: 'capture-started',
          timestampMs: Date.now(),
          profileId: profile.id,
          trackId: videoTrack.id,
          settings: telemetry.capture.trackSettings,
        });
      }
      setProfileId(profile.id);
      await setVideoEncodingProfile(profile.id, mediaCapabilities);

      let outboundShareStream = videoStream;

      if (withAudio) {
        if (!desktopCapture || !selectedAudio) throw new Error('Escolha uma fonte de áudio válida.');
        audioBridge = await createDesktopAudioBridge(desktop, {
          audioMode: selectedAudio.audioMode || '',
          audioStreamId: selectedAudio.audioStreamId || '',
          audioTarget: selectedAudio.audioTarget || '',
          processId: selectedAudio.processId || 0,
          type: selectedAudio.type,
          systemAudio: selectedAudio.type === 'screen',
        });
        const desktopAudioTrack = audioBridge.stream.getAudioTracks()[0];
        outboundShareStream = new MediaStream([videoTrack, desktopAudioTrack]);
        screenAudioSessionRef.current = {
          bridge: audioBridge,
          stream: audioBridge.stream,
          outboundStream: outboundShareStream,
          async stop() {
            await audioBridge.stop();
          },
        };
        if (!(await replacePeerTrack('screenAudioSender', desktopAudioTrack, outboundShareStream))) throw new Error('Não foi possível enviar o áudio compartilhado aos participantes.');
      }

      screenStreamRef.current = videoStream;
      videoAttachAttempted = true;
      if (!(await replacePeerTrack('videoSender', videoTrack, outboundShareStream))) throw new Error('Não foi possível enviar a tela aos participantes.');
      videoTrack.onended = () => {
        if (screenStreamRef.current === videoStream) stopScreenShare();
      };
      setIsSharing(true);
      announceCallState({ sharing: true, sharingAudio: withAudio, sharingProfile: profile.id });
      onShareStarted?.();
      return true;
    } catch (error) {
      videoStream?.getTracks().forEach((track) => track.stop());
      if (screenStreamRef.current === videoStream) screenStreamRef.current = null;
      if (videoAttachAttempted) {
        // replacePeerTrack fans out to every mesh peer. If one peer fails after
        // others already switched, put all successful peers back on the camera
        // instead of leaving them attached to the now-ended screen track.
        const fallbackTrack = cameraStreamRef.current?.getVideoTracks?.()[0] || null;
        await replacePeerTrack('videoSender', fallbackTrack).catch(() => false);
      }
      if (audioBridge) {
        await replacePeerTrack('screenAudioSender', null);
        await audioBridge?.stop().catch(() => {});
        screenAudioSessionRef.current = null;
      }
      if (error?.name !== 'AbortError') setPermissionError(error?.message || 'Não foi possível iniciar o compartilhamento de tela.');
      return false;
    }
  }, [announceCallState, cameraStreamRef, cancelPicker, mediaCapabilities, onShareStarted, profileId, replacePeerTrack, screenAudioSessionRef, screenStreamRef, setIsSharing, setPermissionError, setProfileId, setVideoEncodingProfile, stopScreenShare]);

  const toggleScreenShare = useCallback(async () => {
    if (screenStreamRef.current) {
      stopScreenShare();
      return;
    }
    if (!inCallRef.current && !(await startCall())) return;
    const getDesktopSources = globalThis.jumpDesktop?.getDesktopSources;
    if (typeof getDesktopSources !== 'function') {
      await startScreenShare({ profileId });
      return;
    }
    setLoading(true);
    setPickerOpen(true);
    setTab('video');
    setVideoSource(null);
    setAudioSource(null);
    try {
      const [nextSources, capabilities] = await Promise.all([
        getDesktopSources(),
        globalThis.jumpDesktop?.getMediaCapabilities?.().catch(() => null),
      ]);
      setMediaCapabilities(capabilities);
      if (!nextSources.length) {
        cancelPicker();
        setPermissionError('Nenhuma tela ou janela disponível para compartilhar.');
        return;
      }
      setSources(nextSources);
    } catch {
      cancelPicker();
      setPermissionError('Não foi possível listar as telas e janelas disponíveis.');
    } finally {
      setLoading(false);
    }
  }, [cancelPicker, inCallRef, profileId, screenStreamRef, setPermissionError, startCall, startScreenShare, stopScreenShare]);

  const chooseVideoSource = useCallback((source) => {
    setVideoSource(source);
    if (!source.audioSupported) {
      // Linux can capture a window's PipeWire/PulseAudio stream when it is
      // active. If there is no stream, switch to manual audio selection so the
      // dialog can offer a supported source instead of an impossible link.
      setSyncAudio(false);
      setAudioSource(null);
      return;
    }
    if (syncAudio) setAudioSource(source);
  }, [syncAudio]);

  const changeIncludeAudio = useCallback((enabled) => {
    setIncludeAudio(enabled);
    if (!enabled) setTab('video');
    else if (syncAudio && videoSource?.audioSupported) setAudioSource(videoSource);
    else if (videoSource && !videoSource.audioSupported) setSyncAudio(false);
  }, [syncAudio, videoSource]);

  const changeSyncAudio = useCallback((enabled) => {
    if (enabled && videoSource && !videoSource.audioSupported) {
      setSyncAudio(false);
      setAudioSource(null);
      return;
    }
    setSyncAudio(enabled);
    if (enabled) {
      setAudioSource(videoSource?.audioSupported ? videoSource : null);
      setTab('video');
    }
  }, [videoSource]);

  useEffect(() => () => {
    const session = screenAudioSessionRef.current;
    screenAudioSessionRef.current = null;
    void session?.stop();
  }, [screenAudioSessionRef]);

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const closeOnEscape = (event) => { if (event.key === 'Escape') cancelPicker(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [cancelPicker, pickerOpen]);

  return {
    audioSource,
    cancelPicker,
    changeIncludeAudio,
    changeSyncAudio,
    chooseVideoSource,
    includeAudio,
    loading,
    mediaCapabilities,
    pickerOpen,
    setAudioSource,
    setTab,
    sources,
    startScreenShare,
    stopAudioSession,
    stopScreenShare,
    syncAudio,
    tab,
    toggleScreenShare,
    videoSource,
  };
}

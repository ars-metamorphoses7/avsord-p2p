import { useCallback, useEffect, useState } from 'react';
import { createCallAudioMixer, createDesktopAudioBridge } from '../media/desktopAudio.js';
import { screenCaptureConstraints, screenShareProfile } from '../media/screenShareProfiles.js';

export function useScreenShare({
  announceCallState,
  audioStreamRef,
  cameraStreamRef,
  inCallRef,
  outboundAudioStreamRef,
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

  const stopAudioSession = useCallback(async ({ restoreMicrophone = true } = {}) => {
    const session = screenAudioSessionRef.current;
    screenAudioSessionRef.current = null;
    if (session) await session.stop();
    if (restoreMicrophone) {
      const microphoneStream = audioStreamRef.current;
      outboundAudioStreamRef.current = microphoneStream;
      await replacePeerTrack('audioSender', microphoneStream?.getAudioTracks?.()[0] || null);
    }
  }, [audioStreamRef, outboundAudioStreamRef, replacePeerTrack, screenAudioSessionRef]);

  const stopScreenShare = useCallback(() => {
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    cancelPicker();
    void stopAudioSession();
    const fallbackTrack = cameraStreamRef.current?.getVideoTracks()[0] || null;
    void replacePeerTrack('videoSender', fallbackTrack);
    setIsSharing(false);
    announceCallState({ sharing: false, sharingAudio: false });
  }, [announceCallState, cameraStreamRef, cancelPicker, replacePeerTrack, screenStreamRef, setIsSharing, stopAudioSession]);

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
    let mixer = null;
    try {
      const profile = screenShareProfile(selectedProfile);
      videoStream = desktopCapture
        ? await navigator.mediaDevices.getUserMedia({ audio: false, video: screenCaptureConstraints(selectedProfile, selectedVideo.id) })
        : await navigator.mediaDevices.getDisplayMedia({ video: screenCaptureConstraints(selectedProfile), audio: false });
      const videoTrack = videoStream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('Nenhuma faixa de vídeo foi criada.');
      videoTrack.contentHint = profile.contentHint;
      await videoTrack.applyConstraints?.({ frameRate: { ideal: profile.frameRate, max: profile.frameRate } }).catch(() => {});
      setProfileId(selectedProfile);
      await setVideoEncodingProfile(selectedProfile);

      if (withAudio) {
        if (!desktopCapture || !selectedAudio) throw new Error('Escolha uma fonte de áudio válida.');
        audioBridge = await createDesktopAudioBridge(desktop, {
          processId: selectedAudio.processId || 0,
          type: selectedAudio.type,
          systemAudio: selectedAudio.type === 'screen',
        });
        mixer = await createCallAudioMixer(audioStreamRef.current, audioBridge.stream);
        const mixedTrack = mixer.stream.getAudioTracks()[0];
        outboundAudioStreamRef.current = mixer.stream;
        if (!(await replacePeerTrack('audioSender', mixedTrack))) throw new Error('Não foi possível enviar o áudio compartilhado aos participantes.');
        screenAudioSessionRef.current = {
          bridge: audioBridge,
          mixer,
          async stop() {
            await mixer.stop();
            await audioBridge.stop();
          },
        };
      }

      screenStreamRef.current = videoStream;
      if (!(await replacePeerTrack('videoSender', videoTrack))) throw new Error('Não foi possível enviar a tela aos participantes.');
      videoTrack.onended = () => {
        if (screenStreamRef.current === videoStream) stopScreenShare();
      };
      setIsSharing(true);
      announceCallState({ sharing: true, sharingAudio: withAudio });
      return true;
    } catch (error) {
      videoStream?.getTracks().forEach((track) => track.stop());
      if (screenStreamRef.current === videoStream) screenStreamRef.current = null;
      if (mixer || audioBridge) {
        await mixer?.stop().catch(() => {});
        await audioBridge?.stop().catch(() => {});
        screenAudioSessionRef.current = null;
        outboundAudioStreamRef.current = audioStreamRef.current;
        await replacePeerTrack('audioSender', audioStreamRef.current?.getAudioTracks?.()[0] || null);
      }
      if (error?.name !== 'AbortError') setPermissionError(error?.message || 'Não foi possível iniciar o compartilhamento de tela.');
      return false;
    }
  }, [announceCallState, audioStreamRef, cancelPicker, outboundAudioStreamRef, profileId, replacePeerTrack, screenAudioSessionRef, screenStreamRef, setIsSharing, setPermissionError, setProfileId, setVideoEncodingProfile, stopScreenShare]);

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
    if (syncAudio) setAudioSource(source.audioSupported ? source : null);
  }, [syncAudio]);

  const changeIncludeAudio = useCallback((enabled) => {
    setIncludeAudio(enabled);
    if (!enabled) setTab('video');
    else if (syncAudio && videoSource?.audioSupported) setAudioSource(videoSource);
  }, [syncAudio, videoSource]);

  const changeSyncAudio = useCallback((enabled) => {
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

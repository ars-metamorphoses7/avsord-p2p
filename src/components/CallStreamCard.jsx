import { EyeOff, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { startVideoFrameCollector } from '../media/videoFrameCollector.js';

const MIN_STREAM_ZOOM = 1;
const MAX_STREAM_ZOOM = 4;
const STREAM_ZOOM_STEP = 0.25;

function telemetryStore() {
  if (!new URLSearchParams(window.location.search).has('streamTelemetry')) return null;
  globalThis.__jumpStreamTelemetry ||= { version: 1, capture: null, events: [], render: {} };
  return globalThis.__jumpStreamTelemetry;
}

export function MediaElement({ stream, muted = false, volume = 1, sinkId = '', className = '', showVideo, diagnosticsSession = null }) {
  const mediaRef = useRef(null);
  const hasVideo = showVideo ?? Boolean(stream?.getVideoTracks?.().length);

  useEffect(() => {
    if (!mediaRef.current || !stream) return undefined;
    const media = mediaRef.current;
    media.srcObject = stream;
    media.muted = Boolean(muted);
    media.volume = muted ? 0 : Math.max(0, Math.min(1, Number(volume) || 0));
    if (sinkId && typeof media.setSinkId === 'function') media.setSinkId(sinkId).catch(() => {});
    const play = () => media.play?.().catch(() => {});
    media.addEventListener('loadedmetadata', play);
    const store = hasVideo ? telemetryStore() : null;
    const stopVideoFrameCollector = hasVideo ? startVideoFrameCollector({
      media,
      streamId: stream.id || 'unknown-video-stream',
      store,
      diagnosticsSession,
    }) : undefined;
    play();
    return () => {
      stopVideoFrameCollector?.();
      media.removeEventListener('loadedmetadata', play);
    };
  }, [stream, hasVideo, muted, sinkId, volume, diagnosticsSession]);

  if (!stream) return null;
  const props = {
    ref: mediaRef,
    className: `${className} ${hasVideo ? 'media-visible' : 'media-audio-only'}`,
    autoPlay: true,
    playsInline: true,
    muted,
  };
  return hasVideo ? <video {...props} /> : <audio {...props} />;
}

export function CallStreamCard({
  avatar,
  diagnosticsSession,
  hasVideo,
  isDeafened,
  isFocused,
  isSelf,
  isSharing,
  isSharingAudio,
  isSpeaking,
  isWatching,
  label,
  microphoneStream,
  onContextMenu,
  onDoubleClick,
  onWatchingChange,
  screenAudioStream,
  sinkId,
  stateLabel,
  streamVolume = 1,
  videoStream,
  voiceVolume = 1,
}) {
  const showPausedShare = !isSelf && isSharing && !isWatching;
  const [streamZoom, setStreamZoom] = useState({ scale: MIN_STREAM_ZOOM, originX: 50, originY: 50 });

  useEffect(() => {
    if (!isFocused || !isSharing || !hasVideo || showPausedShare) {
      setStreamZoom({ scale: MIN_STREAM_ZOOM, originX: 50, originY: 50 });
    }
  }, [hasVideo, isFocused, isSharing, showPausedShare]);

  const changeStreamZoom = useCallback((event) => {
    if (!isFocused || !isSharing || !hasVideo || showPausedShare || !event.deltaY) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const originX = bounds.width > 0 ? Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100)) : 50;
    const originY = bounds.height > 0 ? Math.max(0, Math.min(100, ((event.clientY - bounds.top) / bounds.height) * 100)) : 50;
    const direction = event.deltaY < 0 ? 1 : -1;
    setStreamZoom((current) => {
      const scale = Math.max(MIN_STREAM_ZOOM, Math.min(MAX_STREAM_ZOOM, Number((current.scale + direction * STREAM_ZOOM_STEP).toFixed(2))));
      return scale === MIN_STREAM_ZOOM
        ? { scale, originX: 50, originY: 50 }
        : { scale, originX, originY };
    });
  }, [hasVideo, isFocused, isSharing, showPausedShare]);

  return (
    <article
      className={`call-stream-card ${isSelf ? 'is-self' : ''} ${isFocused ? 'is-focused' : ''} ${showPausedShare ? 'is-paused' : ''}`}
      onContextMenu={onContextMenu}
    >
      <div
        className={`call-stream-viewport ${hasVideo && isSpeaking ? 'is-speaking' : ''}`}
        onDoubleClick={onDoubleClick}
        onWheel={changeStreamZoom}
        title={isFocused && isSharing ? 'use a roda do mouse para aplicar zoom · clique duas vezes para restaurar' : 'clique duas vezes para maximizar/restaurar'}
      >
        {hasVideo && !showPausedShare ? (
          <div
            className="call-stream-media-frame"
            style={{
              '--stream-zoom': streamZoom.scale,
              '--stream-origin-x': `${streamZoom.originX}%`,
              '--stream-origin-y': `${streamZoom.originY}%`,
            }}
          >
            <MediaElement stream={videoStream} muted sinkId={sinkId} className="call-stream-media" showVideo diagnosticsSession={diagnosticsSession} />
          </div>
        ) : showPausedShare ? (
          <div className="call-stream-paused">
            {avatar}
            <strong>transmissão pausada</strong>
            <button type="button" onClick={(event) => { event.stopPropagation(); onWatchingChange?.(true); }}><Play size={14} fill="currentColor" /> assistir transmissão</button>
          </div>
        ) : avatar}

        {!isSelf && isSharing && isWatching && (
          <button type="button" className="call-stream-watch-toggle" onClick={(event) => { event.stopPropagation(); onWatchingChange?.(false); }} title="Parar de receber vídeo e áudio desta transmissão"><EyeOff size={13} /> parar de assistir</button>
        )}

        {!isSelf && microphoneStream && (
          <MediaElement stream={microphoneStream} muted={isDeafened} volume={voiceVolume} sinkId={sinkId} className="call-stream-audio" showVideo={false} />
        )}
        {!isSelf && screenAudioStream && isSharingAudio && isWatching && (
          <MediaElement stream={screenAudioStream} muted={isDeafened} volume={streamVolume} sinkId={sinkId} className="call-stream-audio call-stream-share-audio" showVideo={false} />
        )}
        {isFocused && isSharing && hasVideo && !showPausedShare && (
          <div className="call-stream-zoom-indicator" aria-live="polite">zoom {Math.round(streamZoom.scale * 100)}%</div>
        )}
      </div>
      <div className="call-stream-caption"><strong>{label}</strong><small>{stateLabel}</small></div>
    </article>
  );
}

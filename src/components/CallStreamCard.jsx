import { EyeOff, Play } from 'lucide-react';
import { useEffect, useRef } from 'react';

export function MediaElement({ stream, muted = false, volume = 1, sinkId = '', className = '', showVideo }) {
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
    play();
    return () => media.removeEventListener('loadedmetadata', play);
  }, [stream, hasVideo, muted, sinkId, volume]);

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
  return (
    <article
      className={`call-stream-card ${isSelf ? 'is-self' : ''} ${isFocused ? 'is-focused' : ''} ${showPausedShare ? 'is-paused' : ''}`}
      onContextMenu={onContextMenu}
    >
      <div
        className={`call-stream-viewport ${hasVideo && isSpeaking ? 'is-speaking' : ''}`}
        onDoubleClick={onDoubleClick}
        title="clique duas vezes para maximizar/restaurar"
      >
        {hasVideo && !showPausedShare ? (
          <MediaElement stream={videoStream} muted sinkId={sinkId} className="call-stream-media" showVideo />
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
      </div>
      <div className="call-stream-caption"><strong>{label}</strong><small>{stateLabel}</small></div>
    </article>
  );
}

import { EyeOff, Play } from 'lucide-react';
import { useEffect, useRef } from 'react';

function telemetryStore() {
  if (!new URLSearchParams(window.location.search).has('streamTelemetry')) return null;
  globalThis.__jumpStreamTelemetry ||= { version: 1, capture: null, events: [], render: {} };
  return globalThis.__jumpStreamTelemetry;
}

function finiteMetric(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

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
    let videoFrameHandle = 0;
    let cancelled = false;
    const store = hasVideo ? telemetryStore() : null;
    if (store && typeof media.requestVideoFrameCallback === 'function') {
      const streamId = stream.id || 'unknown-video-stream';
      // A MediaElement can unmount while a share is paused and later mount
      // again with the same MediaStream id. Start a new sampling session so
      // the pause is not misreported as one enormous frame interval.
      const record = {
        streamId,
        sessionId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        startedAtMs: Date.now(),
        frames: 0,
        samples: [],
      };
      store.render[streamId] = record;
      const onVideoFrame = (now, metadata = {}) => {
        if (cancelled) return;
        const previous = record.samples.at(-1);
        const expectedDisplayTime = finiteMetric(metadata.expectedDisplayTime);
        const captureTime = finiteMetric(metadata.captureTime);
        const receiveTime = finiteMetric(metadata.receiveTime);
        const sample = {
          timestampMs: performance.timeOrigin + now,
          intervalMs: previous ? now - previous.callbackNow : null,
          callbackNow: now,
          presentedFrames: finiteMetric(metadata.presentedFrames),
          width: finiteMetric(metadata.width),
          height: finiteMetric(metadata.height),
          processingDurationMs: finiteMetric(metadata.processingDuration) === null
            ? null : Number(metadata.processingDuration) * 1000,
          networkMs: captureTime === null || receiveTime === null ? null : receiveTime - captureTime,
          captureToCompositorMs: captureTime === null || expectedDisplayTime === null
            ? null : expectedDisplayTime - captureTime,
          postReceiveMs: receiveTime === null || expectedDisplayTime === null
            ? null : expectedDisplayTime - receiveTime,
          compositorLatenessMs: expectedDisplayTime === null ? null : now - expectedDisplayTime,
          rtpTimestamp: finiteMetric(metadata.rtpTimestamp),
        };
        record.frames += 1;
        record.last = sample;
        record.samples.push(sample);
        if (record.samples.length > 7_200) record.samples.shift();
        videoFrameHandle = media.requestVideoFrameCallback(onVideoFrame);
      };
      videoFrameHandle = media.requestVideoFrameCallback(onVideoFrame);
    }
    play();
    return () => {
      cancelled = true;
      if (videoFrameHandle && typeof media.cancelVideoFrameCallback === 'function') {
        media.cancelVideoFrameCallback(videoFrameHandle);
      }
      media.removeEventListener('loadedmetadata', play);
    };
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

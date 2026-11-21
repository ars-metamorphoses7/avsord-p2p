import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PixelIcon } from './Win98Icons.jsx';

// YouTube blocks most embeds (error 150) on pages served from an IP address,
// and the JUMP window runs on 127.0.0.1. The player therefore lives in
// public/youtube-player.html, framed from "localhost", and is driven over
// postMessage through this small proxy with the YT.Player method names.
function playerOrigin() {
  const { protocol, hostname, port, origin } = window.location;
  const ipHost = /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':') || hostname.startsWith('[');
  return ipHost ? `${protocol}//localhost${port ? `:${port}` : ''}` : origin;
}

function readStoredMusicVolume() {
  const raw = localStorage.getItem('jump-music-volume');
  if (raw === null || raw === '') return 50;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 50;
}

function applyPlayerAudio(player, volume, deafened) {
  if (!player || typeof player.setVolume !== 'function') return;
  const level = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
  if (deafened || level <= 0) {
    player.setVolume(0);
    player.mute();
  } else {
    player.unMute();
    player.setVolume(level);
  }
}

function formatPlaybackTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function createPlayer(container, events) {
  const origin = playerOrigin();
  const frame = document.createElement('iframe');
  frame.src = `${origin}/youtube-player.html`;
  frame.title = 'Player do YouTube';
  frame.allow = 'autoplay; encrypted-media; picture-in-picture';
  frame.style.cssText = 'width:100%;height:100%;border:0;display:block';
  let currentTime = 0;
  let duration = 0;
  let loaded = false;
  const timer = setTimeout(() => { if (!loaded) events.onLoadError?.('O YouTube não respondeu. Tente novamente.'); }, 20000);
  const onMessage = event => {
    if (event.source !== frame.contentWindow || event.origin !== origin || !event.data?.jumpYouTube) return;
    const { type, value, duration: reportedDuration } = event.data;
    if (type === 'time') {
      currentTime = Number(value) || 0;
      if (Number.isFinite(Number(reportedDuration)) && Number(reportedDuration) > 0) {
        duration = Number(reportedDuration);
      }
      events.onTime?.(currentTime, duration);
    } else if (type === 'ready') {
      loaded = true;
      clearTimeout(timer);
      events.onReady?.();
    } else if (type === 'state') events.onStateChange?.({ data: value });
    else if (type === 'error') events.onError?.({ data: value });
    else if (type === 'autoplayBlocked') events.onAutoplayBlocked?.();
    else if (type === 'loadError') { clearTimeout(timer); events.onLoadError?.('Não foi possível carregar o YouTube.'); }
  };
  window.addEventListener('message', onMessage);
  container.appendChild(frame);
  const call = method => (...args) => frame.contentWindow?.postMessage({ jumpYouTube: true, method, args }, origin);
  return {
    setVolume: call('setVolume'), mute: call('mute'), unMute: call('unMute'),
    loadVideoById: (options) => { currentTime = options.startSeconds || 0; duration = 0; call('loadVideoById')(options); },
    cueVideoById: (options) => { currentTime = options.startSeconds || 0; duration = 0; call('cueVideoById')(options); },
    seekTo: (seconds, allowSeekAhead) => { currentTime = seconds; call('seekTo')(seconds, allowSeekAhead); },
    playVideo: call('playVideo'), pauseVideo: call('pauseVideo'),
    getCurrentTime: () => currentTime,
    getDuration: () => duration,
    destroy: () => { clearTimeout(timer); window.removeEventListener('message', onMessage); frame.remove(); },
  };
}

export function MusicBot({
  music,
  deafened,
  send,
  error,
  withoutJukebox = [],
  viewMode = 'music',
  onViewModeChange,
  stageCardRef,
  stageSlotRef,
  isStageFocused = false,
  onToggleStageFocus,
  layoutKey = '',
}) {
  const [url, setUrl] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [volume, setVolume] = useState(readStoredMusicVolume);
  const lastAudibleVolumeRef = useRef(volume > 0 ? volume : 50);
  const [playerError, setPlayerError] = useState('');
  const [retry, setRetry] = useState(0);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const [seekingPosition, setSeekingPosition] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hudVisible, setHudVisible] = useState(true);
  const [dockRect, setDockRect] = useState(null);
  const host = useRef(null);
  const layerRef = useRef(null);
  const miniSlotRef = useRef(null);
  const hudTimerRef = useRef(null);
  const player = useRef(null);
  const [playerState, setPlayerState] = useState(-1);
  const syncNow = useRef(() => {});
  const latest = useRef({ music, deafened, volume, send });
  latest.current = { music, deafened, volume, send };
  const track = music?.queue?.[0];
  const isVideoMode = viewMode === 'video';

  const commitVolume = useCallback((nextValue) => {
    const clamped = Math.max(0, Math.min(100, Math.round(Number(nextValue) || 0)));
    if (clamped > 0) lastAudibleVolumeRef.current = clamped;
    setVolume(clamped);
    localStorage.setItem('jump-music-volume', String(clamped));
  }, []);

  const toggleQuickMute = useCallback(() => {
    if (volume <= 0) {
      commitVolume(lastAudibleVolumeRef.current || 50);
    } else {
      lastAudibleVolumeRef.current = volume;
      commitVolume(0);
    }
  }, [commitVolume, volume]);

  const toggleBorderlessFullscreen = useCallback((event) => {
    event?.stopPropagation?.();
    const target = layerRef.current;
    if (!target) return;
    if (document.fullscreenElement === target) {
      document.exitFullscreen?.().catch(() => {});
      return;
    }
    target.requestFullscreen?.().catch(() => {});
  }, []);

  useEffect(() => {
    const syncFullscreen = () => {
      const active = Boolean(layerRef.current && document.fullscreenElement === layerRef.current);
      setIsFullscreen(active);
      if (active) setHudVisible(true);
    };
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  useEffect(() => {
    if (isFullscreen && !track) {
      document.exitFullscreen?.().catch(() => {});
    }
  }, [isFullscreen, track]);

  useEffect(() => {
    if (!isFullscreen) {
      if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
      setHudVisible(true);
      return undefined;
    }
    hudTimerRef.current = setTimeout(() => setHudVisible(false), 2600);
    return () => {
      if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    };
  }, [isFullscreen]);

  const revealFullscreenHud = useCallback(() => {
    if (!isFullscreen) return;
    setHudVisible(true);
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    hudTimerRef.current = setTimeout(() => setHudVisible(false), 2600);
  }, [isFullscreen]);

  useEffect(() => {
    if (!track) {
      setPlaybackTime(0);
      setPlaybackDuration(0);
      setSeekingPosition(null);
      return;
    }
    let disposed = false;
    let ready = false;
    let loadedKey = '';
    setPlayerError('');
    const synchronize = () => {
      if (!ready || !player.current) return;
      const { music: state, deafened: muted, volume: level } = latest.current;
      const current = state?.queue?.[0];
      if (!current) return;
      const position = state.position + (state.playing ? Math.max(0, Date.now() - state.receivedAt + state.serverNow - state.updatedAt) / 1000 : 0);
      const p = player.current;
      applyPlayerAudio(p, level, muted);
      if (loadedKey !== current.key) {
        loadedKey = current.key;
        setPlayerError('');
        setPlaybackTime(position);
        setPlaybackDuration(0);
        if (state.playing) p.loadVideoById({ videoId: current.id, startSeconds: position });
        else p.cueVideoById({ videoId: current.id, startSeconds: position });
      } else if (Math.abs(p.getCurrentTime() - position) > 3) {
        p.seekTo(position, true);
      }
      if (state.playing) p.playVideo(); else p.pauseVideo();
    };
    syncNow.current = synchronize;
    player.current = createPlayer(host.current, {
      onReady: () => { ready = true; synchronize(); },
      onTime: (time, duration) => {
        if (disposed) return;
        setPlaybackTime(time);
        if (duration > 0) setPlaybackDuration(duration);
      },
      onLoadError: message => { if (!disposed) setPlayerError(message); },
      onAutoplayBlocked: () => {
        setPlayerError('Clique no play do vídeo para ativar o áudio neste computador.');
        setExpanded(true);
      },
      onError: event => setPlayerError(`YouTube indisponível para este vídeo (erro ${event.data}). Você pode pular para o próximo.`),
      onStateChange: event => {
        if (event.data === 0 && loadedKey === latest.current.music?.queue?.[0]?.key) latest.current.send({ action: 'ended', key: loadedKey });
        setPlayerState(event.data);
        if (event.data === 1 || event.data === 3) {
          applyPlayerAudio(player.current, latest.current.volume, latest.current.deafened);
        }
        if (event.data === 1) setPlayerError('');
      },
    });
    const timer = setInterval(synchronize, 2000);
    return () => { disposed = true; syncNow.current = () => {}; clearInterval(timer); player.current?.destroy(); player.current = null; };
  }, [Boolean(track), retry]);

  // Apply pause/skip/seek from anyone in the room right away instead of
  // waiting for the 2 s drift check.
  useEffect(() => { syncNow.current(); }, [music?.revision, music?.receivedAt]);
  useEffect(() => {
    applyPlayerAudio(player.current, volume, deafened);
  }, [volume, deafened]);

  // Keep the single YouTube iframe aligned with either the stage video card slot
  // (Watch Together mode) or the mini preview slot (expanded music mode) without
  // ever reparenting or reloading the iframe.
  useLayoutEffect(() => {
    if (!track || isFullscreen) {
      setDockRect(null);
      return undefined;
    }
    const measure = () => {
      const stageEl = stageCardRef?.current;
      const targetEl = isVideoMode ? stageSlotRef?.current : (expanded ? miniSlotRef.current : null);
      if (!stageEl || !targetEl) {
        setDockRect(null);
        return;
      }
      const stageRect = stageEl.getBoundingClientRect();
      const targetRect = targetEl.getBoundingClientRect();
      if (targetRect.width < 20 || targetRect.height < 20) {
        setDockRect(null);
        return;
      }
      const next = {
        left: Math.round(targetRect.left - stageRect.left),
        top: Math.round(targetRect.top - stageRect.top),
        width: Math.round(targetRect.width),
        height: Math.round(targetRect.height),
      };
      setDockRect((current) => (
        current
        && current.left === next.left
        && current.top === next.top
        && current.width === next.width
        && current.height === next.height
          ? current
          : next
      ));
    };

    measure();
    const raf = window.requestAnimationFrame(measure);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (observer) {
      if (stageCardRef?.current) observer.observe(stageCardRef.current);
      if (stageSlotRef?.current) observer.observe(stageSlotRef.current);
      if (miniSlotRef.current) observer.observe(miniSlotRef.current);
    }
    const stageBody = stageCardRef?.current?.querySelector('.stage-body');
    stageBody?.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      window.cancelAnimationFrame(raf);
      observer?.disconnect();
      stageBody?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [track, isVideoMode, expanded, isFullscreen, layoutKey, stageCardRef, stageSlotRef]);

  const handleModeSelect = useCallback((nextMode) => {
    onViewModeChange?.(nextMode);
  }, [onViewModeChange]);

  const handleSeekCommit = useCallback((seconds) => {
    setSeekingPosition(null);
    const target = Math.max(0, Number(seconds) || 0);
    setPlaybackTime(target);
    send({ action: 'seek', position: target });
  }, [send]);

  const trackTitle = track ? (track.title || track.id) : '';
  const modeBadge = isVideoMode ? 'Vídeo' : 'Música';
  const statusText = track
    ? `${music.playing ? 'Tocando' : 'Pausado'}: ${trackTitle}`
    : 'Pronto';
  const displayedTime = seekingPosition !== null ? seekingPosition : playbackTime;
  const isMutedEffectively = deafened || volume <= 0;
  const dockedOnStage = Boolean(track && isVideoMode && dockRect && !isFullscreen);
  const dockedInMini = Boolean(track && !isVideoMode && expanded && dockRect && !isFullscreen);
  const playerVisible = isFullscreen || dockedOnStage || dockedInMini;

  return (
    <section className={`music-bot ${expanded ? 'is-expanded' : 'is-collapsed'} ${isVideoMode ? 'is-video-mode' : 'is-music-mode'}`} aria-label="JUMP Jukebox" data-player-state={playerState}>
      {track && (
        <div
          ref={layerRef}
          className={`jukebox-player-layer ${isFullscreen ? 'is-borderless-fullscreen' : ''} ${dockedOnStage ? 'is-on-stage' : ''} ${dockedInMini ? 'is-in-mini' : ''} ${!playerVisible ? 'is-offstage' : ''} ${isFullscreen && !hudVisible ? 'is-hud-idle' : ''}`}
          style={!isFullscreen && dockRect ? {
            left: `${dockRect.left}px`,
            top: `${dockRect.top}px`,
            width: `${dockRect.width}px`,
            height: `${dockRect.height}px`,
          } : undefined}
          onMouseMove={revealFullscreenHud}
        >
          <div className="music-player" ref={host} />

          {(dockedOnStage || isFullscreen) && (
            <div className={`jukebox-stage-overlay-actions ${isFullscreen ? 'is-fullscreen-hud' : ''}`}>
              {!isFullscreen && onToggleStageFocus && (
                <button
                  type="button"
                  className="jukebox-overlay-btn"
                  onClick={onToggleStageFocus}
                  title={isStageFocused ? 'Restaurar grade da chamada' : 'Maximizar vídeo no palco'}
                >
                  <PixelIcon name={isStageFocused ? 'restore' : 'maximize'} size={14} />
                  <span>{isStageFocused ? 'restaurar' : 'maximizar'}</span>
                </button>
              )}
              <button
                type="button"
                className="jukebox-overlay-btn"
                onClick={toggleBorderlessFullscreen}
                title={isFullscreen ? 'Sair da tela cheia sem bordas (Esc)' : 'Tela cheia sem bordas'}
              >
                <PixelIcon name={isFullscreen ? 'fullscreen-exit' : 'fullscreen'} size={14} />
                <span>{isFullscreen ? 'sair da tela cheia' : 'tela cheia'}</span>
              </button>
              {!isFullscreen && (
                <button
                  type="button"
                  className="jukebox-overlay-btn"
                  onClick={() => handleModeSelect('music')}
                  title="Voltar para modo somente música"
                >
                  <PixelIcon name="music" size={14} />
                  <span>só música</span>
                </button>
              )}
            </div>
          )}

          {isFullscreen && (
            <div className="jukebox-fullscreen-hud is-fullscreen-hud">
              <div className="jukebox-fullscreen-title">
                <PixelIcon name="tv" size={15} />
                <strong>{trackTitle}</strong>
                {track.by && <small>por {track.by}</small>}
              </div>
              {playbackDuration > 0 && (
                <div className="jukebox-seek-bar">
                  <span className="jukebox-time">{formatPlaybackTime(displayedTime)}</span>
                  <input
                    aria-label="Posição do vídeo"
                    type="range"
                    min="0"
                    max={Math.floor(playbackDuration)}
                    step="1"
                    value={Math.min(Math.floor(playbackDuration), Math.floor(displayedTime))}
                    onChange={(event) => setSeekingPosition(Number(event.target.value))}
                    onMouseUp={(event) => handleSeekCommit(event.currentTarget.value)}
                    onTouchEnd={(event) => handleSeekCommit(event.currentTarget.value)}
                    onKeyUp={(event) => handleSeekCommit(event.currentTarget.value)}
                  />
                  <span className="jukebox-time">{formatPlaybackTime(playbackDuration)}</span>
                </div>
              )}
              <div className="jukebox-fullscreen-controls">
                <button type="button" onClick={() => send({ action: music.playing ? 'pause' : 'play' })}>
                  <PixelIcon name={music?.playing ? 'pause' : 'play'} size={13} />
                  <span>{music?.playing ? 'Pausar' : 'Tocar'}</span>
                </button>
                <button type="button" onClick={() => send({ action: 'skip', key: track.key })}>
                  <PixelIcon name="next" size={13} />
                  <span>Próximo</span>
                </button>
                <div className="music-volume-control">
                  <button
                    type="button"
                    className="music-mute-btn"
                    onClick={toggleQuickMute}
                    title={isMutedEffectively ? 'Ativar som da Jukebox' : 'Silenciar Jukebox (0%)'}
                    aria-label={isMutedEffectively ? 'Ativar som da Jukebox' : 'Silenciar Jukebox'}
                  >
                    <PixelIcon name={isMutedEffectively ? 'volume-off' : 'volume'} size={14} />
                  </button>
                  <input
                    aria-label="Volume da música em tela cheia"
                    type="range"
                    min="0"
                    max="100"
                    value={volume}
                    onChange={event => commitVolume(event.target.value)}
                  />
                  <output>{volume}%</output>
                </div>
                <button type="button" onClick={toggleBorderlessFullscreen}>
                  <PixelIcon name="fullscreen-exit" size={13} />
                  <span>Sair (Esc)</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="music-header-bar music-titlebar">
        <button
          type="button"
          className="music-toggle-strip"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          title={expanded ? 'Recolher Jukebox' : 'Abrir Jukebox'}
        >
          <PixelIcon name={isVideoMode ? 'tv' : 'music'} size={15} />
          <strong>JUMP Jukebox</strong>
          <span className="music-mode-pill">{modeBadge}</span>
          <span className="music-strip-status">{statusText}</span>
        </button>
        <div className="music-mini-actions">
          <div className="music-mode-switch" role="group" aria-label="Modo do Jukebox">
            <button
              type="button"
              className={`music-mode-btn ${!isVideoMode ? 'is-active' : ''}`}
              aria-pressed={!isVideoMode}
              onClick={() => handleModeSelect('music')}
              title="Modo só música (compacto)"
            >
              <PixelIcon name="music" size={13} />
              <span>Música</span>
            </button>
            <button
              type="button"
              className={`music-mode-btn ${isVideoMode ? 'is-active' : ''}`}
              aria-pressed={isVideoMode}
              onClick={() => handleModeSelect('video')}
              title="Assistir vídeo juntos como participante no palco"
            >
              <PixelIcon name="tv" size={13} />
              <span>Vídeo</span>
            </button>
          </div>
          {!expanded && track && (
            <>
              <button type="button" className="music-mini-btn" onClick={() => send({ action: music.playing ? 'pause' : 'play' })} title={music?.playing ? 'Pausar' : 'Tocar'} aria-label={music?.playing ? 'Pausar' : 'Tocar'}>
                <PixelIcon name={music?.playing ? 'pause' : 'play'} size={13} />
              </button>
              <button type="button" className="music-mini-btn" onClick={() => send({ action: 'skip', key: track.key })} title="Próxima" aria-label="Próxima">
                <PixelIcon name="next" size={13} />
              </button>
              {isVideoMode && (
                <button type="button" className="music-mini-btn" onClick={toggleBorderlessFullscreen} title="Tela cheia sem bordas" aria-label="Tela cheia sem bordas">
                  <PixelIcon name="fullscreen" size={13} />
                </button>
              )}
            </>
          )}
          <button
            type="button"
            className="music-expand-btn"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <PixelIcon name={expanded ? 'chevron-down' : 'chevron-up'} size={13} />
            <span>{expanded ? 'Recolher' : 'Abrir'}</span>
          </button>
        </div>
      </div>

      {expanded && (
        <div className="music-body">
          {track && !isVideoMode && (
            <div className="music-player-slot" ref={miniSlotRef} aria-label="Prévia do player do YouTube" />
          )}
          <div className="music-controls">
            <form onSubmit={event => { event.preventDefault(); if (send({ action: 'add', url, mode: viewMode })) setUrl(''); }}>
              <div className="music-row">
                <input
                  id="music-url"
                  aria-label="Adicionar link do YouTube à fila"
                  type="url"
                  required
                  maxLength={2048}
                  placeholder={isVideoMode ? 'Cole um link do YouTube para assistir juntos no palco...' : 'Cole um link do YouTube para ouvir com a chamada...'}
                  value={url}
                  onChange={event => setUrl(event.target.value)}
                />
                <button type="submit">Adicionar</button>
              </div>
            </form>
            <div className="music-row music-transport-row">
              <button type="button" disabled={!track} onClick={() => send({ action: music.playing ? 'pause' : 'play' })}>
                <PixelIcon name={music?.playing ? 'pause' : 'play'} size={13} /> {music?.playing ? 'Pausar' : 'Tocar'}
              </button>
              <button type="button" disabled={!track} onClick={() => send({ action: 'skip', key: track.key })}>
                <PixelIcon name="next" size={13} /> Próxima
              </button>
              <button type="button" disabled={!track} onClick={() => send({ action: 'stop' })}>
                <PixelIcon name="stop" size={13} /> Limpar
              </button>
              {track && isVideoMode && (
                <button type="button" onClick={toggleBorderlessFullscreen} title="Abrir vídeo em tela cheia sem bordas">
                  <PixelIcon name="fullscreen" size={13} /> Tela cheia
                </button>
              )}
              <div className="music-volume-control" title="Volume local (só para você)">
                <button
                  type="button"
                  className="music-mute-btn"
                  onClick={toggleQuickMute}
                  title={isMutedEffectively ? 'Ativar som da Jukebox' : 'Silenciar Jukebox (0%)'}
                  aria-label={isMutedEffectively ? 'Ativar som da Jukebox' : 'Silenciar Jukebox'}
                >
                  <PixelIcon name={isMutedEffectively ? 'volume-off' : 'volume'} size={14} />
                </button>
                <span>Volume</span>
                <input
                  aria-label="Volume da música"
                  type="range"
                  min="0"
                  max="100"
                  value={volume}
                  onChange={event => commitVolume(event.target.value)}
                />
                <output>{volume}%</output>
              </div>
            </div>
            {track && playbackDuration > 0 && (
              <div className="jukebox-seek-bar">
                <span className="jukebox-time">{formatPlaybackTime(displayedTime)}</span>
                <input
                  aria-label="Linha do tempo do vídeo"
                  type="range"
                  min="0"
                  max={Math.floor(playbackDuration)}
                  step="1"
                  value={Math.min(Math.floor(playbackDuration), Math.floor(displayedTime))}
                  onChange={(event) => setSeekingPosition(Number(event.target.value))}
                  onMouseUp={(event) => handleSeekCommit(event.currentTarget.value)}
                  onTouchEnd={(event) => handleSeekCommit(event.currentTarget.value)}
                  onKeyUp={(event) => handleSeekCommit(event.currentTarget.value)}
                />
                <span className="jukebox-time">{formatPlaybackTime(playbackDuration)}</span>
              </div>
            )}
            {track && (
              <p className="music-now-playing">
                {music.queue.length} vídeo(s) na fila · atual: <strong>{trackTitle}</strong>{track.by ? ` (por ${track.by})` : ''}
              </p>
            )}
            {music?.queue?.length > 1 && (
              <ol className="music-queue">
                {music.queue.slice(1).map(item => <li key={item.key}>{item.title || item.id}{item.by ? ` — ${item.by}` : ''}</li>)}
              </ol>
            )}
            {withoutJukebox.length > 0 && (
              <p role="status" className="music-warning">
                {withoutJukebox.join(', ')} {withoutJukebox.length > 1 ? 'estão' : 'está'} sem o Jukebox nesta versão.
              </p>
            )}
            {(error || playerError) && (
              <p role="alert" className="music-error">
                {error || playerError}{' '}
                {playerError && <button type="button" onClick={() => setRetry(value => value + 1)}>Tentar novamente</button>}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

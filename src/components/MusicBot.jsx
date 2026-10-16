import { useEffect, useRef, useState } from 'react';

let apiPromise;
function loadYouTube() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise) apiPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => { script.remove(); apiPromise = null; reject(new Error('O YouTube não respondeu. Tente novamente.')); }, 15000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(window.YT); };
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => { clearTimeout(timer); script.remove(); apiPromise = null; reject(new Error('Não foi possível carregar o YouTube.')); };
    document.head.appendChild(script);
  });
  return apiPromise;
}

export function MusicBot({ music, deafened, send, error }) {
  const [url, setUrl] = useState('');
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('jump-music-volume') ?? 50));
  const [playerError, setPlayerError] = useState('');
  const [retry, setRetry] = useState(0);
  const host = useRef(null);
  const player = useRef(null);
  const latest = useRef({ music, deafened, volume, send });
  latest.current = { music, deafened, volume, send };
  const track = music?.queue?.[0];
  useEffect(() => {
    if (!track) return;
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
      p.setVolume(level);
      if (muted) p.mute(); else p.unMute();
      if (loadedKey !== current.key) {
        loadedKey = current.key;
        setPlayerError('');
        if (state.playing) p.loadVideoById({ videoId: current.id, startSeconds: position });
        else p.cueVideoById({ videoId: current.id, startSeconds: position });
      } else if (Math.abs(p.getCurrentTime() - position) > 3) p.seekTo(position, true);
      if (state.playing) p.playVideo(); else p.pauseVideo();
    };
    loadYouTube().then(YT => {
      if (disposed) return;
      const element = document.createElement('div');
      host.current.appendChild(element);
      player.current = new YT.Player(element, {
        width: '100%', height: '200',
        playerVars: { origin: window.location.origin, playsinline: 1 },
        events: {
          onReady: () => { ready = true; synchronize(); },
          onAutoplayBlocked: () => setPlayerError('Clique no play do vídeo para ativar o áudio neste computador.'),
          onError: event => setPlayerError(`YouTube indisponível para este vídeo (erro ${event.data}). Você pode pular para o próximo.`),
          onStateChange: event => {
            if (event.data === 0 && loadedKey === latest.current.music?.queue?.[0]?.key) latest.current.send({ action: 'ended', key: loadedKey });
            if (event.data === 1) setPlayerError('');
          },
        },
      });
    }).catch(reason => { if (!disposed) setPlayerError(reason.message); });
    const timer = setInterval(synchronize, 2000);
    return () => { disposed = true; clearInterval(timer); player.current?.destroy(); player.current = null; };
  }, [Boolean(track), retry]);
  useEffect(() => {
    const p = player.current;
    if (typeof p?.setVolume !== 'function') return;
    p.setVolume(volume);
    if (deafened) p.mute(); else p.unMute();
  }, [volume, deafened]);
  return <section className="music-bot" aria-label="JUMP Jukebox">
    <div className="music-titlebar"><strong>♫ JUMP Jukebox — YouTube</strong><span>{track ? (music.playing ? 'Reproduzindo' : 'Pausado') : 'Pronto'}</span></div>
    <div className="music-body">
      {track && <div className="music-player" ref={host} />}
      <div className="music-controls">
        <form onSubmit={event => { event.preventDefault(); if (send({ action: 'add', url })) setUrl(''); }}>
          <label htmlFor="music-url">Adicionar à fila da chamada</label>
          <div className="music-row"><input id="music-url" type="url" required maxLength={2048} placeholder="Cole um link do YouTube" value={url} onChange={event => setUrl(event.target.value)} /><button type="submit">Adicionar</button></div>
        </form>
        <div className="music-row">
          <button disabled={!track} onClick={() => send({ action: music.playing ? 'pause' : 'play' })}>{music?.playing ? 'Pausar' : 'Tocar'}</button>
          <button disabled={!track} onClick={() => send({ action: 'skip', key: track.key })}>Próxima</button>
          <button disabled={!track} onClick={() => send({ action: 'stop' })}>Limpar fila</button>
          <label>Volume local <input aria-label="Volume da música" type="range" min="0" max="100" value={volume} onChange={event => { const value = Number(event.target.value); setVolume(value); localStorage.setItem('jump-music-volume', String(value)); }} /></label>
        </div>
        <p>{track ? `${music.queue.length} vídeo(s) na fila · atual: ${track.id}` : 'Cole um link para ouvir com a chamada. Sem conta ou chave de API.'}</p>
        {music?.queue?.length > 1 && <ol className="music-queue">{music.queue.slice(1).map(item => <li key={item.key}>{item.id}</li>)}</ol>}
        <small>Controles compartilhados. O volume é só seu; desativar áudio também silencia a música. Se necessário, clique no play do vídeo.</small>
        {(error || playerError) && <p role="alert">{error || playerError} {playerError && <button onClick={() => setRetry(value => value + 1)}>Tentar novamente</button>}</p>}
      </div>
    </div>
  </section>;
}

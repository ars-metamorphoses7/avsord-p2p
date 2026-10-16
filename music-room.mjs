export function youtubeId(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const host = url.hostname.replace(/^www\./, '');
    const id = host === 'youtu.be' ? url.pathname.slice(1) : ['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)
      ? (url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(shorts|embed|live)\//.test(url.pathname) ? url.pathname.split('/')[2] : null) : null;
    return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}

export function musicCommand(state, command, now = Date.now()) {
  const current = state || { queue: [], playing: false, position: 0, updatedAt: now, revision: 0 };
  const next = { ...current, queue: [...current.queue], revision: current.revision + 1 };
  if (command.action === 'add') {
    const id = youtubeId(command.url);
    if (!id) throw new Error('Cole um link válido de vídeo do YouTube.');
    if (next.queue.length >= 30) throw new Error('A fila está cheia (30 vídeos).');
    next.queue.push({ id, key: `${now}-${next.revision}` });
    if (next.queue.length === 1) { next.position = 0; next.updatedAt = now; next.playing = true; }
  } else if (command.action === 'pause' || command.action === 'play') {
    if (!next.queue.length) return current;
    next.position += next.playing ? Math.max(0, now - next.updatedAt) / 1000 : 0;
    next.updatedAt = now;
    next.playing = command.action === 'play';
  } else if (command.action === 'skip' || command.action === 'ended') {
    if (command.key !== next.queue[0]?.key) return current;
    next.queue.shift(); next.position = 0; next.updatedAt = now; next.playing = next.queue.length > 0;
  } else if (command.action === 'stop') {
    next.queue = []; next.position = 0; next.updatedAt = now; next.playing = false;
  } else return current;
  return next;
}

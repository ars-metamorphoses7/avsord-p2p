export const DEFAULT_SIGNAL_PORT = 8787;
export const INVITE_ADDRESS_KEY = 'jump-invite-address';

// Accepts what people actually type: "26.1.2.3", "26.1.2.3:8787",
// "http://26.1.2.3:8787" or a full invite/jump:// link.
export function parseServerAddress(value) {
  let clean = String(value || '').trim();
  if (!clean) return '';
  if (/^jump:/i.test(clean)) {
    try { clean = new URL(clean).searchParams.get('signal') || ''; } catch { return ''; }
    if (!clean) return '';
  }
  if (!/^https?:\/\//i.test(clean)) clean = `http://${clean}`;
  try {
    const url = new URL(clean);
    const nested = url.searchParams.get('signal');
    if (nested) return parseServerAddress(nested);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return '';
    if (!url.port && url.protocol === 'http:') url.port = String(DEFAULT_SIGNAL_PORT);
    return url.origin;
  } catch {
    return '';
  }
}

// Saved rooms grouped by the server that hosts them. Sessions saved before
// servers had ids fall back to their address.
export function groupServers(sessions, current = null) {
  const servers = new Map();
  const signalKeys = new Map();
  const add = ({ serverId = '', serverName = '', signal = '', roomName = '', lastVisitedAt = 0 }) => {
    const key = serverId ? `id:${serverId}` : signalKeys.get(signal) || `signal:${signal}`;
    const entry = servers.get(key) || { key, serverId, serverName: '', signal, rooms: [], lastVisitedAt: -1 };
    if (lastVisitedAt >= entry.lastVisitedAt) {
      entry.signal = signal;
      entry.lastVisitedAt = lastVisitedAt;
    }
    if (serverName && (!entry.serverName || lastVisitedAt >= entry.lastVisitedAt)) entry.serverName = serverName;
    if (roomName && !entry.rooms.includes(roomName)) entry.rooms.push(roomName);
    servers.set(key, entry);
    signalKeys.set(signal, key);
  };
  if (current) add({ serverId: current.serverId, serverName: current.serverName, signal: current.signal || '', lastVisitedAt: Number.MAX_SAFE_INTEGER });
  (sessions || []).forEach(add);
  return [...servers.values()].sort((left, right) => right.lastVisitedAt - left.lastVisitedAt);
}

export function serverAddressLabel(signal) {
  if (!signal) return 'este PC';
  try { return new URL(signal).host; } catch { return signal; }
}

// A short WebSocket handshake works with older JUMP hosts too, which have no
// CORS headers on /health; the hello packet carries the server identity.
export function probeSignalServer(signal, { timeoutMs = 3000, origin = globalThis.location?.origin } = {}) {
  return new Promise((resolve) => {
    let socket;
    let done = false;
    let timer = 0;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* Already closed. */ }
      resolve(result);
    };
    timer = setTimeout(() => finish({ online: false }), timeoutMs);
    try {
      const target = new URL(signal || origin);
      socket = new WebSocket(`${target.protocol === 'https:' ? 'wss' : 'ws'}://${target.host}/signal`);
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'hello') finish({ online: true, server: message.server || null });
        } catch { /* Ignore anything but hello. */ }
      };
      socket.onerror = () => finish({ online: false });
      socket.onclose = () => finish({ online: false });
    } catch {
      finish({ online: false });
    }
  });
}

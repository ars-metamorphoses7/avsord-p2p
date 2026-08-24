const { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const STORE_VERSION = 1;
const DEFAULT_ROOM_ID = 'jump-house';
const DEFAULT_MAX_RECENT = 50;

function normalizeRoomId(value) {
  return String(value || DEFAULT_ROOM_ID)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || DEFAULT_ROOM_ID;
}

function normalizeRoomName(value, roomId = DEFAULT_ROOM_ID) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  if (clean) return clean;
  return normalizeRoomId(roomId)
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ') || 'Jump House';
}

function normalizeSignalOrigin(value) {
  const clean = String(value || '').trim();
  if (!clean) return '';
  try {
    const parsed = new URL(clean);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function normalizeRoomSession(value, now = Date.now()) {
  if (!value || typeof value !== 'object') return null;
  const rawSignal = String(value.signal ?? value.signalOrigin ?? '').trim();
  const signal = normalizeSignalOrigin(rawSignal);
  if (rawSignal && !signal) return null;
  const roomId = normalizeRoomId(value.roomId ?? value.room);
  const lastVisitedAt = Number(value.lastVisitedAt);
  return {
    roomId,
    roomName: normalizeRoomName(value.roomName ?? value.name, roomId),
    signal,
    lastVisitedAt: Number.isFinite(lastVisitedAt) && lastVisitedAt > 0 ? lastVisitedAt : now,
  };
}

function roomSessionKey(value) {
  return `${value.signal || 'local'}\u0000${value.roomId}`;
}

function emptyState() {
  return { version: STORE_VERSION, active: null, recent: [] };
}

function normalizeState(value, maxRecent, now) {
  if (!value || typeof value !== 'object') return emptyState();
  const unique = new Map();
  const candidates = [value.active, ...(Array.isArray(value.recent) ? value.recent : [])];
  for (const candidate of candidates) {
    const session = normalizeRoomSession(candidate, now());
    if (!session) continue;
    const key = roomSessionKey(session);
    const previous = unique.get(key);
    if (!previous || session.lastVisitedAt > previous.lastVisitedAt) unique.set(key, session);
  }
  const recent = [...unique.values()]
    .sort((left, right) => right.lastVisitedAt - left.lastVisitedAt)
    .slice(0, maxRecent);
  const normalizedActive = normalizeRoomSession(value.active, now());
  const active = normalizedActive
    ? recent.find((session) => roomSessionKey(session) === roomSessionKey(normalizedActive)) || normalizedActive
    : null;
  return { version: STORE_VERSION, active, recent };
}

function createRoomSessionStore({ filePath, maxRecent = DEFAULT_MAX_RECENT, now = Date.now }) {
  if (!filePath) throw new TypeError('filePath is required');
  const recentLimit = Math.max(1, Math.min(200, Number(maxRecent) || DEFAULT_MAX_RECENT));

  function read() {
    try {
      if (!existsSync(filePath)) return emptyState();
      return normalizeState(JSON.parse(readFileSync(filePath, 'utf8')), recentLimit, now);
    } catch {
      return emptyState();
    }
  }

  function write(state) {
    const normalized = normalizeState(state, recentLimit, now);
    const directory = path.dirname(filePath);
    const temporaryFile = `${filePath}.tmp`;
    mkdirSync(directory, { recursive: true });
    try {
      writeFileSync(temporaryFile, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      renameSync(temporaryFile, filePath);
    } catch (error) {
      try { if (existsSync(temporaryFile)) unlinkSync(temporaryFile); } catch { /* Best effort cleanup. */ }
      throw error;
    }
    return normalized;
  }

  function remember(value) {
    const session = normalizeRoomSession(value, now());
    if (!session) return { ok: false, state: read() };
    const state = read();
    const key = roomSessionKey(session);
    const recent = [session, ...state.recent.filter((entry) => roomSessionKey(entry) !== key)]
      .slice(0, recentLimit);
    const next = write({ version: STORE_VERSION, active: session, recent });
    return { ok: true, session: next.active, recent: next.recent };
  }

  function forget(value) {
    const session = normalizeRoomSession(value, now());
    if (!session) return { ok: false, state: read() };
    const state = read();
    const key = roomSessionKey(session);
    const activeMatches = state.active && roomSessionKey(state.active) === key;
    const recent = state.recent.filter((entry) => roomSessionKey(entry) !== key);
    const next = write({ version: STORE_VERSION, active: activeMatches ? null : state.active, recent });
    return { ok: true, active: next.active, recent: next.recent };
  }

  return {
    getActive: () => read().active,
    listRecent: () => read().recent,
    remember,
    forget,
  };
}

module.exports = {
  STORE_VERSION,
  createRoomSessionStore,
  normalizeRoomId,
  normalizeRoomSession,
  normalizeSignalOrigin,
};

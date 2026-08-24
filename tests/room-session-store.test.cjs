const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
  createRoomSessionStore,
  normalizeRoomSession,
  normalizeSignalOrigin,
} = require('../electron/room-session-store.cjs');

function temporaryStore(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'jump-room-sessions-'));
  const filePath = join(directory, 'room-sessions.json');
  return {
    directory,
    filePath,
    store: createRoomSessionStore({ filePath, ...options }),
  };
}

test('restores the active remote room from a new store instance after an app update', () => {
  const fixture = temporaryStore({ now: () => 1_700_000_000_000 });
  try {
    const saved = fixture.store.remember({
      roomId: 'Sala da Equipe',
      roomName: 'Sala da Equipe',
      signal: 'http://10.0.0.7:8787/signal?ignored=1',
    });
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.session, {
      roomId: 'sala-da-equipe',
      roomName: 'Sala da Equipe',
      signal: 'http://10.0.0.7:8787',
      lastVisitedAt: 1_700_000_000_000,
    });

    const afterUpdate = createRoomSessionStore({
      filePath: fixture.filePath,
      now: () => 1_800_000_000_000,
    });
    assert.deepEqual(afterUpdate.getActive(), saved.session);
    assert.equal(JSON.parse(readFileSync(fixture.filePath, 'utf8')).version, 1);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('keeps recent rooms per signaling origin and never persists extra fields', () => {
  let clock = 10;
  const fixture = temporaryStore({ now: () => ++clock });
  try {
    fixture.store.remember({ roomId: 'geral', roomName: 'Geral A', signal: 'https://a.example.test', password: 'secret-a' });
    fixture.store.remember({ roomId: 'geral', roomName: 'Geral B', signal: 'https://b.example.test', password: 'secret-b' });
    fixture.store.remember({ roomId: 'geral', roomName: 'Geral A atualizada', signal: 'https://a.example.test' });

    const recent = fixture.store.listRecent();
    assert.equal(recent.length, 2);
    assert.equal(recent[0].roomName, 'Geral A atualizada');
    assert.equal(recent[1].roomName, 'Geral B');
    assert.equal(readFileSync(fixture.filePath, 'utf8').includes('secret'), false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('forgetting the active room prevents it from being restored', () => {
  const fixture = temporaryStore();
  try {
    fixture.store.remember({ roomId: 'temporaria', signal: 'http://192.168.0.20:8787' });
    const forgotten = fixture.store.forget({ roomId: 'temporaria', signal: 'http://192.168.0.20:8787' });
    assert.equal(forgotten.ok, true);
    assert.equal(fixture.store.getActive(), null);
    assert.deepEqual(fixture.store.listRecent(), []);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('ignores corrupt files and rejects unsafe signaling protocols', () => {
  const fixture = temporaryStore();
  try {
    writeFileSync(fixture.filePath, '{broken', 'utf8');
    assert.equal(fixture.store.getActive(), null);
    assert.equal(normalizeSignalOrigin('file:///tmp/server'), '');
    assert.equal(normalizeRoomSession({ roomId: 'x', signal: 'javascript:alert(1)' }), null);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

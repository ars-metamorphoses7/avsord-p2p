import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupServers, parseServerAddress } from '../src/network/serverDirectory.js';

const require = createRequire(import.meta.url);
const { createRoomSessionStore } = require('../electron/room-session-store.cjs');

test('parses typed addresses and invite links into a signaling origin', () => {
  assert.equal(parseServerAddress('26.10.20.30'), 'http://26.10.20.30:8787');
  assert.equal(parseServerAddress(' 26.10.20.30:9000 '), 'http://26.10.20.30:9000');
  assert.equal(parseServerAddress('https://jump.example'), 'https://jump.example');
  assert.equal(parseServerAddress('jump://join?signal=http%3A%2F%2F26.1.2.3%3A8787&room=sala'), 'http://26.1.2.3:8787');
  assert.equal(parseServerAddress('http://127.0.0.1:8787/?room=x&signal=http%3A%2F%2F26.9.9.9%3A8787'), 'http://26.9.9.9:8787');
  assert.equal(parseServerAddress(''), '');
  assert.equal(parseServerAddress('jump://join?room=sala'), '');
});

test('groups saved rooms by server id, merging legacy sessions at the same address', () => {
  const servers = groupServers([
    { roomId: 'a', roomName: 'A', signal: 'http://26.0.0.2:8787', serverId: 'server-new-0001', serverName: 'PC-HOST', lastVisitedAt: 30 },
    { roomId: 'b', roomName: 'B', signal: 'http://26.0.0.1:8787', serverId: 'server-new-0001', serverName: 'PC-HOST', lastVisitedAt: 10 },
    { roomId: 'c', roomName: 'C', signal: '', lastVisitedAt: 20 },
  ], { serverId: 'local-server-01', serverName: 'MEU-PC', signal: '' });
  assert.equal(servers.length, 2);
  assert.equal(servers[0].serverId, 'local-server-01');
  assert.deepEqual(servers[0].rooms, ['C']);
  assert.equal(servers[1].signal, 'http://26.0.0.2:8787');
  assert.deepEqual(servers[1].rooms, ['A', 'B']);
});

test('relocating a server moves every saved room and the active session to the new address', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jump-relocate-'));
  try {
    const store = createRoomSessionStore({ filePath: join(directory, 'sessions.json') });
    store.remember({ roomId: 'a', signal: 'http://26.0.0.1:8787', serverId: 'server-0001' });
    store.remember({ roomId: 'legacy', signal: 'http://26.0.0.1:8787' });
    store.remember({ roomId: 'other', signal: 'http://26.5.5.5:8787', serverId: 'server-0002' });
    store.remember({ roomId: 'b', signal: 'http://26.0.0.1:8787', serverId: 'server-0001' });
    const result = store.relocate({ serverId: 'server-0001', fromSignal: 'http://26.0.0.1:8787', signal: 'http://26.0.0.9:8787' });
    assert.equal(result.ok, true);
    assert.equal(store.getActive().signal, 'http://26.0.0.9:8787');
    const bySignal = Object.fromEntries(store.listRecent().map((session) => [session.roomId, session]));
    assert.equal(bySignal.a.signal, 'http://26.0.0.9:8787');
    assert.equal(bySignal.legacy.signal, 'http://26.0.0.9:8787');
    assert.equal(bySignal.legacy.serverId, 'server-0001');
    assert.equal(bySignal.other.signal, 'http://26.5.5.5:8787');

    store.forgetServer({ serverId: 'server-0001' });
    assert.deepEqual(store.listRecent().map((session) => session.roomId), ['other']);
    assert.equal(store.getActive(), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

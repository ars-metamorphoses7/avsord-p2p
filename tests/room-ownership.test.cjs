const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { createServer } = require('node:net');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const test = require('node:test');
const WebSocket = require('ws');

const serverPath = join(__dirname, '..', 'server.mjs');

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startServer(dataDirectory, port, env = {}) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), JUMP_DATA_DIR: dataDirectory, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const onOutput = (chunk) => {
      output += chunk.toString();
      if (output.includes('JUMP signaling server listening')) resolve();
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.once('exit', (code) => reject(new Error(`server exited with ${code}: ${output}`)));
  });
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
}

// Connects and records every packet so tests can wait for one by predicate.
async function connect(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/signal`);
  const received = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    received.push(message);
    waiters.slice().forEach((waiter) => {
      if (!waiter.predicate(message)) return;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    });
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const next = (predicate, timeoutMs = 3000) => {
    const found = received.find(predicate);
    if (found) {
      received.splice(received.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for packet')), timeoutMs);
      waiters.push({ predicate, resolve: (message) => { clearTimeout(timer); received.splice(received.indexOf(message), 1); resolve(message); } });
    });
  };
  const send = (payload) => socket.send(JSON.stringify(payload));
  return { socket, next, send };
}

const ownerKey = 'owner-key-0123456789abcdef';
const guestKey = 'guest-key-0123456789abcdef';

test('only the room owner manages a room and can hand it over', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'jump-ownership-'));
  const port = await freePort();
  const child = await startServer(dataDirectory, port, { JUMP_LOCAL_ADMIN: '0' });
  const sockets = [];
  try {
    const owner = await connect(port);
    sockets.push(owner.socket);
    const hello = await owner.next((message) => message.type === 'hello');
    assert.match(hello.server.id, /^[a-z0-9-]{8,64}$/);
    assert.equal(hello.isAdmin, false);
    owner.send({ type: 'join', roomId: 'sala', roomName: 'Sala', name: 'Dono', clientId: 'a', ownerKey });
    const ownerState = await owner.next((message) => message.type === 'room-state');
    assert.equal(ownerState.canManage, true);
    assert.equal(ownerState.ownerName, 'Dono');

    const guest = await connect(port);
    sockets.push(guest.socket);
    guest.send({ type: 'join', roomId: 'sala', name: 'Convidado', clientId: 'b', ownerKey: guestKey });
    const guestState = await guest.next((message) => message.type === 'room-state');
    assert.equal(guestState.canManage, false);

    guest.send({ type: 'rename-room', roomId: 'sala', name: 'Invadida' });
    const forbidden = await guest.next((message) => message.type === 'room-forbidden');
    assert.equal(forbidden.name, 'Sala');
    guest.send({ type: 'delete-room', roomId: 'sala' });
    await guest.next((message) => message.type === 'room-forbidden');

    // Spoofing the public client id of the owner does not grant ownership.
    guest.send({ type: 'join', roomId: 'sala', name: 'Convidado', clientId: 'a' });
    assert.equal((await guest.next((message) => message.type === 'room-state')).canManage, false);

    const guestPeerId = ownerState.peerId === guestState.peerId ? '' : guestState.peerId;
    owner.send({ type: 'transfer-room', roomId: 'sala', target: guestPeerId });
    const ownerPermissions = await owner.next((message) => message.type === 'room-permissions');
    const guestPermissions = await guest.next((message) => message.type === 'room-permissions');
    assert.equal(ownerPermissions.canManage, false);
    assert.equal(guestPermissions.canManage, true);
    assert.equal(guestPermissions.ownerName, 'Convidado');

    guest.send({ type: 'rename-room', roomId: 'sala', name: 'Nova' });
    assert.equal((await owner.next((message) => message.type === 'room-renamed')).name, 'Nova');
  } finally {
    sockets.forEach((socket) => socket.close());
    await stopServer(child);
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('the host machine administers every room and the server id survives restarts', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'jump-ownership-'));
  const port = await freePort();
  let child = await startServer(dataDirectory, port, { JUMP_LOCAL_ADMIN: '0' });
  const sockets = [];
  try {
    const owner = await connect(port);
    sockets.push(owner.socket);
    const firstHello = await owner.next((message) => message.type === 'hello');
    owner.send({ type: 'join', roomId: 'sala', name: 'Dono', clientId: 'a', ownerKey });
    await owner.next((message) => message.type === 'room-state');
    owner.socket.close();
    await stopServer(child);

    child = await startServer(dataDirectory, port);
    const host = await connect(port);
    sockets.push(host.socket);
    const hello = await host.next((message) => message.type === 'hello');
    assert.equal(hello.server.id, firstHello.server.id);
    assert.equal(hello.isAdmin, true);
    host.send({ type: 'join', roomId: 'sala', name: 'Host', clientId: 'h', ownerKey: guestKey });
    const state = await host.next((message) => message.type === 'room-state');
    assert.equal(state.canManage, true);
    assert.equal(state.ownerName, 'Dono');
    host.send({ type: 'delete-room', roomId: 'sala' });
    await host.next((message) => message.type === 'room-deleted');
  } finally {
    sockets.forEach((socket) => socket.close());
    await stopServer(child);
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

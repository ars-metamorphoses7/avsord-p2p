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
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function startServer(dataDirectory, port) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), JUMP_DATA_DIR: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const onOutput = (chunk) => {
      output += chunk.toString();
      if (output.includes('JUMP signaling server listening')) resolve();
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== null) reject(new Error(`server exited with ${code}: ${output}`));
    });
  });
  return { child, ready };
}

function openRoomsSocket(port, joinMessage) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/signal`);
    socket.once('error', reject);
    socket.on('open', () => socket.send(JSON.stringify(joinMessage)));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'rooms-state') resolve({ socket, rooms: message.rooms });
    });
  });
}

function waitForRooms(socket, predicate) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    socket.once('error', onError);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'rooms-state' || !predicate(message.rooms)) return;
      socket.removeListener('error', onError);
      resolve(message.rooms);
    });
  });
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
}

test('persists room directory across signaling restarts and keeps Jump House', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'jump-p2p-rooms-'));
  const port = await freePort();
  let first = startServer(dataDirectory, port);
  let socket;
  try {
    await first.ready;
    const firstConnection = await openRoomsSocket(port, {
      type: 'join',
      roomId: 'sala-foda',
      roomName: 'Sala Foda',
      password: 'segredo',
      name: 'Teste',
      clientId: 'rooms-test',
    });
    ({ socket } = firstConnection);
    assert.deepEqual(firstConnection.rooms.map((room) => room.id), ['jump-house']);
    const createdRooms = await waitForRooms(socket, (rooms) => rooms.some((room) => room.id === 'sala-foda'));
    assert.deepEqual(createdRooms.map((room) => room.id).sort(), ['jump-house', 'sala-foda']);
    assert.equal(createdRooms.find((room) => room.id === 'sala-foda').name, 'Sala Foda');
    socket.close();
    await stopServer(first.child);

    first = startServer(dataDirectory, port);
    await first.ready;
    const restoredConnection = await openRoomsSocket(port, { type: 'join', roomId: 'jump-house', name: 'Teste', clientId: 'rooms-test' });
    ({ socket } = restoredConnection);
    assert.ok(restoredConnection.rooms.some((room) => room.id === 'sala-foda'));
    const restoredRooms = await waitForRooms(socket, (rooms) => rooms.some((room) => room.id === 'sala-foda'));
    const restored = restoredRooms.find((room) => room.id === 'sala-foda');
    assert.equal(restored.name, 'Sala Foda');
    assert.equal(restored.protected, true);
    assert.ok(restored.createdAt > 0);
    assert.ok(restoredRooms.some((room) => room.id === 'jump-house'));
  } finally {
    socket?.close();
    await stopServer(first.child);
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

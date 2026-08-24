import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createScreenSfu } from './sfu-server.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const distRoot = join(root, 'dist');
const roomDataRoot = process.env.JUMP_DATA_DIR || join(root, '.jump-data');
const roomDataFile = join(roomDataRoot, 'rooms.json');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
const DEFAULT_ROOM_ID = 'jump-house';
const rooms = new Map();
const sockets = new Set();
const PRESENCE_STATUSES = new Set(['online', 'dnd', 'offline']);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(socket, payload) {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanPassword(value) {
  return String(value || '').trim().slice(0, 128);
}

function passwordHash(value) {
  return createHash('sha256').update(cleanPassword(value)).digest('hex');
}

function passwordMatches(expectedHash, value) {
  if (!expectedHash) return true;
  const candidate = Buffer.from(passwordHash(value), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function cleanAvatar(value) {
  const avatar = String(value || '');
  return avatar.startsWith('data:image/') ? avatar.slice(0, 180000) : '';
}

function cleanPresence(value) {
  const status = String(value || '').trim().toLowerCase();
  return PRESENCE_STATUSES.has(status) ? status : 'online';
}

function roomLabel(roomId) {
  return roomId
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ') || 'Sala sem nome';
}

function createDefaultRoom() {
  return {
    id: DEFAULT_ROOM_ID,
    name: 'Jump House',
    members: new Map(),
    passwordHash: '',
    createdAt: Date.now(),
    createdBy: 'JUMP',
  };
}

function persistedRoom(value) {
  const id = cleanText(value?.id, 64).toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  if (!id) return null;
  const createdAt = Number(value?.createdAt);
  const password = typeof value?.passwordHash === 'string' && /^[a-f0-9]{64}$/i.test(value.passwordHash)
    ? value.passwordHash.toLowerCase()
    : '';
  return {
    id,
    name: cleanText(value?.name, 48) || roomLabel(id),
    members: new Map(),
    passwordHash: password,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
    createdBy: cleanText(value?.createdBy, 32) || 'JUMP',
  };
}

function roomPersistenceData() {
  return {
    version: 1,
    rooms: [...rooms.values()].map((room) => ({
      id: room.id,
      name: room.name,
      passwordHash: room.passwordHash || '',
      createdAt: room.createdAt,
      createdBy: room.createdBy,
    })),
  };
}

function persistRooms() {
  try {
    mkdirSync(roomDataRoot, { recursive: true });
    writeFileSync(roomDataFile, JSON.stringify(roomPersistenceData(), null, 2), 'utf8');
  } catch (error) {
    // A read-only data directory should not take down signaling for the
    // current session, but the failure is visible to the host for diagnosis.
    console.error(`JUMP could not persist rooms at ${roomDataFile}:`, error);
  }
}

function ensureDefaultRoom() {
  if (rooms.has(DEFAULT_ROOM_ID)) return false;
  rooms.set(DEFAULT_ROOM_ID, createDefaultRoom());
  return true;
}

function loadRooms() {
  let savedRooms = [];
  try {
    if (existsSync(roomDataFile)) {
      const saved = JSON.parse(readFileSync(roomDataFile, 'utf8'));
      savedRooms = Array.isArray(saved) ? saved : saved?.rooms;
      if (!Array.isArray(savedRooms)) savedRooms = [];
    }
  } catch (error) {
    console.error(`JUMP could not load rooms from ${roomDataFile}:`, error);
  }

  savedRooms.map(persistedRoom).filter(Boolean).forEach((room) => {
    if (!rooms.has(room.id)) rooms.set(room.id, room);
  });
  const addedDefault = ensureDefaultRoom();
  if (addedDefault || savedRooms.length !== rooms.size) persistRooms();
}

function roomList() {
  return [...rooms.values()]
    .map((room) => ({
      id: room.id,
      name: room.name,
      count: room.members.size,
      protected: Boolean(room.passwordHash),
      createdAt: room.createdAt,
      createdBy: room.createdBy,
    }));
}

function broadcast(room, payload, exceptId) {
  for (const [id, socket] of room.members.entries()) {
    if (id !== exceptId) send(socket, payload);
  }
}

function broadcastRooms() {
  const payload = { type: 'rooms-state', rooms: roomList() };
  for (const socket of sockets) send(socket, payload);
}

const screenSfu = createScreenSfu({
  send,
  broadcast,
  roomForSocket: (socket) => rooms.get(socket.roomId),
});

function leaveRoom(socket) {
  if (!socket.roomId || !socket.peerId) return;
  const room = rooms.get(socket.roomId);
  if (!room) return;
  screenSfu.closeSocket(socket);
  room.members.delete(socket.peerId);
  broadcast(room, { type: 'peer-left', roomId: room.id, peerId: socket.peerId, count: room.members.size });
  // Salas criadas continuam disponíveis no diretório mesmo quando ficam vazias.
  // Os membros são temporários, mas os metadados das salas ficam persistidos.
  socket.roomId = null;
  broadcastRooms();
}

function serveStatic(request, response) {
  if (!existsSync(distRoot)) {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('JUMP signaling server is running. Start Vite with npm run dev.');
    return;
  }

  const requested = request.url === '/' ? '/index.html' : request.url.split('?')[0];
  const candidate = normalize(join(distRoot, requested));
  const safeCandidate = candidate.startsWith(distRoot) ? candidate : join(distRoot, 'index.html');
  const filePath = existsSync(safeCandidate) && statSync(safeCandidate).isFile()
    ? safeCandidate
    : join(distRoot, 'index.html');

  response.writeHead(200, {
    'content-type': contentTypes[extname(filePath)] || 'application/octet-stream',
  });
  response.end(readFileSync(filePath));
}

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size, sockets: sockets.size }));
    return;
  }
  serveStatic(request, response);
});

const wss = new WebSocketServer({ server, path: '/signal' });

loadRooms();

wss.on('connection', (socket) => {
  socket.peerId = randomUUID().slice(0, 8);
  socket.clientId = '';
  socket.name = 'Você';
  socket.avatar = '';
  socket.status = 'online';
  sockets.add(socket);
  send(socket, { type: 'hello', peerId: socket.peerId });
  send(socket, { type: 'rooms-state', rooms: roomList() });

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === 'sfu-request') {
      void screenSfu.handleMessage(socket, message);
      return;
    }

    if (message.type === 'join') {
      const roomId = cleanText(message.roomId || 'jump-house', 64).toLowerCase().replace(/[^a-z0-9-_]/g, '-') || 'jump-house';
      const name = cleanText(message.name, 32) || 'Você';
      const avatar = cleanAvatar(message.avatar);
      const status = cleanPresence(message.status);
      const clientId = cleanText(message.clientId, 96) || socket.peerId;
      const requestedLabel = cleanText(message.roomName, 48);
      const requestedPassword = cleanPassword(message.password);
      const existingRoom = rooms.get(roomId);

      if (existingRoom?.passwordHash && !passwordMatches(existingRoom.passwordHash, requestedPassword)) {
        send(socket, {
          type: 'room-error',
          roomId,
          name: existingRoom.name,
          code: 'invalid-password',
          message: 'Essa sala exige uma senha válida.',
        });
        return;
      }

      if (socket.roomId === roomId && existingRoom) {
        const room = existingRoom;
        socket.name = name;
        socket.avatar = avatar;
        socket.status = status;
        socket.clientId = clientId;
        if (!room.createdAt) room.createdAt = Date.now();
        if (!room.createdBy) room.createdBy = name;
        socket.joinedAt = socket.joinedAt || Date.now();
        send(socket, {
          type: 'room-state',
          roomId,
          name: room.name,
          protected: Boolean(room.passwordHash),
          createdAt: room.createdAt,
          createdBy: room.createdBy,
          joinedAt: socket.joinedAt,
          clientId: socket.clientId,
          peerId: socket.peerId,
          peers: [...room.members.values()]
            .filter((peer) => peer.peerId !== socket.peerId)
            .map((peer) => ({ peerId: peer.peerId, clientId: peer.clientId, name: peer.name, avatar: peer.avatar, status: peer.status, joinedAt: peer.joinedAt })),
          count: room.members.size,
        });
        broadcastRooms();
        return;
      }

      leaveRoom(socket);
      const room = existingRoom || {
        id: roomId,
        name: requestedLabel || roomLabel(roomId),
        members: new Map(),
        passwordHash: requestedPassword ? passwordHash(requestedPassword) : '',
        createdAt: Date.now(),
        createdBy: name,
      };
      if (!existingRoom && requestedLabel) room.name = requestedLabel;
      if (!room.createdAt) room.createdAt = Date.now();
      if (!room.createdBy) room.createdBy = name;
      socket.roomId = roomId;
      socket.clientId = clientId;
      socket.name = name;
      socket.avatar = avatar;
      socket.status = status;
      socket.joinedAt = Date.now();
      room.members.set(socket.peerId, socket);
      rooms.set(roomId, room);
      persistRooms();

      send(socket, {
        type: 'room-state',
        roomId,
        name: room.name,
        protected: Boolean(room.passwordHash),
        createdAt: room.createdAt,
        createdBy: room.createdBy,
        joinedAt: socket.joinedAt,
        clientId: socket.clientId,
        peerId: socket.peerId,
        peers: [...room.members.values()]
          .filter((peer) => peer.peerId !== socket.peerId)
          .map((peer) => ({ peerId: peer.peerId, clientId: peer.clientId, name: peer.name, avatar: peer.avatar, status: peer.status, joinedAt: peer.joinedAt })),
        count: room.members.size,
      });
      broadcast(room, {
        type: 'peer-joined',
        roomId,
        joinedAt: socket.joinedAt,
        peer: { peerId: socket.peerId, clientId: socket.clientId, name: socket.name, avatar: socket.avatar, status: socket.status, joinedAt: socket.joinedAt },
        count: room.members.size,
      }, socket.peerId);
      broadcastRooms();
      return;
    }

    if (message.type === 'rename-room' && socket.roomId) {
      const room = rooms.get(socket.roomId);
      const name = cleanText(message.name, 48);
      if (!room || message.roomId !== room.id || !name) return;
      room.name = name;
      persistRooms();
      broadcast(room, { type: 'room-renamed', roomId: room.id, name: room.name });
      send(socket, { type: 'room-renamed', roomId: room.id, name: room.name });
      broadcastRooms();
      return;
    }

    if (message.type === 'delete-room' && socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (!room || message.roomId !== room.id) return;
      const roomId = room.id;
      const roomName = room.name;
      const members = [...room.members.values()];
      // Close mediasoup producers, consumers and transports while the room
      // membership is still available to the SFU cleanup callbacks.
      members.forEach((member) => screenSfu.closeSocket(member));
      rooms.delete(roomId);
      // The default room is always available, even after the last custom room
      // is deleted or someone removes Jump House itself.
      ensureDefaultRoom();
      persistRooms();
      const remainingRooms = roomList();
      members.forEach((member) => {
        member.roomId = null;
        member.joinedAt = null;
        send(member, { type: 'room-deleted', roomId, name: roomName, rooms: remainingRooms });
      });
      room.members.clear();
      broadcastRooms();
      return;
    }

    if (message.type === 'profile' && socket.roomId) {
      const room = rooms.get(socket.roomId);
      const name = cleanText(message.name, 32) || 'Você';
      if (!room) return;
      socket.name = name;
      if (message.avatar !== undefined) socket.avatar = cleanAvatar(message.avatar);
      if (message.status !== undefined) socket.status = cleanPresence(message.status);
      broadcast(room, { type: 'peer-updated', peer: { peerId: socket.peerId, clientId: socket.clientId, joinedAt: socket.joinedAt, name, avatar: socket.avatar, status: socket.status } }, socket.peerId);
      broadcastRooms();
      return;
    }

    if (message.type === 'signal' && socket.roomId) {
      const room = rooms.get(socket.roomId);
      const target = room?.members.get(message.target);
      if (target) send(target, { type: 'signal', from: socket.peerId, data: message.data });
    }
  });

  socket.on('close', () => {
    leaveRoom(socket);
    sockets.delete(socket);
    broadcastRooms();
  });
});

server.listen(port, host, () => {
  console.log(`JUMP signaling server listening on ${host}:${port}`);
});

server.on('close', () => { void screenSfu.close(); });

export { server, wss };

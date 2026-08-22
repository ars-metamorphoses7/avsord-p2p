import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const root = fileURLToPath(new URL('.', import.meta.url));
const distRoot = join(root, 'dist');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
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

function leaveRoom(socket) {
  if (!socket.roomId || !socket.peerId) return;
  const room = rooms.get(socket.roomId);
  if (!room) return;
  room.members.delete(socket.peerId);
  broadcast(room, { type: 'peer-left', roomId: room.id, peerId: socket.peerId, count: room.members.size });
  // Salas criadas continuam disponíveis no diretório mesmo quando ficam vazias.
  // O processo de sinalização continua sendo a fonte de vida dessas salas;
  // reiniciar o servidor ainda limpa o diretório em memória.
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
      rooms.delete(roomId);
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

export { server, wss };

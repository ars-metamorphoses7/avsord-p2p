import http from 'node:http';
import { randomUUID } from 'node:crypto';
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

function cleanAvatar(value) {
  const avatar = String(value || '');
  return avatar.startsWith('data:image/') ? avatar.slice(0, 180000) : '';
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
    .map((room) => ({ id: room.id, name: room.name, count: room.members.size }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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
  broadcast(room, { type: 'peer-left', peerId: socket.peerId, count: room.members.size });
  if (!room.members.size) rooms.delete(room.id);
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
  socket.name = 'Você';
  socket.avatar = '';
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
      const requestedLabel = cleanText(message.roomName, 48);

      if (socket.roomId === roomId) {
        const room = rooms.get(roomId);
        socket.name = name;
        socket.avatar = avatar;
        if (requestedLabel) room.name = requestedLabel;
        send(socket, {
          type: 'room-state',
          roomId,
          name: room.name,
          peerId: socket.peerId,
          peers: [...room.members.values()]
            .filter((peer) => peer.peerId !== socket.peerId)
            .map((peer) => ({ peerId: peer.peerId, name: peer.name, avatar: peer.avatar })),
          count: room.members.size,
        });
        broadcastRooms();
        return;
      }

      leaveRoom(socket);
      const room = rooms.get(roomId) || {
        id: roomId,
        name: requestedLabel || roomLabel(roomId),
        members: new Map(),
      };
      if (requestedLabel) room.name = requestedLabel;
      socket.roomId = roomId;
      socket.name = name;
      socket.avatar = avatar;
      room.members.set(socket.peerId, socket);
      rooms.set(roomId, room);

      send(socket, {
        type: 'room-state',
        roomId,
        name: room.name,
        peerId: socket.peerId,
        peers: [...room.members.values()]
          .filter((peer) => peer.peerId !== socket.peerId)
          .map((peer) => ({ peerId: peer.peerId, name: peer.name, avatar: peer.avatar })),
        count: room.members.size,
      });
      broadcast(room, {
        type: 'peer-joined',
        peer: { peerId: socket.peerId, name: socket.name, avatar: socket.avatar },
        count: room.members.size,
      }, socket.peerId);
      broadcastRooms();
      return;
    }

    if (message.type === 'profile' && socket.roomId) {
      const room = rooms.get(socket.roomId);
      const name = cleanText(message.name, 32) || 'Você';
      if (!room) return;
      socket.name = name;
      if (message.avatar !== undefined) socket.avatar = cleanAvatar(message.avatar);
      broadcast(room, { type: 'peer-updated', peer: { peerId: socket.peerId, name, avatar: socket.avatar } }, socket.peerId);
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

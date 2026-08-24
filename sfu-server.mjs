import os from 'node:os';
import fs from 'node:fs';
import * as mediasoup from 'mediasoup';

const SCREEN_APP_DATA = Object.freeze({ mediaTag: 'screen' });

export function resolveMediasoupWorkerBin(workerBin = mediasoup.workerBin, exists = fs.existsSync) {
  const original = String(workerBin || '');
  const unpacked = original.replace(/([\\/])app\.asar\1/, '$1app.asar.unpacked$1');
  return unpacked !== original && exists(unpacked) ? unpacked : original;
}

function cleanId(value) {
  return String(value || '').trim().slice(0, 128);
}

function preferredNetworkAddress() {
  const candidates = Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => (
    entries || []
  ).filter((entry) => (
    (entry.family === 'IPv4' || entry.family === 4) && !entry.internal
  )).map((entry) => ({ name, address: entry.address })));
  candidates.sort((left, right) => (
    Number(/radmin|vpn/i.test(right.name)) - Number(/radmin|vpn/i.test(left.name))
  ));
  return candidates[0]?.address || '127.0.0.1';
}

function mediaCodecs() {
  return [
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90_000,
      parameters: { 'x-google-start-bitrate': 1_000 },
    },
    {
      kind: 'video',
      mimeType: 'video/H264',
      clockRate: 90_000,
      parameters: {
        'packetization-mode': 1,
        'level-asymmetry-allowed': 1,
        'profile-level-id': '42e01f',
        'x-google-start-bitrate': 1_000,
      },
    },
    {
      kind: 'video',
      mimeType: 'video/VP9',
      clockRate: 90_000,
      parameters: { 'profile-id': 0, 'x-google-start-bitrate': 1_000 },
    },
  ];
}

function socketState(socket) {
  socket.screenSfu ||= {
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
  };
  return socket.screenSfu;
}

function closeEntityMap(map) {
  for (const entity of map.values()) {
    try { entity.close(); } catch { /* Already closed. */ }
  }
  map.clear();
}

export function createScreenSfu({ send, broadcast, roomForSocket }) {
  const minViewers = Math.max(2, Math.min(12, Number(process.env.JUMP_SFU_MIN_VIEWERS) || 3));
  const listenIp = String(process.env.JUMP_SFU_LISTEN_IP || '0.0.0.0').trim() || '0.0.0.0';
  const announcedAddress = String(
    process.env.JUMP_SFU_ANNOUNCED_ADDRESS || preferredNetworkAddress(),
  ).trim();
  let worker = null;
  let router = null;
  let startupPromise = null;

  async function ensureRouter() {
    if (router && !router.closed) return router;
    if (!startupPromise) {
      startupPromise = (async () => {
        worker = await mediasoup.createWorker({
          logLevel: process.env.JUMP_SFU_LOG_LEVEL || 'warn',
          rtcMinPort: Math.max(1_024, Number(process.env.JUMP_SFU_RTC_MIN_PORT) || 40_000),
          rtcMaxPort: Math.max(1_024, Number(process.env.JUMP_SFU_RTC_MAX_PORT) || 49_999),
          workerBin: resolveMediasoupWorkerBin(),
        });
        worker.on('died', () => {
          worker = null;
          router = null;
          startupPromise = null;
        });
        router = await worker.createRouter({ mediaCodecs: mediaCodecs() });
        return router;
      })().catch((error) => {
        startupPromise = null;
        throw error;
      });
    }
    return startupPromise;
  }

  function producerOwner(room, producerId) {
    if (!room) return null;
    for (const member of room.members.values()) {
      const producer = member.screenSfu?.producers?.get(producerId);
      if (producer) return { socket: member, producer };
    }
    return null;
  }

  function screenProducers(room, exceptPeerId = '') {
    if (!room) return [];
    return [...room.members.values()].flatMap((member) => (
      member.peerId === exceptPeerId ? [] : [...(member.screenSfu?.producers?.values() || [])]
        .filter((producer) => producer.appData?.mediaTag === SCREEN_APP_DATA.mediaTag)
        .map((producer) => ({
          producerId: producer.id,
          peerId: member.peerId,
          kind: producer.kind,
          appData: producer.appData,
        }))
    ));
  }

  async function createTransport(direction) {
    const activeRouter = await ensureRouter();
    const transport = await activeRouter.createWebRtcTransport({
      listenInfos: [
        { protocol: 'udp', ip: listenIp, announcedAddress },
        { protocol: 'tcp', ip: listenIp, announcedAddress },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      appData: { direction },
    });
    if (direction === 'send') await transport.setMaxIncomingBitrate(12_000_000);
    return transport;
  }

  function transportPayload(transport) {
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters,
    };
  }

  async function action(socket, name, data = {}) {
    const room = roomForSocket(socket);
    if (!room || !socket.peerId) throw new Error('Entre em uma sala antes de usar o SFU.');
    const state = socketState(socket);
    const activeRouter = await ensureRouter();

    if (name === 'capabilities') {
      return {
        available: true,
        routerRtpCapabilities: activeRouter.rtpCapabilities,
        minViewers,
        announcedAddress,
      };
    }
    if (name === 'create-transport') {
      const direction = data.direction === 'recv' ? 'recv' : 'send';
      for (const [transportId, existing] of state.transports) {
        if (existing.appData?.direction !== direction) continue;
        state.transports.delete(transportId);
        try { existing.close(); } catch { /* Already closed. */ }
      }
      const transport = await createTransport(direction);
      state.transports.set(transport.id, transport);
      transport.on('routerclose', () => state.transports.delete(transport.id));
      transport.on('listenserverclose', () => state.transports.delete(transport.id));
      return transportPayload(transport);
    }
    if (name === 'connect-transport') {
      const transport = state.transports.get(cleanId(data.transportId));
      if (!transport) throw new Error('Transporte SFU inexistente.');
      await transport.connect({ dtlsParameters: data.dtlsParameters });
      return { connected: true };
    }
    if (name === 'produce') {
      const transport = state.transports.get(cleanId(data.transportId));
      if (!transport || transport.appData?.direction !== 'send') {
        throw new Error('Transporte SFU de envio inválido.');
      }
      if (data.kind !== 'video') throw new Error('O SFU aceita apenas compartilhamento de tela em vídeo.');
      for (const producer of state.producers.values()) {
        if (producer.appData?.mediaTag === SCREEN_APP_DATA.mediaTag) producer.close();
      }
      state.producers.clear();
      const producer = await transport.produce({
        kind: data.kind,
        rtpParameters: data.rtpParameters,
        appData: { ...(data.appData || {}), ...SCREEN_APP_DATA, peerId: socket.peerId },
      });
      state.producers.set(producer.id, producer);
      producer.on('transportclose', () => state.producers.delete(producer.id));
      producer.on('close', () => state.producers.delete(producer.id));
      broadcast(room, {
        type: 'sfu-producer-added',
        producerId: producer.id,
        peerId: socket.peerId,
        kind: producer.kind,
        appData: producer.appData,
      }, socket.peerId);
      return { id: producer.id };
    }
    if (name === 'list-producers') {
      return { producers: screenProducers(room, socket.peerId) };
    }
    if (name === 'consume') {
      const transport = state.transports.get(cleanId(data.transportId));
      const owner = producerOwner(room, cleanId(data.producerId));
      if (!transport || transport.appData?.direction !== 'recv' || !owner) {
        throw new Error('Producer ou transporte SFU inválido.');
      }
      if (!activeRouter.canConsume({
        producerId: owner.producer.id,
        rtpCapabilities: data.rtpCapabilities,
      })) throw new Error('Este dispositivo não suporta o codec do compartilhamento SFU.');
      for (const [consumerId, existing] of state.consumers) {
        if (existing.producerId !== owner.producer.id) continue;
        state.consumers.delete(consumerId);
        try { existing.close(); } catch { /* Already closed. */ }
      }
      const consumer = await transport.consume({
        producerId: owner.producer.id,
        rtpCapabilities: data.rtpCapabilities,
        paused: true,
        appData: { producerPeerId: owner.socket.peerId },
      });
      state.consumers.set(consumer.id, consumer);
      consumer.on('transportclose', () => {
        state.consumers.delete(consumer.id);
        send(owner.socket, {
          type: 'sfu-consumer-paused',
          producerId: owner.producer.id,
          viewerPeerId: socket.peerId,
        });
      });
      consumer.on('producerclose', () => {
        state.consumers.delete(consumer.id);
        send(socket, {
          type: 'sfu-producer-closed',
          producerId: owner.producer.id,
          peerId: owner.socket.peerId,
        });
      });
      return {
        id: consumer.id,
        producerId: owner.producer.id,
        peerId: owner.socket.peerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        appData: consumer.appData,
      };
    }
    if (name === 'resume-consumer' || name === 'pause-consumer') {
      const consumer = state.consumers.get(cleanId(data.consumerId));
      if (!consumer) throw new Error('Consumer SFU inexistente.');
      if (name === 'resume-consumer') await consumer.resume();
      else await consumer.pause();
      const owner = producerOwner(room, consumer.producerId);
      if (owner) send(owner.socket, {
        type: name === 'resume-consumer' ? 'sfu-consumer-ready' : 'sfu-consumer-paused',
        producerId: consumer.producerId,
        viewerPeerId: socket.peerId,
      });
      return { paused: consumer.paused };
    }
    if (name === 'close-consumer') {
      const consumer = state.consumers.get(cleanId(data.consumerId));
      if (consumer) {
        state.consumers.delete(consumer.id);
        const owner = producerOwner(room, consumer.producerId);
        if (owner) send(owner.socket, {
          type: 'sfu-consumer-paused',
          producerId: consumer.producerId,
          viewerPeerId: socket.peerId,
        });
        consumer.close();
      }
      return { closed: Boolean(consumer) };
    }
    if (name === 'close-producer') {
      const producer = state.producers.get(cleanId(data.producerId));
      if (producer) {
        state.producers.delete(producer.id);
        producer.close();
        broadcast(room, {
          type: 'sfu-producer-closed',
          producerId: producer.id,
          peerId: socket.peerId,
        }, socket.peerId);
      }
      return { closed: Boolean(producer) };
    }
    if (name === 'close-transport') {
      const transport = state.transports.get(cleanId(data.transportId));
      if (transport) {
        state.transports.delete(transport.id);
        transport.close();
      }
      return { closed: Boolean(transport) };
    }
    if (name === 'stats') {
      const producers = await Promise.all([...state.producers.values()].map(async (producer) => ({
        id: producer.id,
        stats: await producer.getStats(),
      })));
      const consumers = await Promise.all([...state.consumers.values()].map(async (consumer) => ({
        id: consumer.id,
        stats: await consumer.getStats(),
      })));
      return { producers, consumers };
    }
    throw new Error(`Ação SFU desconhecida: ${name}`);
  }

  async function handleMessage(socket, message) {
    if (message.type !== 'sfu-request') return false;
    const requestId = cleanId(message.requestId);
    if (!requestId) return true;
    try {
      const data = await action(socket, cleanId(message.action), message.data || {});
      send(socket, { type: 'sfu-response', requestId, ok: true, data });
    } catch (error) {
      send(socket, {
        type: 'sfu-response',
        requestId,
        ok: false,
        error: String(error?.message || error).slice(0, 300),
      });
    }
    return true;
  }

  function closeSocket(socket) {
    if (!socket.screenSfu) return;
    const room = roomForSocket(socket);
    for (const producer of socket.screenSfu.producers.values()) {
      if (room) broadcast(room, {
        type: 'sfu-producer-closed',
        producerId: producer.id,
        peerId: socket.peerId,
      }, socket.peerId);
    }
    for (const consumer of socket.screenSfu.consumers.values()) {
      const owner = producerOwner(room, consumer.producerId);
      if (owner) send(owner.socket, {
        type: 'sfu-consumer-paused',
        producerId: consumer.producerId,
        viewerPeerId: socket.peerId,
      });
    }
    closeEntityMap(socket.screenSfu.consumers);
    closeEntityMap(socket.screenSfu.producers);
    closeEntityMap(socket.screenSfu.transports);
    socket.screenSfu = null;
  }

  async function close() {
    try { worker?.close(); } catch { /* Already closed. */ }
    worker = null;
    router = null;
    startupPromise = null;
  }

  return { close, closeSocket, handleMessage, minViewers };
}

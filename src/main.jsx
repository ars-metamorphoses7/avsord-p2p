import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowUpRight,
  AudioLines,
  Bell,
  Camera,
  ChevronDown,
  CircleHelp,
  Copy,
  CopyCheck,
  Download,
  Headphones,
  Home,
  Inbox,
  Link2,
  LockKeyhole,
  MessageCircle,
  Mic,
  MicOff,
  MonitorUp,
  MoreHorizontal,
  PanelLeft,
  PhoneCall,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Sparkles,
  Users,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';
import './styles.css';

const INITIAL_QUERY = new URLSearchParams(window.location.search);
const DEFAULT_ROOM_ID = INITIAL_QUERY.get('room') || 'jump-house';
const SIGNAL_ORIGIN = INITIAL_QUERY.get('signal') || '';
const TONES = ['yellow', 'mint', 'violet', 'coral', 'blue'];
const MAX_ROOM_MESSAGES = 500;
const MAX_DATA_PACKET_SIZE = 120_000;
const MESSAGE_DB_NAME = 'jump-p2p-local';
const MESSAGE_STORE_NAME = 'room-messages';
let messageDbPromise;

function messageId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sendDataChannelPacket(channel, payload) {
  if (!channel || channel.readyState !== 'open') return;
  const encoded = JSON.stringify(payload);
  if (encoded.length <= MAX_DATA_PACKET_SIZE) {
    channel.send(encoded);
    return;
  }
  const transferId = messageId();
  const total = Math.ceil(encoded.length / MAX_DATA_PACKET_SIZE);
  for (let index = 0; index < total; index += 1) {
    channel.send(JSON.stringify({
      type: 'data-chunk',
      roomId: payload.roomId,
      transferId,
      index,
      total,
      data: encoded.slice(index * MAX_DATA_PACKET_SIZE, (index + 1) * MAX_DATA_PACKET_SIZE),
    }));
  }
}

function openMessageDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (!messageDbPromise) {
    messageDbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(MESSAGE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(MESSAGE_STORE_NAME)) {
          request.result.createObjectStore(MESSAGE_STORE_NAME, { keyPath: 'roomId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return messageDbPromise;
}

async function readRoomMessages(roomId) {
  try {
    const db = await openMessageDb();
    if (db) {
      return await new Promise((resolve, reject) => {
        const request = db.transaction(MESSAGE_STORE_NAME, 'readonly').objectStore(MESSAGE_STORE_NAME).get(roomId);
        request.onsuccess = () => resolve(request.result?.messages || []);
        request.onerror = () => reject(request.error);
      });
    }
    return JSON.parse(localStorage.getItem(`jump-room:${roomId}`) || '[]');
  } catch {
    return [];
  }
}

async function writeRoomMessages(roomId, messages) {
  const safeMessages = messages.slice(-MAX_ROOM_MESSAGES);
  try {
    const db = await openMessageDb();
    if (db) {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(MESSAGE_STORE_NAME, 'readwrite');
        transaction.objectStore(MESSAGE_STORE_NAME).put({ roomId, messages: safeMessages });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      return;
    }
    localStorage.setItem(`jump-room:${roomId}`, JSON.stringify(safeMessages));
  } catch {
    // A storage failure should not stop the live P2P conversation.
  }
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'jump-house';
}

function prettyRoomName(value) {
  return String(value || 'jump-house')
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ') || 'Jump House';
}

function initialsFor(value) {
  const parts = String(value || 'Você').trim().split(/\s+/g).filter(Boolean);
  if (parts.length > 1) return `${parts[0][0]}${parts.at(-1)[0]}`.toUpperCase();
  return (parts[0] || 'VC').slice(0, 2).toUpperCase();
}

function toneFor(value) {
  const sum = [...String(value || 'self')].reduce((total, char) => total + char.charCodeAt(0), 0);
  return TONES[sum % TONES.length];
}

function formatMessage(message) {
  const timestamp = message.timestamp || Date.now();
  return {
    ...message,
    time: new Date(timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    initials: initialsFor(message.senderName),
    tone: toneFor(message.senderId),
    avatar: message.senderAvatar || message.avatar || '',
  };
}

function sortRoomMessages(messages) {
  return [...messages].sort((a, b) => {
    const time = Number(a.timestamp || 0) - Number(b.timestamp || 0);
    return time || String(a.id).localeCompare(String(b.id));
  }).slice(-MAX_ROOM_MESSAGES);
}

function resizeProfilePhoto(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const size = 256;
      const scale = Math.min(size / image.width, size / image.height, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(objectUrl);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('invalid-image'));
    };
    image.src = objectUrl;
  });
}

function audioConstraints(deviceId = '') {
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

function resizeChatImage(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const render = (maxSize, quality) => {
        const scale = Math.min(maxSize / image.width, maxSize / image.height, 1);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', quality);
      };

      let dataUrl = render(1280, 0.8);
      if (dataUrl.length > 1_200_000) dataUrl = render(960, 0.68);
      if (dataUrl.length > 1_200_000) dataUrl = render(768, 0.56);
      URL.revokeObjectURL(objectUrl);
      if (dataUrl.length > 1_200_000) {
        reject(new Error('image-too-large'));
        return;
      }
      resolve(dataUrl);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('invalid-image'));
    };
    image.src = objectUrl;
  });
}

function mediaErrorMessage(error, fallback) {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
    return 'A permissão foi bloqueada. Libere câmera, microfone ou captura de tela nas configurações do aplicativo e tente novamente.';
  }
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    return 'Nenhum dispositivo compatível foi encontrado.';
  }
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') {
    return 'O dispositivo está sendo usado por outro aplicativo.';
  }
  if (error?.name === 'AbortError') return 'A operação foi cancelada.';
  return fallback;
}

function Avatar({ initials, tone = 'yellow', size = 'md', live = false, src = '', alt = '' }) {
  return (
    <span className={`avatar avatar-${size} avatar-${tone}`}>
      {src ? <img src={src} alt={alt} /> : initials}
      {live && <span className="avatar-live" />}
    </span>
  );
}

function IconButton({ label, children, className = '', onClick, active = false, disabled = false }) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? 'is-active' : ''} ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function MediaElement({ stream, muted = false, sinkId = '', className = '' }) {
  const mediaRef = useRef(null);
  const hasVideo = Boolean(stream?.getVideoTracks?.().length);

  useEffect(() => {
    if (!mediaRef.current || !stream) return;
    const media = mediaRef.current;
    media.srcObject = stream;
    if (sinkId && typeof media.setSinkId === 'function') media.setSinkId(sinkId).catch(() => {});
    media.play?.().catch(() => {});
  }, [stream, hasVideo, sinkId]);

  if (!stream) return null;
  return (
    <video
      ref={mediaRef}
      className={`${className} ${hasVideo ? 'media-visible' : 'media-audio-only'}`}
      autoPlay
      playsInline
      muted={muted}
    />
  );
}

function SignalBadge({ status, peerCount }) {
  const isConnected = status === 'connected';
  return (
    <div className={`signal-badge ${isConnected ? 'is-connected' : ''}`}>
      {isConnected ? <Wifi size={13} /> : <WifiOff size={13} />}
      <span>{isConnected ? `${peerCount} conectado${peerCount === 1 ? '' : 's'}` : 'conectando'}</span>
    </div>
  );
}

function App() {
  const [roomId, setRoomId] = useState(DEFAULT_ROOM_ID);
  const [roomName, setRoomName] = useState(prettyRoomName(DEFAULT_ROOM_ID));
  const [rooms, setRooms] = useState([]);
  const [peers, setPeers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('jump-name') || 'Você');
  const [nameDraft, setNameDraft] = useState(() => localStorage.getItem('jump-name') || 'Você');
  const [profileAvatar, setProfileAvatar] = useState(() => localStorage.getItem('jump-avatar') || '');
  const [editingName, setEditingName] = useState(false);
  const [roomDraft, setRoomDraft] = useState('');
  const [showRoomCreator, setShowRoomCreator] = useState(false);
  const [roomSearch, setRoomSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [audioInputDevices, setAudioInputDevices] = useState([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState([]);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState(() => localStorage.getItem('jump-audio-input') || '');
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState(() => localStorage.getItem('jump-audio-output') || '');
  const [showDeviceSettings, setShowDeviceSettings] = useState(false);
  const [signalStatus, setSignalStatus] = useState('connecting');
  const [remoteStreams, setRemoteStreams] = useState({});
  const [permissionError, setPermissionError] = useState('');
  const [copied, setCopied] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [updateState, setUpdateState] = useState({ status: 'idle' });

  const wsRef = useRef(null);
  const profilePhotoInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const messagesRef = useRef(messages);
  const peerIdRef = useRef('');
  const roomIdRef = useRef(DEFAULT_ROOM_ID);
  const roomNameRef = useRef(prettyRoomName(DEFAULT_ROOM_ID));
  const displayNameRef = useRef(displayName);
  const profileAvatarRef = useRef(profileAvatar);
  const peerConnectionsRef = useRef(new Map());
  const remoteStreamsRef = useRef(new Map());
  const pendingCandidatesRef = useRef(new Map());
  const dataChunksRef = useRef(new Map());
  const audioStreamRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const inCallRef = useRef(false);
  const isMutedRef = useRef(isMuted);
  const audioInputIdRef = useRef(selectedAudioInputId);
  const makeOfferRef = useRef(null);

  useEffect(() => { displayNameRef.current = displayName; }, [displayName]);
  useEffect(() => { profileAvatarRef.current = profileAvatar; }, [profileAvatar]);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { audioInputIdRef.current = selectedAudioInputId; }, [selectedAudioInputId]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => {
    const unsubscribe = globalThis.jumpDesktop?.onUpdateState((state) => setUpdateState(state));
    return () => unsubscribe?.();
  }, []);

  const sendSignal = useCallback((payload) => {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }, []);

  const closePeer = useCallback((peerId) => {
    const slot = peerConnectionsRef.current.get(peerId);
    slot?.pc.close();
    peerConnectionsRef.current.delete(peerId);
    pendingCandidatesRef.current.delete(peerId);
    [...dataChunksRef.current.keys()].filter((key) => key.startsWith(`${peerId}:`)).forEach((key) => dataChunksRef.current.delete(key));
    remoteStreamsRef.current.delete(peerId);
    setRemoteStreams((current) => {
      const next = { ...current };
      delete next[peerId];
      return next;
    });
  }, []);

  const broadcastRoomData = useCallback((payload, exceptPeerId = '') => {
    peerConnectionsRef.current.forEach((slot, peerId) => {
      if (peerId === exceptPeerId || slot.dataChannel?.readyState !== 'open') return;
      try { sendDataChannelPacket(slot.dataChannel, payload); } catch { /* The peer may be closing. */ }
    });
  }, []);

  const mergeMessages = useCallback((incoming, sourcePeerId = '') => {
    const current = messagesRef.current;
    const byId = new Map(current.map((message) => [message.id, message]));
    const added = [];
    (incoming || []).forEach((message) => {
      if (!message?.id || byId.has(message.id)) return;
      const normalized = formatMessage(message);
      byId.set(normalized.id, normalized);
      added.push(normalized);
    });
    if (!added.length) return [];
    const merged = sortRoomMessages([...byId.values()]);
    messagesRef.current = merged;
    setMessages(merged);
    void writeRoomMessages(roomIdRef.current, merged);
    broadcastRoomData({ type: 'messages', roomId: roomIdRef.current, messages: added }, sourcePeerId);
    return added;
  }, [broadcastRoomData]);

  const loadRoomMessages = useCallback(async (targetRoomId) => {
    const stored = (await readRoomMessages(targetRoomId)).map(formatMessage);
    if (roomIdRef.current !== targetRoomId) return;
    const byId = new Map(messagesRef.current.map((message) => [message.id, message]));
    stored.forEach((message) => byId.set(message.id, message));
    const ordered = sortRoomMessages([...byId.values()]);
    messagesRef.current = ordered;
    setMessages(ordered);
    void writeRoomMessages(targetRoomId, ordered);
  }, []);

  const attachDataChannel = useCallback((peerId, channel) => {
    const slot = peerConnectionsRef.current.get(peerId);
    if (!slot) return;
    slot.dataChannel = channel;
    channel.binaryType = 'arraybuffer';

    const requestSync = () => {
      if (channel.readyState !== 'open') return;
      sendDataChannelPacket(channel, {
        type: 'sync-request',
        roomId: roomIdRef.current,
        knownIds: messagesRef.current.map((message) => message.id),
      });
    };

    const handlePayload = (payload) => {
      if (payload.roomId !== roomIdRef.current) return;
      if (payload.type === 'sync-request') {
        const knownIds = new Set(payload.knownIds || []);
        const missing = messagesRef.current.filter((message) => !knownIds.has(message.id));
        for (let index = 0; index < missing.length; index += 40) {
          sendDataChannelPacket(channel, { type: 'messages', roomId: roomIdRef.current, messages: missing.slice(index, index + 40) });
        }
        return;
      }
      if (payload.type === 'messages') mergeMessages(payload.messages, peerId);
    };

    channel.onopen = requestSync;
    channel.onmessage = (event) => {
      try {
        const payload = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
        if (payload.type === 'data-chunk') {
          if (payload.roomId !== roomIdRef.current || !Number.isInteger(payload.index) || !Number.isInteger(payload.total) || payload.index < 0 || payload.index >= payload.total) return;
          const chunkKey = `${peerId}:${payload.transferId}`;
          const current = dataChunksRef.current.get(chunkKey) || { total: payload.total, parts: [] };
          if (current.total !== payload.total) return;
          current.parts[payload.index] = payload.data;
          dataChunksRef.current.set(chunkKey, current);
          if (current.parts.length === current.total && current.parts.every((part) => typeof part === 'string')) {
            dataChunksRef.current.delete(chunkKey);
            handlePayload(JSON.parse(current.parts.join('')));
          }
          return;
        }
        handlePayload(payload);
      } catch {
        setPermissionError('Não foi possível sincronizar o histórico desta sala.');
      }
    };
    channel.onclose = () => {
      const current = peerConnectionsRef.current.get(peerId);
      if (current?.dataChannel === channel) current.dataChannel = null;
    };
    if (channel.readyState === 'open') requestSync();
  }, [mergeMessages]);

  const makeOffer = useCallback(async (peerId) => {
    const slot = peerConnectionsRef.current.get(peerId);
    if (!slot || slot.pc.signalingState !== 'stable') return;
    try {
      const offer = await slot.pc.createOffer();
      await slot.pc.setLocalDescription(offer);
      sendSignal({ type: 'signal', target: peerId, data: { type: 'offer', sdp: slot.pc.localDescription } });
    } catch {
      setPermissionError('Não foi possível iniciar esta conexão P2P.');
    }
  }, [sendSignal]);

  makeOfferRef.current = makeOffer;

  const createPeerConnection = useCallback((peerId, initiator = false) => {
    const existing = peerConnectionsRef.current.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
    const slot = { pc, audioSender: audioTransceiver.sender, videoSender: videoTransceiver.sender, dataChannel: null };
    peerConnectionsRef.current.set(peerId, slot);

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ type: 'signal', target: peerId, data: { type: 'candidate', candidate: event.candidate } });
    };

    pc.ontrack = (event) => {
      const incoming = event.streams?.[0] || remoteStreamsRef.current.get(peerId) || new MediaStream();
      if (!event.streams?.[0] && !incoming.getTracks().includes(event.track)) incoming.addTrack(event.track);
      remoteStreamsRef.current.set(peerId, incoming);
      setRemoteStreams((current) => ({ ...current, [peerId]: { stream: incoming } }));
    };

    pc.ondatachannel = (event) => attachDataChannel(peerId, event.channel);

    if (audioStreamRef.current?.getAudioTracks()[0]) slot.audioSender.replaceTrack(audioStreamRef.current.getAudioTracks()[0]);
    if (cameraStreamRef.current?.getVideoTracks()[0]) slot.videoSender.replaceTrack(cameraStreamRef.current.getVideoTracks()[0]);
    if (screenStreamRef.current?.getVideoTracks()[0]) slot.videoSender.replaceTrack(screenStreamRef.current.getVideoTracks()[0]);
    if (initiator) attachDataChannel(peerId, pc.createDataChannel('room-data', { ordered: true }));
    if (initiator) window.setTimeout(() => makeOfferRef.current?.(peerId), 80);
    return slot;
  }, [attachDataChannel, sendSignal]);

  const handleSignalMessage = useCallback(async (message) => {
    if (message.type === 'hello') {
      peerIdRef.current = message.peerId;
      return;
    }
    if (message.type === 'rooms-state') {
      setRooms(message.rooms || []);
      return;
    }
    if (message.type === 'room-state') {
      const nextPeers = Array.isArray(message.peers) ? message.peers : [];
      roomIdRef.current = message.roomId;
      roomNameRef.current = message.name || prettyRoomName(message.roomId);
      setRoomId(message.roomId);
      setRoomName(roomNameRef.current);
      setPeers(nextPeers);
      void loadRoomMessages(message.roomId);
      nextPeers.forEach((peer) => createPeerConnection(peer.peerId, true));
      return;
    }
    if (message.type === 'peer-joined') {
      setPeers((current) => current.some((peer) => peer.peerId === message.peer.peerId) ? current : [...current, message.peer]);
      return;
    }
    if (message.type === 'peer-updated') {
      setPeers((current) => current.map((peer) => peer.peerId === message.peer.peerId ? message.peer : peer));
      return;
    }
    if (message.type === 'peer-left') {
      closePeer(message.peerId);
      setPeers((current) => current.filter((peer) => peer.peerId !== message.peerId));
      return;
    }
    if (message.type !== 'signal') return;

    const { from, data } = message;
    const slot = createPeerConnection(from, false);
    try {
      if (data.type === 'offer') {
        await slot.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const pending = pendingCandidatesRef.current.get(from) || [];
        await Promise.all(pending.map((candidate) => slot.pc.addIceCandidate(candidate)));
        pendingCandidatesRef.current.delete(from);
        const answer = await slot.pc.createAnswer();
        await slot.pc.setLocalDescription(answer);
        sendSignal({ type: 'signal', target: from, data: { type: 'answer', sdp: slot.pc.localDescription } });
      } else if (data.type === 'answer') {
        await slot.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const pending = pendingCandidatesRef.current.get(from) || [];
        await Promise.all(pending.map((candidate) => slot.pc.addIceCandidate(candidate)));
        pendingCandidatesRef.current.delete(from);
      } else if (data.type === 'candidate') {
        if (slot.pc.remoteDescription) await slot.pc.addIceCandidate(data.candidate);
        else pendingCandidatesRef.current.set(from, [...(pendingCandidatesRef.current.get(from) || []), data.candidate]);
      }
    } catch {
      setPermissionError('A conexão com este participante foi interrompida.');
    }
  }, [closePeer, createPeerConnection, loadRoomMessages, sendSignal]);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    let signalUrl = `${protocol}://${window.location.host}/signal`;
    if (SIGNAL_ORIGIN) {
      try {
        const signalOrigin = new URL(SIGNAL_ORIGIN);
        signalUrl = `${signalOrigin.protocol === 'https:' ? 'wss' : 'ws'}://${signalOrigin.host}/signal`;
      } catch {
        setSignalStatus('offline');
      }
    }
    let disposed = false;
    let retryTimer = 0;
    let socket;
    const scheduleReconnect = () => {
      if (disposed || retryTimer) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        connect();
      }, 2000);
    };
    const connect = () => {
      if (disposed) return;
      try {
        socket = new WebSocket(signalUrl);
        wsRef.current = socket;
        socket.onopen = () => {
          setSignalStatus('connected');
          sendSignal({ type: 'join', roomId: roomIdRef.current, roomName: roomNameRef.current, name: displayNameRef.current, avatar: profileAvatarRef.current });
        };
        socket.onmessage = (event) => {
          try { handleSignalMessage(JSON.parse(event.data)); } catch { /* Ignore malformed packets. */ }
        };
        socket.onerror = () => setSignalStatus('offline');
        socket.onclose = () => {
          if (wsRef.current === socket) wsRef.current = null;
          setSignalStatus('offline');
          scheduleReconnect();
        };
      } catch {
        setSignalStatus('offline');
        scheduleReconnect();
      }
    };
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      socket?.close();
      peerConnectionsRef.current.forEach(({ pc }) => pc.close());
      audioStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [handleSignalMessage, sendSignal]);

  useEffect(() => {
    void loadRoomMessages(roomIdRef.current);
  }, [loadRoomMessages]);

  const refreshAudioDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === 'audioinput');
      const outputs = devices.filter((device) => device.kind === 'audiooutput');
      setAudioInputDevices(inputs);
      setAudioOutputDevices(outputs);
      setSelectedAudioInputId((current) => {
        if (!current || inputs.some((device) => device.deviceId === current)) return current;
        audioInputIdRef.current = '';
        localStorage.removeItem('jump-audio-input');
        return '';
      });
      setSelectedAudioOutputId((current) => {
        if (!current || outputs.some((device) => device.deviceId === current)) return current;
        localStorage.removeItem('jump-audio-output');
        return '';
      });
    } catch {
      setPermissionError('Não foi possível listar os dispositivos de áudio.');
    }
  }, []);

  useEffect(() => {
    void refreshAudioDevices();
    const mediaDevices = navigator.mediaDevices;
    mediaDevices?.addEventListener?.('devicechange', refreshAudioDevices);
    return () => mediaDevices?.removeEventListener?.('devicechange', refreshAudioDevices);
  }, [refreshAudioDevices]);

  const startCall = useCallback(async () => {
    if (inCallRef.current) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      setPermissionError('Seu navegador não liberou chamadas de áudio neste contexto.');
      return false;
    }
    try {
      setPermissionError('');
      const stream = await navigator.mediaDevices.getUserMedia(audioConstraints(audioInputIdRef.current));
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('no-audio-track');
      audioStreamRef.current = stream;
      track.enabled = !isMutedRef.current;
      peerConnectionsRef.current.forEach(({ audioSender }) => audioSender.replaceTrack(track));
      inCallRef.current = true;
      setInCall(true);
      void refreshAudioDevices();
      return true;
    } catch (error) {
      setPermissionError(mediaErrorMessage(error, 'Permita o microfone para entrar na chamada.'));
      return false;
    }
  }, [refreshAudioDevices]);

  const switchAudioInput = useCallback(async (deviceId) => {
    if (!inCallRef.current) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(audioConstraints(deviceId));
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('no-audio-track');
      track.enabled = !isMutedRef.current;
      const previousStream = audioStreamRef.current;
      audioStreamRef.current = stream;
      await Promise.allSettled([...peerConnectionsRef.current.values()].map(({ audioSender }) => audioSender.replaceTrack(track)));
      previousStream?.getTracks().forEach((oldTrack) => oldTrack.stop());
      void refreshAudioDevices();
      setPermissionError('');
      return true;
    } catch (error) {
      setPermissionError(mediaErrorMessage(error, 'Não foi possível trocar o microfone.'));
      return false;
    }
  }, [refreshAudioDevices]);

  const leaveCall = useCallback(() => {
    audioStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    audioStreamRef.current = null;
    cameraStreamRef.current = null;
    screenStreamRef.current = null;
    peerConnectionsRef.current.forEach(({ audioSender, videoSender }) => {
      audioSender.replaceTrack(null);
      videoSender.replaceTrack(null);
    });
    inCallRef.current = false;
    isMutedRef.current = false;
    setInCall(false);
    setIsCameraOn(false);
    setIsSharing(false);
    setIsMuted(false);
  }, []);

  const joinRoom = useCallback((nextRoomId, nextRoomName = '') => {
    const normalizedId = slugify(nextRoomId);
    const normalizedName = String(nextRoomName || prettyRoomName(normalizedId)).trim().slice(0, 48);
    leaveCall();
    peerConnectionsRef.current.forEach(({ pc }) => pc.close());
    peerConnectionsRef.current.clear();
    remoteStreamsRef.current.clear();
    pendingCandidatesRef.current.clear();
    dataChunksRef.current.clear();
    setRemoteStreams({});
    setPeers([]);
    messagesRef.current = [];
    setMessages([]);
    setPermissionError('');
    roomIdRef.current = normalizedId;
    roomNameRef.current = normalizedName;
    setRoomId(normalizedId);
    setRoomName(normalizedName);
    void loadRoomMessages(normalizedId);
    window.history.replaceState({}, '', `${window.location.pathname}?room=${encodeURIComponent(normalizedId)}`);
    sendSignal({ type: 'join', roomId: normalizedId, roomName: normalizedName, name: displayNameRef.current, avatar: profileAvatarRef.current });
    setMobileSidebarOpen(false);
  }, [leaveCall, loadRoomMessages, sendSignal]);

  const toggleMute = useCallback(async () => {
    if (!inCallRef.current && !(await startCall())) return;
    const nextMuted = !isMutedRef.current;
    isMutedRef.current = nextMuted;
    audioStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !nextMuted; });
    setIsMuted(nextMuted);
  }, [startCall]);

  const toggleDeafen = useCallback(() => setIsDeafened((value) => !value), []);

  const handleAudioInputChange = useCallback(async (event) => {
    const nextId = event.target.value;
    const previousId = audioInputIdRef.current;
    audioInputIdRef.current = nextId;
    setSelectedAudioInputId(nextId);
    if (nextId) localStorage.setItem('jump-audio-input', nextId);
    else localStorage.removeItem('jump-audio-input');
    if (inCallRef.current && !(await switchAudioInput(nextId))) {
      audioInputIdRef.current = previousId;
      setSelectedAudioInputId(previousId);
      if (previousId) localStorage.setItem('jump-audio-input', previousId);
      else localStorage.removeItem('jump-audio-input');
    }
  }, [switchAudioInput]);

  const handleAudioOutputChange = useCallback((event) => {
    const nextId = event.target.value;
    setSelectedAudioOutputId(nextId);
    if (nextId) localStorage.setItem('jump-audio-output', nextId);
    else localStorage.removeItem('jump-audio-output');
  }, []);

  const toggleCamera = useCallback(async () => {
    if (!inCallRef.current && !(await startCall())) return;
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      peerConnectionsRef.current.forEach(({ videoSender }) => videoSender.replaceTrack(null));
      setIsCameraOn(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      cameraStreamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      peerConnectionsRef.current.forEach(({ videoSender }) => videoSender.replaceTrack(track));
      setIsCameraOn(true);
    } catch (error) {
      setPermissionError(mediaErrorMessage(error, 'Permita a câmera para ligar seu vídeo.'));
    }
  }, [startCall]);

  const stopScreenShare = useCallback(() => {
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    const fallbackTrack = cameraStreamRef.current?.getVideoTracks()[0] || null;
    peerConnectionsRef.current.forEach(({ videoSender }) => videoSender.replaceTrack(fallbackTrack));
    setIsSharing(false);
  }, []);

  const toggleScreenShare = useCallback(async () => {
    if (screenStreamRef.current) {
      stopScreenShare();
      return;
    }
    if (!inCallRef.current && !(await startCall())) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setPermissionError('O compartilhamento de tela não está disponível neste navegador.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('no-screen-track');
      screenStreamRef.current = stream;
      peerConnectionsRef.current.forEach(({ videoSender }) => videoSender.replaceTrack(track));
      track.onended = stopScreenShare;
      setIsSharing(true);
    } catch (error) {
      setPermissionError(mediaErrorMessage(error, 'Não foi possível iniciar o compartilhamento de tela.'));
    }
  }, [startCall, stopScreenShare]);

  const publishMessage = useCallback((payload) => {
    const text = String(payload?.text || '').trim();
    if (!text && !payload?.image) return;
    mergeMessages([{
      id: messageId(),
      roomId: roomIdRef.current,
      senderId: peerIdRef.current || 'local',
      senderName: displayNameRef.current,
      senderAvatar: profileAvatarRef.current,
      text,
      image: payload?.image || '',
      imageName: String(payload?.imageName || '').slice(0, 120),
      timestamp: Date.now(),
    }]);
  }, [mergeMessages]);

  const sendMessage = useCallback((event) => {
    event.preventDefault();
    const cleanDraft = draft.trim();
    if (!cleanDraft) return;
    publishMessage({ text: cleanDraft });
    setDraft('');
  }, [draft, publishMessage]);

  const handleImageFile = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 12 * 1024 * 1024) {
      setPermissionError('Escolha uma imagem de até 12 MB.');
      return;
    }
    try {
      setPermissionError('');
      const image = await resizeChatImage(file);
      publishMessage({ image, imageName: file.name });
    } catch (error) {
      setPermissionError(error?.message === 'image-too-large'
        ? 'Essa imagem ficou grande demais para enviar pela conexão P2P.'
        : 'Não foi possível preparar essa imagem.');
    }
  }, [publishMessage]);

  const saveName = useCallback((event) => {
    event?.preventDefault();
    const nextName = nameDraft.trim().slice(0, 32);
    if (!nextName) return;
    localStorage.setItem('jump-name', nextName);
    displayNameRef.current = nextName;
    setDisplayName(nextName);
    setEditingName(false);
    sendSignal({ type: 'profile', name: nextName, avatar: profileAvatarRef.current });
  }, [nameDraft, sendSignal]);

  const handleProfilePhoto = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 8 * 1024 * 1024) {
      setPermissionError('Escolha uma imagem de até 8 MB.');
      return;
    }
    try {
      const avatar = await resizeProfilePhoto(file);
      localStorage.setItem('jump-avatar', avatar);
      setProfileAvatar(avatar);
      sendSignal({ type: 'profile', name: displayNameRef.current, avatar });
    } catch {
      setPermissionError('Não foi possível carregar essa foto.');
    }
  }, [sendSignal]);

  const createRoom = useCallback((event) => {
    event.preventDefault();
    const label = roomDraft.trim();
    if (!label) return;
    joinRoom(slugify(label), label);
    setRoomDraft('');
    setShowRoomCreator(false);
  }, [joinRoom, roomDraft]);

  const copyInvite = useCallback(async () => {
    const invite = globalThis.jumpDesktop?.getInviteUrl
      ? await globalThis.jumpDesktop.getInviteUrl(roomIdRef.current)
      : `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomIdRef.current)}`;
    try {
      await navigator.clipboard.writeText(invite);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setPermissionError('Copie o link pela barra do navegador.');
    }
  }, []);

  const handleUpdate = useCallback(async () => {
    const desktop = globalThis.jumpDesktop;
    if (!desktop) return;
    try {
      if (updateState.status === 'available') return desktop.downloadUpdate();
      if (updateState.status === 'downloaded') return desktop.installUpdate();
      return desktop.checkForUpdates();
    } catch (error) {
      setUpdateState({ status: 'error', message: error.message });
    }
  }, [updateState.status]);

  const isDesktop = Boolean(globalThis.jumpDesktop?.isDesktop);
  const updateBusy = ['checking', 'downloading'].includes(updateState.status);
  const updateLabel = updateState.status === 'available'
    ? 'baixar update'
    : updateState.status === 'downloaded'
      ? 'reiniciar e atualizar'
      : updateState.status === 'downloading'
        ? `baixando ${updateState.percent || 0}%`
        : updateState.status === 'checking'
          ? 'verificando'
          : updateState.status === 'not-available'
            ? 'já está atualizado'
            : updateState.status === 'error'
              ? 'tentar atualização'
              : 'atualizar';

  const peerCount = signalStatus === 'connected' ? peers.length + 1 : 0;
  const participants = useMemo(() => [
    { peerId: 'self', name: displayName, avatar: profileAvatar, self: true },
    ...peers,
  ], [displayName, peers, profileAvatar]);
  const remoteEntries = useMemo(() => Object.entries(remoteStreams), [remoteStreams]);
  const firstRemote = remoteEntries[0]?.[1];
  const firstRemoteVideo = remoteEntries.find(([, value]) => value.stream?.getVideoTracks?.().length)?.[1];
  const activeCallParticipants = useMemo(() => participants.filter((person) => person.self ? inCall : Boolean(remoteStreams[person.peerId])), [inCall, participants, remoteStreams]);
  const hasActiveCall = Boolean(inCall || remoteEntries.length);
  const filteredRooms = rooms.filter((room) => `${room.name} ${room.id}`.toLowerCase().includes(roomSearch.toLowerCase()));

  return (
    <div className="app-shell">
      <nav className="server-rail" aria-label="Navegação principal">
        <div className="rail-brand">J<span>.</span></div>
        <div className="rail-divider" />
        <IconButton label="Início" className="rail-button is-selected"><Home size={19} /></IconButton>
        <IconButton label="Salas públicas"><Sparkles size={19} /></IconButton>
        <IconButton label="Mensagens"><Inbox size={19} /><span className="rail-dot" /></IconButton>
        <div className="rail-spacer" />
        <IconButton label="Ajuda"><CircleHelp size={18} /></IconButton>
        <IconButton label="Configurações"><Settings2 size={18} /></IconButton>
        <Avatar initials={initialsFor(displayName)} tone="yellow" size="sm" src={profileAvatar} alt={displayName} />
      </nav>

      <aside className={`workspace-sidebar ${mobileSidebarOpen ? 'is-mobile-open' : ''}`}>
        <div className="workspace-head">
          <div>
            <p className="eyebrow">rede em tempo real</p>
            <h1>JUMP NETWORK <ChevronDown size={15} /></h1>
          </div>
          <IconButton label="Mais opções"><MoreHorizontal size={18} /></IconButton>
        </div>
        <div className="search-box">
          <Search size={16} />
          <input value={roomSearch} onChange={(event) => setRoomSearch(event.target.value)} placeholder="Buscar uma sala" aria-label="Buscar uma sala" />
          <span className="search-shortcut">⌘ K</span>
        </div>

        <div className="side-scroll">
          <div className="channel-section">
            <div className="section-label"><span>canais</span><MessageCircle size={14} /></div>
            <button type="button" className="channel-row is-current" onClick={() => setMobileSidebarOpen(false)}>
              <MessageCircle size={17} />
              <span>geral</span>
              <small>{messages.length}</small>
            </button>
          </div>

          <div className="channel-section voice-section">
            <div className="section-label"><span>salas online · {rooms.length}</span><Plus size={14} onClick={() => setShowRoomCreator((value) => !value)} /></div>
            {filteredRooms.map((room) => (
              <button type="button" className={`channel-row voice-row ${room.id === roomId ? 'is-current' : ''}`} key={room.id} onClick={() => joinRoom(room.id, room.name)}>
                <Radio size={17} />
                <span>{room.name}</span>
                <small>{room.count}</small>
                {room.id === roomId && <span className="live-mini">aqui</span>}
              </button>
            ))}
            {filteredRooms.length === 0 && <div className="room-empty"><WifiOff size={14} />{signalStatus === 'connected' ? 'nenhuma sala encontrada' : 'conectando à rede...'}</div>}
            {showRoomCreator && (
              <form className="room-creator" onSubmit={createRoom}>
                <input autoFocus value={roomDraft} onChange={(event) => setRoomDraft(event.target.value)} placeholder="nome da nova sala" aria-label="Nome da nova sala" />
                <button type="submit" aria-label="Criar sala"><ArrowUpRight size={14} /></button>
              </form>
            )}
          </div>

          <div className="channel-section people-section">
            <div className="section-label"><span>nesta sala · {peerCount}</span><Users size={14} /></div>
            {participants.map((person) => (
              <div className="person-row" key={person.peerId}>
                <Avatar initials={initialsFor(person.name)} tone={person.self ? 'yellow' : toneFor(person.peerId)} size="sm" src={person.avatar} alt={person.name} live={person.self || Boolean(remoteStreams[person.peerId])} />
                <div><strong>{person.self ? `${person.name} (você)` : person.name}</strong><small>{person.self ? (inCall ? 'no palco' : 'online') : (remoteStreams[person.peerId] ? 'em chamada' : 'online')}</small></div>
                {remoteStreams[person.peerId] && <AudioLines size={15} className="person-wave" />}
              </div>
            ))}
          </div>
        </div>

        <div className="profile-strip">
          <input ref={profilePhotoInputRef} className="hidden-file-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleProfilePhoto} />
          <button type="button" className="profile-avatar-button" onClick={() => profilePhotoInputRef.current?.click()} aria-label="Trocar foto de perfil" title="Trocar foto de perfil">
            <Avatar initials={initialsFor(displayName)} tone="yellow" size="sm" src={profileAvatar} alt={displayName} />
            <span className="profile-photo-badge"><Camera size={10} /></span>
          </button>
          {editingName ? (
            <form className="name-editor" onSubmit={saveName}><input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} aria-label="Seu nome" /><button type="submit"><ArrowUpRight size={13} /></button></form>
          ) : (
            <button type="button" className="profile-name" onClick={() => { setNameDraft(displayName); setEditingName(true); }}><strong>{displayName}</strong><small><span className="online-status" /> online</small></button>
          )}
          <div className="profile-actions"><IconButton label="Editar nome" onClick={() => { setNameDraft(displayName); setEditingName(true); }}><Settings2 size={15} /></IconButton></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button type="button" className="mobile-menu" onClick={() => setMobileSidebarOpen(true)} aria-label="Abrir menu"><PanelLeft size={19} /></button>
          <div className="breadcrumb"><span>JUMP NETWORK</span><span className="slash">/</span><strong>{roomName}</strong></div>
          <div className="topbar-actions">
            {isDesktop && <button type="button" className={`update-button ${updateState.status === 'downloaded' ? 'is-ready' : ''}`} onClick={handleUpdate} disabled={updateBusy}><Download size={14} /> {updateLabel}</button>}
            <SignalBadge status={signalStatus} peerCount={peerCount} />
            <button type="button" className="invite-button" onClick={copyInvite}>{copied ? <CopyCheck size={15} /> : <Link2 size={15} />}{copied ? 'link copiado' : 'copiar convite'}</button>
            <IconButton label="Notificações"><Bell size={17} /></IconButton>
            <IconButton label="Ajuda"><CircleHelp size={17} /></IconButton>
          </div>
        </header>

        <div className="dashboard-scroll">
          <section className="hero-intro">
            <div>
              <div className="hero-kicker"><span className="live-dot" /> sala em tempo real · {peerCount} conectado{peerCount === 1 ? '' : 's'}</div>
              <h2>{roomName} <em>ao vivo.</em></h2>
              <p>áudio, tela e histórico ponto a ponto. O servidor só ajuda a descobrir participantes; mídia e mensagens seguem direto entre os navegadores.</p>
            </div>
            <div className="hero-sticker"><Zap size={17} fill="currentColor" /><span>WebRTC<br />P2P media</span></div>
          </section>

          <div className="content-grid">
            <div className="content-column">
              <section className="stage-card">
                <div className="stage-header">
                  <div className="stage-title"><span className={`recording-pill ${hasActiveCall ? '' : 'is-idle'}`}><span /> {hasActiveCall ? 'AO VIVO' : 'SALA ABERTA'}</span><strong>{roomName}</strong><span className="stage-lock"><LockKeyhole size={12} /> sala pública</span></div>
                  <div className="stage-meta"><Activity size={14} /> sinalização: {signalStatus === 'connected' ? 'ativa' : 'offline'}</div>
                </div>
                <div className="stage-body">
                  <div className={`spotlight-tile ${firstRemoteVideo || isSharing || isCameraOn ? 'has-remote' : ''} ${isSharing ? 'is-sharing' : ''} ${hasActiveCall ? '' : 'is-idle'}`}>
                    {firstRemoteVideo ? (
                      <MediaElement stream={firstRemoteVideo.stream} muted={isDeafened} sinkId={selectedAudioOutputId} className="stage-media" />
                    ) : isSharing ? (
                      <MediaElement stream={screenStreamRef.current} muted className="stage-media" />
                    ) : isCameraOn ? (
                      <MediaElement stream={cameraStreamRef.current} muted className="stage-media" />
                    ) : hasActiveCall ? (
                      <div className="spotlight-avatar"><Avatar initials={initialsFor(firstRemote ? (peers.find((peer) => peer.peerId === remoteEntries[0][0])?.name || 'Participante') : displayName)} tone={firstRemote ? toneFor(remoteEntries[0][0]) : 'yellow'} size="xl" src={firstRemote ? peers.find((peer) => peer.peerId === remoteEntries[0][0])?.avatar : profileAvatar} alt={firstRemote ? (peers.find((peer) => peer.peerId === remoteEntries[0][0])?.name || 'Participante') : displayName} live={Boolean(firstRemote || inCall)} /></div>
                    ) : (
                      <div className="call-empty-state"><span className="call-empty-icon"><PhoneCall size={19} /></span><strong>ninguém na chamada</strong><small>entre na chamada para começar</small></div>
                    )}
                    <div className="spotlight-overlay" />
                    {hasActiveCall ? <><div className="spotlight-info"><span className="speaking-ring"><AudioLines size={14} /></span><div><strong>{firstRemote ? (peers.find((peer) => peer.peerId === remoteEntries[0][0])?.name || 'Participante') : displayName}</strong><small>{isSharing ? 'compartilhando a tela' : firstRemote ? 'participante na sala' : 'você está no palco'}</small></div></div><div className="spotlight-caption">{firstRemote ? 'mídia recebida via P2P' : 'seu áudio está pronto'}</div></> : <div className="spotlight-caption">sala aberta</div>}
                  </div>
                  <div className="stage-side-tiles">
                    {activeCallParticipants.length ? activeCallParticipants.slice(0, 4).map((person) => (
                      <div className={`small-stage-tile participant-tile ${person.self ? 'is-self' : ''}`} key={person.peerId}>
                        {remoteStreams[person.peerId]?.stream?.getVideoTracks?.().length ? <MediaElement stream={remoteStreams[person.peerId].stream} muted={isDeafened} sinkId={selectedAudioOutputId} className="participant-media" /> : <Avatar initials={initialsFor(person.name)} tone={person.self ? 'yellow' : toneFor(person.peerId)} size="lg" src={person.avatar} alt={person.name} live={person.self || Boolean(remoteStreams[person.peerId])} />}
                        <div><strong>{person.self ? `${person.name} (você)` : person.name}</strong><small>{person.self ? (inCall ? 'no palco' : 'online') : remoteStreams[person.peerId] ? 'em chamada' : 'online'}</small></div>
                        {person.self && <span className="participant-tag">você</span>}
                      </div>
                    )) : <div className="small-stage-tile tile-join call-empty-tile"><div className="plus-orb"><PhoneCall size={17} /></div><div><strong>chamada aberta</strong><small>ninguém está ao vivo</small></div></div>}
                  </div>
                </div>
                <div className="remote-audio-streams" aria-hidden="true">
                  {remoteEntries.filter(([, value]) => !value.stream?.getVideoTracks?.().length).map(([peerId, value]) => <MediaElement key={peerId} stream={value.stream} muted={isDeafened} sinkId={selectedAudioOutputId} className="remote-audio-element" />)}
                </div>
                <div className="stage-controls">
                  <div className="stage-control-hint">{inCall ? <><span className="control-live" /> mídia P2P ativa</> : 'entre na sala para habilitar áudio e tela'}</div>
                  <div className="call-controls">
                    <IconButton label={isMuted ? 'Ativar microfone' : 'Silenciar microfone'} className={isMuted ? 'control-off' : ''} active={inCall && !isMuted} onClick={toggleMute}>{isMuted ? <MicOff size={18} /> : <Mic size={18} />}</IconButton>
                    <IconButton label={isDeafened ? 'Ativar áudio' : 'Desativar áudio'} className={isDeafened ? 'control-off' : ''} active={inCall && !isDeafened} onClick={toggleDeafen}>{isDeafened ? <VolumeX size={18} /> : <Headphones size={18} />}</IconButton>
                    <IconButton label={isCameraOn ? 'Desligar câmera' : 'Ligar câmera'} className={isCameraOn ? 'control-on' : ''} active={isCameraOn} onClick={toggleCamera}>{isCameraOn ? <Video size={18} /> : <VideoOff size={18} />}</IconButton>
                    <IconButton label={isSharing ? 'Parar compartilhamento' : 'Compartilhar tela'} className={isSharing ? 'control-on' : ''} active={isSharing} onClick={toggleScreenShare}><MonitorUp size={18} /></IconButton>
                    <IconButton label="Configurar dispositivos de áudio" className={showDeviceSettings ? 'control-on' : ''} active={showDeviceSettings} onClick={() => setShowDeviceSettings((value) => !value)}><Settings2 size={17} /></IconButton>
                    <span className="controls-divider" />
                    {inCall ? <button type="button" className="leave-button" onClick={leaveCall}><PhoneCall size={17} /> sair</button> : <button type="button" className="join-call-button" onClick={startCall}><PhoneCall size={17} /> entrar na chamada</button>}
                  </div>
                </div>
                {showDeviceSettings && (
                  <div className="device-settings-popover" role="dialog" aria-label="Configurações de áudio">
                    <div className="device-settings-heading"><div><span className="card-kicker">dispositivos</span><strong>áudio da chamada</strong></div><button type="button" onClick={refreshAudioDevices} aria-label="Atualizar dispositivos" title="Atualizar dispositivos"><RefreshCw size={14} /></button></div>
                    <label className="device-field"><span><Mic size={14} /> microfone</span><select value={selectedAudioInputId} onChange={handleAudioInputChange}><option value="">microfone padrão</option>{audioInputDevices.map((device, index) => <option key={device.deviceId || `input-${index}`} value={device.deviceId}>{device.label || `microfone ${index + 1}`}</option>)}</select></label>
                    <label className="device-field"><span><Volume2 size={14} /> saída</span><select value={selectedAudioOutputId} onChange={handleAudioOutputChange}><option value="">saída padrão do sistema</option>{audioOutputDevices.map((device, index) => <option key={device.deviceId || `output-${index}`} value={device.deviceId}>{device.label || `saída ${index + 1}`}</option>)}</select></label>
                    <small className="device-settings-hint">A troca do microfone vale imediatamente. A saída usa o seletor do sistema quando o navegador oferece suporte.</small>
                  </div>
                )}
              </section>

              {(permissionError || signalStatus !== 'connected') && <div className={`notice-bar ${permissionError ? 'is-warning' : ''}`}><span>{permissionError || 'Sinalização offline: peers conectados continuam conversando; novas entradas precisam do servidor.'}</span><IconButton label="Fechar aviso" onClick={() => setPermissionError('')}><X size={15} /></IconButton></div>}

              <section className="chat-card">
                <div className="chat-head"><div><span className="card-kicker"># geral · {roomName}</span><h3>conversa da sala</h3></div><div className="chat-head-actions"><span><MessageCircle size={14} /> {messages.length}</span><IconButton label="Mais opções"><MoreHorizontal size={17} /></IconButton></div></div>
                <div className="message-list">
                  {messages.length === 0 ? <div className="empty-chat"><MessageCircle size={18} /><strong>Nenhuma mensagem ainda.</strong><span>Seja a primeira pessoa a escrever nesta sala.</span></div> : messages.map((message) => (
                    <article className="message" key={message.id}>
                      <Avatar initials={message.initials} tone={message.tone} size="md" src={message.avatar} alt={message.senderName} />
                      <div className="message-content"><div className="message-meta"><strong>{message.senderName}</strong><time>{message.time}</time></div>{message.text && <p>{message.text}</p>}{message.image && <div className="message-attachment"><img src={message.image} alt={message.imageName ? `Imagem enviada: ${message.imageName}` : 'Imagem enviada'} loading="lazy" />{message.imageName && <small>{message.imageName}</small>}</div>}</div>
                    </article>
                  ))}
                </div>
                <input ref={imageInputRef} className="hidden-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={handleImageFile} />
                <form className="message-composer" onSubmit={sendMessage}><button type="button" className="composer-add" aria-label="Enviar imagem" title="Enviar imagem" onClick={() => imageInputRef.current?.click()}><Plus size={18} /></button><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="escreva para esta sala" /><button type="button" className="composer-emoji" aria-label="Adicionar emoji">☺</button><button type="submit" className="composer-send" aria-label="Enviar mensagem"><Send size={16} /></button></form>
              </section>
            </div>

          </div>
        </div>
      </main>
    </div>
  );
}

const rootElement = document.getElementById('root');
const jumpRoot = rootElement.__jumpRoot || createRoot(rootElement);
rootElement.__jumpRoot = jumpRoot;
jumpRoot.render(<App />);

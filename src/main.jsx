import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Circle,
  CircleMinus,
  CircleOff,
  Camera,
  Check,
  CircleHelp,
  Download,
  Headphones,
  Info,
  Link2,
  LockKeyhole,
  MessageCircle,
  Mic,
  MicOff,
  MonitorUp,
  Paperclip,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import './styles.css';
import winComputer from './assets/win98/computer.png';
import winPeople from './assets/win98/people.png';
import winGlobe from './assets/win98/globe.png';
import winPhone from './assets/win98/phone.png';
import winUpdate from './assets/win98/update.png';
import winBell from './assets/win98/bell.png';
import winSend from './assets/win98/send.png';
import winPencilEdit from './assets/win98/pencil-edit-64.png';
import winAppIcon from './assets/win98/jump-app-icon.png';
import winConnectionSprite from './assets/win98/connection-sprite.png';
import { CallStreamCard } from './components/CallStreamCard.jsx';
import { PaneResizeHandle } from './components/PaneResizeHandle.jsx';
import { ParticipantVolumePopover } from './components/ParticipantVolumePopover.jsx';
import { ScreenShareDialog } from './components/ScreenShareDialog.jsx';
import { useScreenShare } from './hooks/useScreenShare.js';
import { playTransmissionSound } from './media/callSounds.js';
import { usePeerMesh } from './webrtc/usePeerMesh.js';

const INITIAL_QUERY = new URLSearchParams(window.location.search);
const DEFAULT_ROOM_ID = INITIAL_QUERY.get('room') || 'jump-house';
const SIGNAL_ORIGIN = INITIAL_QUERY.get('signal') || '';
const TONES = ['yellow', 'mint', 'violet', 'coral', 'blue'];
const MAX_ROOM_MESSAGES = 50_000;
const MAX_DIRECT_MESSAGES = 50_000;
const MAX_CONVERSATION_BYTES = 500 * 1024 * 1024;
const MAX_ATTACHMENT_SIZE = 200 * 1024 * 1024;
const MAX_DATA_PACKET_SIZE = 120_000;
const ATTACHMENT_CHUNK_SIZE = 64 * 1024;
const DATA_CHANNEL_HIGH_WATER_MARK = 2 * 1024 * 1024;
const MESSAGE_DB_NAME = 'jump-p2p-local';
const MESSAGE_STORE_NAME = 'room-messages';
const DIRECT_MESSAGE_STORE_NAME = 'direct-messages';
const ATTACHMENT_STORE_NAME = 'message-attachments';
const MESSAGE_DB_VERSION = 3;
const ROOM_PASSWORDS_KEY = 'jump-room-passwords';
const CLIENT_ID_KEY = 'jump-client-id';
const CONTACTS_KEY = 'jump-contacts';
const UNREAD_COUNTS_KEY = 'jump-unread-counts';
const PROFILE_STATUS_KEY = 'jump-profile-status';
const MESSAGE_CLOCK_KEY = 'jump-message-clock';
const CALL_CHAT_SPLIT_KEY = 'jump-call-chat-split';
const SCREEN_SHARE_PROFILE_KEY = 'jump-screen-share-profile';
const MAX_CONTACTS = 100;
const PRESENCE_STATUSES = ['online', 'dnd', 'offline'];
const WIN_ICONS = {
  computer: winComputer,
  people: winPeople,
  globe: winGlobe,
  phone: winPhone,
  update: winUpdate,
  bell: winBell,
  send: winSend,
  pencil: winPencilEdit,
  app: winAppIcon,
};
let messageDbPromise;

function normalizePresenceStatus(value) {
  return PRESENCE_STATUSES.includes(value) ? value : 'online';
}

function presenceLabel(value) {
  const status = normalizePresenceStatus(value);
  if (status === 'dnd') return 'não perturbe';
  if (status === 'offline') return 'offline';
  return 'online';
}

function readContacts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONTACTS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((contact) => contact && (contact.id || contact.clientId || contact.peerId)).slice(0, MAX_CONTACTS);
  } catch {
    return [];
  }
}

function readUnreadCounts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(UNREAD_COUNTS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, Math.max(0, Math.min(99, Number(value) || 0))]));
  } catch {
    return {};
  }
}

function contactIdFor(value) {
  return String(value?.clientId || value?.contactId || value?.id || value?.peerId || '').trim();
}

function directUnreadKey(contactId) {
  return contactId ? `direct:${contactId}` : '';
}

function roomUnreadKey(roomId) {
  return roomId ? `room:${roomId}` : '';
}

function otherConversationParty(conversationId, localClientId) {
  return String(conversationId || '').split('::').find((part) => part && part !== String(localClientId || '')) || '';
}

function readRoomPasswords() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ROOM_PASSWORDS_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function rememberedRoomPassword(roomId) {
  const value = readRoomPasswords()[roomId];
  return typeof value === 'string' ? value : '';
}

function rememberRoomPassword(roomId, password) {
  const clean = String(password || '').trim();
  if (!roomId || !clean) return;
  try {
    localStorage.setItem(ROOM_PASSWORDS_KEY, JSON.stringify({ ...readRoomPasswords(), [roomId]: clean }));
  } catch {
    // A storage failure should not prevent entering the room this time.
  }
}

function forgetRoomPassword(roomId) {
  if (!roomId) return;
  try {
    const passwords = readRoomPasswords();
    delete passwords[roomId];
    localStorage.setItem(ROOM_PASSWORDS_KEY, JSON.stringify(passwords));
  } catch {
    // Ignore storage failures; the access dialog can still be used again.
  }
}

function getClientId() {
  try {
    const stored = localStorage.getItem(CLIENT_ID_KEY);
    if (stored) return stored;
    const generated = globalThis.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, generated);
    return generated;
  } catch {
    return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function WinIcon({ name, size = 20, className = '' }) {
  return <img className={`win-icon ${className}`} src={WIN_ICONS[name]} width={size} height={size} alt="" aria-hidden="true" draggable="false" />;
}

function messageId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatCallDuration(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
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

function formatFileSize(bytes) {
  const size = Math.max(0, Number(bytes) || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function messageStorageBytes(message) {
  const attachmentBytes = Number(message?.attachment?.size) || 0;
  const legacyImageBytes = typeof message?.image === 'string' ? message.image.length * 2 : 0;
  let metadataBytes = 256;
  try {
    metadataBytes += JSON.stringify({ ...message, image: '', attachment: message?.attachment ? { ...message.attachment, ready: undefined } : undefined }).length * 2;
  } catch {
    // A malformed message should still consume a conservative amount of quota.
    metadataBytes += 1024;
  }
  return metadataBytes + legacyImageBytes + attachmentBytes;
}

function messageOrderValue(message) {
  const value = Number(message?.logicalClock);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function compareMessages(a, b) {
  const aClock = messageOrderValue(a);
  const bClock = messageOrderValue(b);
  if (aClock !== null && bClock !== null && aClock !== bClock) return aClock - bClock;
  const time = Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
  if (time) return time;
  if (aClock !== null && bClock === null) return -1;
  if (aClock === null && bClock !== null) return 1;
  const sender = String(a?.senderId || '').localeCompare(String(b?.senderId || ''));
  return sender || String(a?.id || '').localeCompare(String(b?.id || ''));
}

function trimMessagesToBudget(messages, byteBudget = MAX_CONVERSATION_BYTES, maxMessages = MAX_ROOM_MESSAGES) {
  const ordered = [...(messages || [])].sort(compareMessages);
  const retained = [];
  let total = 0;
  for (let index = ordered.length - 1; index >= 0 && retained.length < maxMessages; index -= 1) {
    const message = ordered[index];
    const bytes = messageStorageBytes(message);
    // Preserve the newest message even if a single attachment is larger than
    // the budget; the per-file limit still prevents an unbounded transfer.
    if (retained.length && total + bytes > byteBudget) continue;
    retained.push(message);
    total += bytes;
  }
  return retained.reverse();
}

function attachmentIdsForMessages(messages) {
  return new Set((messages || []).map((message) => message?.attachment?.id).filter(Boolean));
}

function waitForDataChannelDrain(channel) {
  if (!channel || channel.readyState !== 'open' || channel.bufferedAmount <= DATA_CHANNEL_HIGH_WATER_MARK) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      channel.removeEventListener?.('bufferedamountlow', finish);
      window.clearTimeout(timeout);
      resolve();
    };
    channel.bufferedAmountLowThreshold = Math.floor(DATA_CHANNEL_HIGH_WATER_MARK / 2);
    channel.addEventListener?.('bufferedamountlow', finish, { once: true });
    const timeout = window.setTimeout(finish, 250);
  });
}

const ATTACHMENT_FRAME_MAGIC = new Uint8Array([0x4a, 0x50, 0x46, 0x31]); // JPF1
const attachmentFrameEncoder = new TextEncoder();
const attachmentFrameDecoder = new TextDecoder();

function createAttachmentFrame(transferId, index, data) {
  const idBytes = attachmentFrameEncoder.encode(String(transferId || '')).slice(0, 255);
  const payload = data instanceof Uint8Array ? data : new Uint8Array(data);
  const headerSize = ATTACHMENT_FRAME_MAGIC.length + 1 + idBytes.length + 4;
  const frame = new Uint8Array(headerSize + payload.byteLength);
  frame.set(ATTACHMENT_FRAME_MAGIC, 0);
  frame[ATTACHMENT_FRAME_MAGIC.length] = idBytes.length;
  frame.set(idBytes, ATTACHMENT_FRAME_MAGIC.length + 1);
  new DataView(frame.buffer).setUint32(ATTACHMENT_FRAME_MAGIC.length + 1 + idBytes.length, index, true);
  frame.set(payload, headerSize);
  return frame.buffer;
}

function parseAttachmentFrame(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < ATTACHMENT_FRAME_MAGIC.length + 1 + 4) return null;
  if (!ATTACHMENT_FRAME_MAGIC.every((value, index) => bytes[index] === value)) return null;
  const idLength = bytes[ATTACHMENT_FRAME_MAGIC.length];
  const indexOffset = ATTACHMENT_FRAME_MAGIC.length + 1 + idLength;
  const payloadOffset = indexOffset + 4;
  if (bytes.byteLength < payloadOffset) return null;
  return {
    transferId: attachmentFrameDecoder.decode(bytes.slice(ATTACHMENT_FRAME_MAGIC.length + 1, indexOffset)),
    index: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(indexOffset, true),
    payload: bytes.slice(payloadOffset),
  };
}

function openMessageDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (!messageDbPromise) {
    messageDbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(MESSAGE_DB_NAME, MESSAGE_DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(MESSAGE_STORE_NAME)) {
          request.result.createObjectStore(MESSAGE_STORE_NAME, { keyPath: 'roomId' });
        }
        if (!request.result.objectStoreNames.contains(DIRECT_MESSAGE_STORE_NAME)) {
          request.result.createObjectStore(DIRECT_MESSAGE_STORE_NAME, { keyPath: 'conversationId' });
        }
        if (!request.result.objectStoreNames.contains(ATTACHMENT_STORE_NAME)) {
          const attachments = request.result.createObjectStore(ATTACHMENT_STORE_NAME, { keyPath: 'id' });
          attachments.createIndex('conversationId', 'conversationId', { unique: false });
        } else {
          const attachments = request.transaction.objectStore(ATTACHMENT_STORE_NAME);
          if (!attachments.indexNames.contains('conversationId')) attachments.createIndex('conversationId', 'conversationId', { unique: false });
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
        request.onsuccess = () => resolve(trimMessagesToBudget(request.result?.messages || [], MAX_CONVERSATION_BYTES, MAX_ROOM_MESSAGES));
        request.onerror = () => reject(request.error);
      });
    }
    return trimMessagesToBudget(JSON.parse(localStorage.getItem(`jump-room:${roomId}`) || '[]'), MAX_CONVERSATION_BYTES, MAX_ROOM_MESSAGES);
  } catch {
    return [];
  }
}

async function writeRoomMessages(roomId, messages) {
  const safeMessages = trimMessagesToBudget(messages, MAX_CONVERSATION_BYTES, MAX_ROOM_MESSAGES);
  try {
    const db = await openMessageDb();
    if (db) {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(MESSAGE_STORE_NAME, 'readwrite');
        transaction.objectStore(MESSAGE_STORE_NAME).put({ roomId, messages: safeMessages });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      if (safeMessages.length < messages.length) await pruneAttachmentsForConversation(roomId, attachmentIdsForMessages(safeMessages));
      return;
    }
    localStorage.setItem(`jump-room:${roomId}`, JSON.stringify(safeMessages));
  } catch {
    // A storage failure should not stop the live P2P conversation.
  }
}

async function removeRoomMessages(roomId) {
  try {
    const db = await openMessageDb();
    if (db) {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(MESSAGE_STORE_NAME, 'readwrite');
        transaction.objectStore(MESSAGE_STORE_NAME).delete(roomId);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      await removeAttachmentsForConversation(roomId);
      return;
    }
    localStorage.removeItem(`jump-room:${roomId}`);
  } catch {
    // A storage failure should not block the live room transition.
  }
}

async function writeAttachmentBlob(attachmentId, blob, metadata = {}) {
  if (!attachmentId || !blob || !('indexedDB' in window)) return false;
  try {
    const db = await openMessageDb();
    if (!db) return false;
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(ATTACHMENT_STORE_NAME, 'readwrite');
      transaction.objectStore(ATTACHMENT_STORE_NAME).put({
        id: attachmentId,
        conversationId: String(metadata.conversationId || ''),
        name: String(metadata.name || 'arquivo').slice(0, 160),
        type: String(metadata.type || blob.type || 'application/octet-stream').slice(0, 120),
        size: Number(metadata.size) || blob.size,
        blob,
        updatedAt: Date.now(),
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('attachment-write-aborted'));
    });
    return true;
  } catch {
    return false;
  }
}

async function readAttachmentBlob(attachmentId) {
  if (!attachmentId || !('indexedDB' in window)) return null;
  try {
    const db = await openMessageDb();
    if (!db) return null;
    return await new Promise((resolve, reject) => {
      const request = db.transaction(ATTACHMENT_STORE_NAME, 'readonly').objectStore(ATTACHMENT_STORE_NAME).get(attachmentId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

async function removeAttachmentsForConversation(conversationId) {
  return pruneAttachmentsForConversation(conversationId, new Set());
}

async function pruneAttachmentsForConversation(conversationId, keepAttachmentIds = new Set()) {
  if (!conversationId || !('indexedDB' in window)) return;
  const keep = keepAttachmentIds instanceof Set ? keepAttachmentIds : new Set(keepAttachmentIds || []);
  try {
    const db = await openMessageDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(ATTACHMENT_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(ATTACHMENT_STORE_NAME);
      const index = store.indexNames.contains('conversationId') ? store.index('conversationId') : null;
      if (!index) {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        return;
      }
      const request = index.openCursor(IDBKeyRange.only(String(conversationId)));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (!keep.has(cursor.value?.id)) cursor.delete();
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    // Attachment cleanup is best effort; it must not block room navigation.
  }
}

async function readDirectMessages(conversationId) {
  if (!conversationId) return [];
  try {
    const db = await openMessageDb();
    if (db) {
      return await new Promise((resolve, reject) => {
        const request = db.transaction(DIRECT_MESSAGE_STORE_NAME, 'readonly').objectStore(DIRECT_MESSAGE_STORE_NAME).get(conversationId);
        request.onsuccess = () => resolve(trimMessagesToBudget(request.result?.messages || [], MAX_CONVERSATION_BYTES, MAX_DIRECT_MESSAGES));
        request.onerror = () => reject(request.error);
      });
    }
    return trimMessagesToBudget(JSON.parse(localStorage.getItem(`jump-direct:${conversationId}`) || '[]'), MAX_CONVERSATION_BYTES, MAX_DIRECT_MESSAGES);
  } catch {
    return [];
  }
}

async function writeDirectMessages(conversationId, messages) {
  if (!conversationId) return;
  const safeMessages = trimMessagesToBudget(messages, MAX_CONVERSATION_BYTES, MAX_DIRECT_MESSAGES);
  try {
    const db = await openMessageDb();
    if (db) {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(DIRECT_MESSAGE_STORE_NAME, 'readwrite');
        transaction.objectStore(DIRECT_MESSAGE_STORE_NAME).put({ conversationId, messages: safeMessages });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      if (safeMessages.length < messages.length) await pruneAttachmentsForConversation(conversationId, attachmentIdsForMessages(safeMessages));
      return;
    }
    localStorage.setItem(`jump-direct:${conversationId}`, JSON.stringify(safeMessages));
  } catch {
    // A storage failure should not stop the live P2P conversation.
  }
}

async function readStoredDirectContacts(localClientId) {
  const records = [];
  try {
    const db = await openMessageDb();
    if (db) {
      const stored = await new Promise((resolve, reject) => {
        const request = db.transaction(DIRECT_MESSAGE_STORE_NAME, 'readonly').objectStore(DIRECT_MESSAGE_STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      records.push(...stored);
    } else {
      Object.keys(localStorage).filter((key) => key.startsWith('jump-direct:')).forEach((key) => {
        try {
          records.push({ conversationId: key.slice('jump-direct:'.length), messages: JSON.parse(localStorage.getItem(key) || '[]') });
        } catch {
          // Ignore malformed legacy conversations.
        }
      });
    }
  } catch {
    return [];
  }

  const contacts = new Map();
  records.forEach((record) => {
    const conversationId = String(record?.conversationId || '');
    const contactId = otherConversationParty(conversationId, localClientId);
    if (!contactId) return;
    const messages = Array.isArray(record?.messages) ? [...record.messages].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0)) : [];
    const remoteMessage = messages.find((message) => message?.senderId && message.senderId !== localClientId);
    const fallbackRecipient = messages.find((message) => message?.recipientId === contactId);
    const source = remoteMessage || fallbackRecipient;
    if (!source) return;
    contacts.set(contactId, {
      id: contactId,
      clientId: contactId,
      peerId: '',
      name: source.senderId === localClientId ? source.recipientName : source.senderName,
      avatar: source.senderId === localClientId ? source.recipientAvatar : (source.senderAvatar || source.avatar || ''),
      status: 'offline',
      connected: false,
      lastSeen: Number(source.timestamp || 0),
    });
  });
  return [...contacts.values()].filter((contact) => contact.name);
}

function directConversationId(firstId, secondId) {
  return [String(firstId || ''), String(secondId || '')].sort().join('::');
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

function systemMessageId(roomId, type, key) {
  return `system:${roomId}:${type}:${key}`;
}

function roomCreatedMessage(roomId, createdAt, createdBy) {
  const createdDate = new Date(createdAt || Date.now()).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  return {
    id: systemMessageId(roomId, 'created', createdAt || 'unknown'),
    roomId,
    kind: 'system',
    eventType: 'room-created',
    senderId: 'system',
    senderName: 'JUMP',
    text: `sala criada em ${createdDate}${createdBy ? ` por ${createdBy}` : ''}`,
    timestamp: createdAt || Date.now(),
  };
}

function roomJoinedMessage(roomId, actorId, name, joinedAt) {
  return {
    id: systemMessageId(roomId, 'joined', actorId || 'unknown'),
    roomId,
    kind: 'system',
    eventType: 'room-joined',
    senderId: 'system',
    senderName: 'JUMP',
    text: `${name || 'alguém'} entrou na sala`,
    timestamp: joinedAt || Date.now(),
  };
}

function isRoomCreatedSystemMessage(message) {
  if (!message || message.kind !== 'system') return false;
  return message.eventType === 'room-created'
    || /^sala criada\s+em\b/i.test(String(message.text || ''))
    || /^system:[^:]+:created:/.test(String(message.id || ''));
}

function sortRoomMessages(messages) {
  const createdRooms = new Set();
  return [...messages].sort((a, b) => {
    return compareMessages(a, b);
  }).filter((message) => {
    if (!isRoomCreatedSystemMessage(message)) return true;
    const key = String(message.roomId || 'unknown');
    if (createdRooms.has(key)) return false;
    createdRooms.add(key);
    return true;
  }).slice(-MAX_ROOM_MESSAGES);
}

function sortDirectMessages(messages) {
  return [...messages].sort(compareMessages).slice(-MAX_DIRECT_MESSAGES);
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

function PresenceIcon({ status = 'online', size = 14, className = '' }) {
  const normalized = normalizePresenceStatus(status);
  const Icon = normalized === 'offline' ? CircleOff : normalized === 'dnd' ? CircleMinus : Circle;
  return <Icon className={`presence-icon presence-icon-${normalized} ${className}`} size={size} strokeWidth={2.5} aria-hidden="true" />;
}

function PresenceDot({ status = 'online' }) {
  const normalized = normalizePresenceStatus(status);
  return <span className={`presence-dot presence-dot-${normalized}`} aria-label={presenceLabel(normalized)} title={presenceLabel(normalized)} />;
}

function Avatar({ initials, tone = 'yellow', size = 'md', live = false, presence = '', speaking = false, src = '', alt = '' }) {
  return (
    <span className={`avatar avatar-${size} avatar-${tone} ${presence ? 'has-presence' : ''} ${speaking ? 'is-speaking' : ''}`}>
      {src ? <img src={src} alt={alt} /> : initials}
      {presence ? <PresenceDot status={presence} /> : live && <span className="avatar-live" />}
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

function MessageAttachment({ message }) {
  const attachment = message?.attachment;
  const [objectUrl, setObjectUrl] = useState('');
  // Metadata may arrive before the binary transfer. Start indeterminate and
  // let the local IDB lookup or transfer events mark it as ready.
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!attachment?.id) return undefined;
    let disposed = false;
    let currentUrl = '';
    const load = async () => {
      const record = await readAttachmentBlob(attachment.id);
      if (disposed || !record?.blob) return;
      currentUrl = URL.createObjectURL(record.blob);
      setObjectUrl(currentUrl);
      setProgress(100);
    };
    const onProgress = (event) => {
      if (event.detail?.attachmentId === attachment.id) setProgress(Math.max(0, Math.min(100, Number(event.detail.percent) || 0)));
    };
    const onReady = (event) => {
      if (event.detail?.attachmentId === attachment.id) void load();
    };
    window.addEventListener('jump:attachment-progress', onProgress);
    window.addEventListener('jump:attachment-ready', onReady);
    void load();
    return () => {
      disposed = true;
      window.removeEventListener('jump:attachment-progress', onProgress);
      window.removeEventListener('jump:attachment-ready', onReady);
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [attachment?.id]);

  if (message?.image) {
    return (
      <div className="message-attachment">
        <img src={message.image} alt={message.imageName ? `Imagem enviada: ${message.imageName}` : 'Imagem enviada'} loading="lazy" />
        {message.imageName && <small>{message.imageName}</small>}
      </div>
    );
  }
  if (!attachment) return null;

  const isImage = String(attachment.type || '').startsWith('image/');
  const label = attachment.name || 'arquivo';
  if (!objectUrl) {
    return (
      <div className="message-attachment message-file-attachment is-pending">
        <Paperclip size={17} />
        <span>{progress ? `recebendo ${progress}%` : 'aguardando arquivo...'}</span>
        <small>{label} · {formatFileSize(attachment.size)}</small>
      </div>
    );
  }
  return (
    <div className={`message-attachment ${isImage ? 'message-image-attachment' : 'message-file-attachment'}`}>
      {isImage ? <img src={objectUrl} alt={`Imagem enviada: ${label}`} loading="lazy" /> : <a className="message-file-link" href={objectUrl} download={label}><Download size={17} /><strong>{label}</strong><small>{formatFileSize(attachment.size)}</small></a>}
      {isImage && <a className="message-file-download" href={objectUrl} download={label}><Download size={13} /> baixar {label}</a>}
    </div>
  );
}

function SignalBadge({ status, peerCount }) {
  const isConnected = status === 'connected';
  return (
    <div className={`signal-badge ${isConnected ? 'is-connected' : ''}`}>
      <WinIcon name="globe" size={18} className={isConnected ? '' : 'is-offline'} />
      <span>{isConnected ? `${peerCount} conectado${peerCount === 1 ? '' : 's'}` : 'conectando'}</span>
    </div>
  );
}

function DesktopTitleBar() {
  const desktop = globalThis.jumpDesktop;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!desktop) return undefined;
    let active = true;
    desktop.getWindowState?.().then((state) => {
      if (active) setMaximized(Boolean(state?.maximized));
    }).catch(() => {});
    const unsubscribe = desktop.onWindowState?.((state) => setMaximized(Boolean(state?.maximized)));
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [desktop]);

  if (!desktop) return null;
  const toggleMaximize = () => desktop.toggleMaximize?.().then((state) => setMaximized(Boolean(state?.maximized))).catch(() => {});

  return (
    <div className="desktop-titlebar" onDoubleClick={toggleMaximize}>
      <div className="desktop-titlebar-label"><img className="desktop-titlebar-icon" src={winAppIcon} alt="" aria-hidden="true" draggable="false" /><strong>JUMP — make your jumps!</strong></div>
      <div className="desktop-window-controls">
        <button type="button" className="desktop-window-control" aria-label="Minimizar janela" onClick={() => desktop.minimizeWindow?.()}>_</button>
        <button type="button" className="desktop-window-control" aria-label={maximized ? 'Restaurar janela' : 'Maximizar janela'} onClick={toggleMaximize}>{maximized ? '❐' : '□'}</button>
        <button type="button" className="desktop-window-control desktop-window-control-close" aria-label="Fechar janela" onClick={() => desktop.closeWindow?.()}>×</button>
      </div>
    </div>
  );
}

function App() {
  const [roomId, setRoomId] = useState(DEFAULT_ROOM_ID);
  const [roomName, setRoomName] = useState(prettyRoomName(DEFAULT_ROOM_ID));
  const [rooms, setRooms] = useState([]);
  const [peers, setPeers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [directPeerId, setDirectPeerId] = useState('');
  const [directMessages, setDirectMessages] = useState([]);
  const [activeContactId, setActiveContactId] = useState('');
  const [contacts, setContacts] = useState(() => readContacts());
  const [unreadCounts, setUnreadCounts] = useState(() => readUnreadCounts());
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('jump-name') || 'Você');
  const [nameDraft, setNameDraft] = useState(() => localStorage.getItem('jump-name') || 'Você');
  const [profileAvatar, setProfileAvatar] = useState(() => localStorage.getItem('jump-avatar') || '');
  const [profileStatus, setProfileStatus] = useState(() => normalizePresenceStatus(localStorage.getItem(PROFILE_STATUS_KEY) || 'online'));
  const [profileSettingsOpen, setProfileSettingsOpen] = useState(false);
  const [roomDraft, setRoomDraft] = useState('');
  const [roomPasswordDraft, setRoomPasswordDraft] = useState('');
  const [showRoomCreator, setShowRoomCreator] = useState(false);
  const [roomAccess, setRoomAccess] = useState(null);
  const [roomSearch, setRoomSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [composerCursorLeft, setComposerCursorLeft] = useState(2);
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [screenShareProfileId, setScreenShareProfileId] = useState(() => localStorage.getItem(SCREEN_SHARE_PROFILE_KEY) || 'balanced');
  const [inCall, setInCall] = useState(false);
  const [callDurationSeconds, setCallDurationSeconds] = useState(0);
  const [audioInputDevices, setAudioInputDevices] = useState([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState([]);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState(() => localStorage.getItem('jump-audio-input') || '');
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState(() => localStorage.getItem('jump-audio-output') || '');
  const [showDeviceSettings, setShowDeviceSettings] = useState(false);
  const [signalStatus, setSignalStatus] = useState('connecting');
  const [remoteStreams, setRemoteStreams] = useState({});
  const [remoteCallStates, setRemoteCallStates] = useState({});
  const [speakingPeers, setSpeakingPeers] = useState({});
  const [focusedCallPeerId, setFocusedCallPeerId] = useState('');
  const [streamWatching, setStreamWatching] = useState({});
  const [participantVolumes, setParticipantVolumes] = useState({});
  const [volumePopover, setVolumePopover] = useState(null);
  const [permissionError, setPermissionError] = useState('');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [callPanelOpen, setCallPanelOpen] = useState(false);
  const [chatPanelOpen, setChatPanelOpen] = useState(true);
  const [callChatSplit, setCallChatSplit] = useState(() => Math.max(25, Math.min(75, Number(localStorage.getItem(CALL_CHAT_SPLIT_KEY)) || 50)));
  const [roomProtected, setRoomProtected] = useState(false);
  const [roomCreatedAt, setRoomCreatedAt] = useState(0);
  const [editingRoomName, setEditingRoomName] = useState(false);
  const [roomNameDraft, setRoomNameDraft] = useState('');
  const [roomInfoOpen, setRoomInfoOpen] = useState(false);
  const [pendingRoomFallback, setPendingRoomFallback] = useState(null);
  const [updateState, setUpdateState] = useState({ status: 'idle' });
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);

  const wsRef = useRef(null);
  const profilePhotoInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const composerInputRef = useRef(null);
  const messageListRef = useRef(null);
  const messageListStickToBottomRef = useRef(true);
  const messageListContextRef = useRef('');
  const notificationAudioContextRef = useRef(null);
  const notificationSoundLastPlayedRef = useRef(0);
  const transmissionSoundLastPlayedRef = useRef({});
  const remoteSharingRef = useRef(new Map());
  const appStartedAtRef = useRef(Date.now());
  const logicalMessageClockRef = useRef(Number.parseInt(localStorage.getItem(MESSAGE_CLOCK_KEY) || '0', 10) || 0);
  const messagesRef = useRef(messages);
  const peersRef = useRef(peers);
  const directMessagesRef = useRef(directMessages);
  const directPeerIdRef = useRef(directPeerId);
  const activeContactIdRef = useRef(activeContactId);
  const unreadCountsRef = useRef(unreadCounts);
  const directConversationRef = useRef('');
  const clientIdRef = useRef(getClientId());
  const peerIdRef = useRef('');
  const roomIdRef = useRef(DEFAULT_ROOM_ID);
  const roomNameRef = useRef(prettyRoomName(DEFAULT_ROOM_ID));
  const roomPasswordRef = useRef(rememberedRoomPassword(DEFAULT_ROOM_ID));
  const displayNameRef = useRef(displayName);
  const profileAvatarRef = useRef(profileAvatar);
  const profileStatusRef = useRef(profileStatus);
  const peerConnectionsRef = useRef(new Map());
  const remoteStreamsRef = useRef(new Map());
  const pendingCandidatesRef = useRef(new Map());
  const dataChunksRef = useRef(new Map());
  const attachmentSendQueuesRef = useRef(new Map());
  const attachmentSendTransfersRef = useRef(new Map());
  const incomingAttachmentTransfersRef = useRef(new Map());
  const requestedAttachmentIdsRef = useRef(new Map());
  const audioStreamRef = useRef(null);
  const outboundAudioStreamRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const screenAudioSessionRef = useRef(null);
  const videoProfileRef = useRef(screenShareProfileId);
  const inCallRef = useRef(false);
  const callStartedAtRef = useRef(0);
  const isMutedRef = useRef(isMuted);
  const isDeafenedRef = useRef(isDeafened);
  const audioInputIdRef = useRef(selectedAudioInputId);
  const repairPeerMediaRef = useRef(null);
  const setPeerScreenDeliveryRef = useRef(null);

  const updateComposerCursor = useCallback(() => {
    const input = composerInputRef.current;
    const shell = input?.parentElement;
    if (!input || !shell) return;
    const style = window.getComputedStyle(input);
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return;
    context.font = style.font;
    const selectionStart = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
    const beforeCursor = input.value.slice(0, selectionStart);
    const letterSpacing = Number.parseFloat(style.letterSpacing) || 0;
    const textWidth = context.measureText(beforeCursor.replace(/ /g, '\u00a0')).width + (letterSpacing * beforeCursor.length);
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    // O cursor é desenhado sobre o próprio campo: o início real da escrita é
    // o padding interno do input, não a borda esquerda do shell.
    const rawLeft = paddingLeft + textWidth - (input.scrollLeft || 0);
    const maxLeft = Math.max(2, shell.clientWidth - 7);
    setComposerCursorLeft(Math.max(2, Math.min(rawLeft, maxLeft)));
  }, []);

  const updateMessageListStickiness = useCallback(() => {
    const list = messageListRef.current;
    if (!list) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    messageListStickToBottomRef.current = distanceFromBottom <= 96;
  }, []);

  const scrollMessageListToBottom = useCallback((behavior = 'auto') => {
    messageListStickToBottomRef.current = true;
    const list = messageListRef.current;
    if (!list) return;
    window.requestAnimationFrame(() => {
      const currentList = messageListRef.current;
      if (!currentList) return;
      if (typeof currentList.scrollTo === 'function') {
        currentList.scrollTo({ top: currentList.scrollHeight, behavior });
      } else {
        currentList.scrollTop = currentList.scrollHeight;
      }
    });
  }, []);

  const playMessageNotification = useCallback(() => {
    const now = Date.now();
    if (now - notificationSoundLastPlayedRef.current < 120) return;
    notificationSoundLastPlayedRef.current = now;
    try {
      const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextConstructor) return;
      const context = notificationAudioContextRef.current || new AudioContextConstructor();
      notificationAudioContextRef.current = context;
      if (context.state === 'suspended') void context.resume().catch(() => {});
      const startAt = context.currentTime + 0.01;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(740, startAt);
      oscillator.frequency.exponentialRampToValueAtTime(540, startAt + 0.1);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.028, startAt + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.14);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + 0.15);
    } catch {
      // Audio notifications are optional; browsers may reject a context before
      // the first user gesture, so a failure must never affect chat delivery.
    }
  }, []);

  const nextMessageClock = useCallback(() => {
    logicalMessageClockRef.current += 1;
    try { localStorage.setItem(MESSAGE_CLOCK_KEY, String(logicalMessageClockRef.current)); } catch { /* Best effort only. */ }
    return logicalMessageClockRef.current;
  }, []);

  const observeMessageClocks = useCallback((incoming = []) => {
    const highest = (incoming || []).reduce((current, message) => {
      const clock = messageOrderValue(message);
      return clock === null ? current : Math.max(current, clock);
    }, logicalMessageClockRef.current);
    if (highest === logicalMessageClockRef.current) return;
    logicalMessageClockRef.current = highest;
    try { localStorage.setItem(MESSAGE_CLOCK_KEY, String(highest)); } catch { /* Best effort only. */ }
  }, []);

  const copyRoomInvite = useCallback(async () => {
    const room = roomIdRef.current || DEFAULT_ROOM_ID;
    let invite = '';
    try {
      invite = await globalThis.jumpDesktop?.getInviteUrl?.(room);
    } catch {
      invite = '';
    }
    if (!invite) {
      const url = new URL(window.location.href);
      url.search = '';
      url.hash = '';
      url.searchParams.set('room', room);
      invite = url.toString();
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(invite);
      } else {
        const helper = document.createElement('textarea');
        helper.value = invite;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        const copied = document.execCommand('copy');
        helper.remove();
        if (!copied) throw new Error('clipboard-unavailable');
      }
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 1800);
    } catch {
      setPermissionError('Não foi possível copiar o convite. Selecione e copie o link manualmente.');
    }
  }, []);

  useEffect(() => () => {
    const context = notificationAudioContextRef.current;
    notificationAudioContextRef.current = null;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  }, []);

  useEffect(() => { displayNameRef.current = displayName; }, [displayName]);
  useEffect(() => { peersRef.current = peers; }, [peers]);
  useEffect(() => { profileAvatarRef.current = profileAvatar; }, [profileAvatar]);
  useEffect(() => { profileStatusRef.current = profileStatus; }, [profileStatus]);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { isDeafenedRef.current = isDeafened; }, [isDeafened]);
  useEffect(() => { audioInputIdRef.current = selectedAudioInputId; }, [selectedAudioInputId]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { directMessagesRef.current = directMessages; }, [directMessages]);
  useEffect(() => { directPeerIdRef.current = directPeerId; }, [directPeerId]);
  useEffect(() => { activeContactIdRef.current = activeContactId; }, [activeContactId]);
  useEffect(() => { unreadCountsRef.current = unreadCounts; }, [unreadCounts]);
  useEffect(() => {
    try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(contacts.slice(0, MAX_CONTACTS))); } catch { /* Ignore storage limits. */ }
  }, [contacts]);
  useEffect(() => {
    try { localStorage.setItem(UNREAD_COUNTS_KEY, JSON.stringify(unreadCounts)); } catch { /* Ignore storage limits. */ }
  }, [unreadCounts]);
  useEffect(() => {
    try { localStorage.setItem(PROFILE_STATUS_KEY, normalizePresenceStatus(profileStatus)); } catch { /* Ignore storage limits. */ }
  }, [profileStatus]);
  useEffect(() => {
    updateComposerCursor();
    window.addEventListener('resize', updateComposerCursor);
    return () => window.removeEventListener('resize', updateComposerCursor);
  }, [updateComposerCursor]);
  useEffect(() => {
    if (!roomInfoOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setRoomInfoOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [roomInfoOpen]);
  useEffect(() => {
    if (!profileSettingsOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setProfileSettingsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [profileSettingsOpen]);
  useEffect(() => {
    const applyUpdateState = (nextState) => setUpdateState((current) => {
      if (!nextState?.status) return current;
      if ((nextState.revision || 0) < (current.revision || 0)) return current;
      return { ...current, ...nextState };
    });
    const desktop = globalThis.jumpDesktop;
    const unsubscribe = desktop?.onUpdateState(applyUpdateState);
    desktop?.getUpdateState?.().then(applyUpdateState).catch(() => {});
    return () => unsubscribe?.();
  }, []);
  useEffect(() => {
    if (!updateDialogOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setUpdateDialogOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [updateDialogOpen]);

  const sendAttachmentToPeer = useCallback(async (peerId, attachmentId) => {
    if (!peerId || !attachmentId) return false;
    const transferKey = `${peerId}:${attachmentId}`;
    const activeTransfer = attachmentSendTransfersRef.current.get(transferKey);
    if (activeTransfer) return activeTransfer;
    const previous = attachmentSendQueuesRef.current.get(peerId) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const channel = peerConnectionsRef.current.get(peerId)?.dataChannel;
      const record = await readAttachmentBlob(attachmentId);
      if (!record?.blob || channel?.readyState !== 'open') return false;
      const transferId = messageId();
      const total = Math.ceil(record.blob.size / ATTACHMENT_CHUNK_SIZE);
      sendDataChannelPacket(channel, {
        type: 'attachment-start',
        roomId: roomIdRef.current,
        attachmentId,
        transferId,
        conversationId: record.conversationId || roomIdRef.current,
        name: record.name,
        mimeType: record.type || record.blob.type || 'application/octet-stream',
        size: record.blob.size,
        total,
      });
      for (let index = 0; index < total; index += 1) {
        if (channel.readyState !== 'open') throw new Error('attachment-channel-closed');
        await waitForDataChannelDrain(channel);
        const start = index * ATTACHMENT_CHUNK_SIZE;
        const chunk = await record.blob.slice(start, start + ATTACHMENT_CHUNK_SIZE).arrayBuffer();
        await waitForDataChannelDrain(channel);
        channel.send(createAttachmentFrame(transferId, index, chunk));
        window.dispatchEvent(new CustomEvent('jump:attachment-progress', { detail: { attachmentId, percent: Math.round(((index + 1) / Math.max(1, total)) * 100) } }));
      }
      sendDataChannelPacket(channel, { type: 'attachment-end', roomId: roomIdRef.current, attachmentId, transferId });
      return true;
    });
    attachmentSendQueuesRef.current.set(peerId, task);
    attachmentSendTransfersRef.current.set(transferKey, task);
    task.finally(() => {
      if (attachmentSendQueuesRef.current.get(peerId) === task) attachmentSendQueuesRef.current.delete(peerId);
      if (attachmentSendTransfersRef.current.get(transferKey) === task) attachmentSendTransfersRef.current.delete(transferKey);
    }).catch(() => {});
    return task;
  }, []);

  const requestAttachmentFromPeer = useCallback(async (peerId, attachmentId) => {
    if (!peerId || !attachmentId) return;
    const channel = peerConnectionsRef.current.get(peerId)?.dataChannel;
    if (channel?.readyState !== 'open') return;
    const requestKey = `${peerId}:${attachmentId}`;
    if (requestedAttachmentIdsRef.current.has(requestKey)) return;
    const timeout = window.setTimeout(() => requestedAttachmentIdsRef.current.delete(requestKey), 30_000);
    requestedAttachmentIdsRef.current.set(requestKey, timeout);
    const localRecord = await readAttachmentBlob(attachmentId);
    if (localRecord?.blob) {
      window.clearTimeout(timeout);
      requestedAttachmentIdsRef.current.delete(requestKey);
      return;
    }
    if (peerConnectionsRef.current.get(peerId)?.dataChannel !== channel || channel.readyState !== 'open') {
      window.clearTimeout(timeout);
      requestedAttachmentIdsRef.current.delete(requestKey);
      return;
    }
    sendDataChannelPacket(channel, { type: 'attachment-request', roomId: roomIdRef.current, attachmentId });
  }, []);

  const sendSignal = useCallback((payload) => {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }, []);

  const rememberContact = useCallback((peer, overrides = {}) => {
    const id = contactIdFor(peer);
    if (!id || id === clientIdRef.current) return '';
    const connected = overrides.connected ?? peer.connected ?? Boolean(peer.peerId);
    setContacts((current) => {
      const index = current.findIndex((contact) => contact.id === id);
      const previous = index >= 0 ? current[index] : {};
      const incomingStatus = overrides.status ?? peer.status ?? (connected ? previous.status || 'online' : 'offline');
      const next = {
        ...previous,
        id,
        clientId: peer.clientId || previous.clientId || id,
        peerId: peer.peerId || previous.peerId || '',
        name: String(peer.name || previous.name || 'amigo').trim().slice(0, 32),
        avatar: peer.avatar !== undefined ? peer.avatar : (previous.avatar || ''),
        status: normalizePresenceStatus(incomingStatus),
        connected,
        lastSeen: overrides.lastSeen || (connected ? Date.now() : (previous.lastSeen || Date.now())),
      };
      if (!next.name) return current;
      if (index < 0) return [...current, next].slice(-MAX_CONTACTS);
      const copy = [...current];
      copy[index] = next;
      return copy;
    });
    return id;
  }, []);

  const updateUnreadCount = useCallback((key, amount = 0) => {
    if (!key) return;
    const nextCount = Math.max(0, Math.min(99, Number(amount) || 0));
    const next = { ...unreadCountsRef.current };
    if (nextCount) next[key] = nextCount;
    else delete next[key];
    unreadCountsRef.current = next;
    setUnreadCounts(next);
  }, []);

  const incrementUnread = useCallback((key, amount = 1) => {
    if (!key || !amount) return;
    updateUnreadCount(key, (unreadCountsRef.current[key] || 0) + amount);
  }, [updateUnreadCount]);

  const markUnreadAsRead = useCallback((key) => updateUnreadCount(key, 0), [updateUnreadCount]);

  useEffect(() => {
    let active = true;
    void readStoredDirectContacts(clientIdRef.current).then((stored) => {
      if (!active || !stored.length) return;
      setContacts((current) => {
        const byId = new Map(current.map((contact) => [contact.id, contact]));
        stored.forEach((contact) => {
          if (!byId.has(contact.id)) byId.set(contact.id, contact);
        });
        return [...byId.values()].slice(-MAX_CONTACTS);
      });
    });
    return () => { active = false; };
  }, []);

  const clearRemoteCallMedia = useCallback((peerId) => {
    remoteStreamsRef.current.delete(peerId);
    remoteSharingRef.current.delete(peerId);
    [...dataChunksRef.current.keys()].filter((key) => key.startsWith(`${peerId}:`)).forEach((key) => dataChunksRef.current.delete(key));
    setRemoteStreams((current) => {
      if (!current[peerId]) return current;
      const next = { ...current };
      delete next[peerId];
      return next;
    });
    setRemoteCallStates((current) => {
      if (!current[peerId]) return current;
      const next = { ...current };
      delete next[peerId];
      return next;
    });
    setStreamWatching((current) => {
      if (!(peerId in current)) return current;
      const next = { ...current };
      delete next[peerId];
      return next;
    });
    setFocusedCallPeerId((current) => current === peerId ? '' : current);
    setVolumePopover((current) => current?.peerId === peerId ? null : current);
  }, []);

  const playShareNotification = useCallback((type) => {
    const now = Date.now();
    const previous = transmissionSoundLastPlayedRef.current[type] || 0;
    if (now - previous < 300) return;
    transmissionSoundLastPlayedRef.current[type] = now;
    playTransmissionSound(notificationAudioContextRef, type);
  }, []);
  const playLocalShareStarted = useCallback(() => playShareNotification('local-start'), [playShareNotification]);
  const playLocalShareStopped = useCallback(() => playShareNotification('local-stop'), [playShareNotification]);

  const broadcastRoomData = useCallback((payload, exceptPeerId = '') => {
    peerConnectionsRef.current.forEach((slot, peerId) => {
      if (peerId === exceptPeerId || slot.dataChannel?.readyState !== 'open') return;
      try { sendDataChannelPacket(slot.dataChannel, payload); } catch { /* The peer may be closing. */ }
    });
  }, []);

  const announceCallState = useCallback((overrides = {}) => {
    broadcastRoomData({
      type: 'call-state',
      roomId: roomIdRef.current,
      peerId: peerIdRef.current,
      inCall: inCallRef.current,
      muted: isMutedRef.current,
      deafened: isDeafenedRef.current,
      camera: Boolean(cameraStreamRef.current),
      sharing: Boolean(screenStreamRef.current),
      sharingAudio: Boolean(screenAudioSessionRef.current),
      ...overrides,
    });
  }, [broadcastRoomData]);

  const mergeMessages = useCallback((incoming, sourcePeerId = '') => {
    observeMessageClocks(incoming);
    const current = messagesRef.current;
    const byId = new Map(current.map((message) => [message.id, message]));
    const added = [];
    (incoming || []).forEach((message) => {
      if (!message?.id || byId.has(message.id)) return;
      if (message.roomId && message.roomId !== roomIdRef.current) return;
      if (isRoomCreatedSystemMessage(message) && [...byId.values()].some(isRoomCreatedSystemMessage)) return;
      const normalized = formatMessage(message);
      byId.set(normalized.id, normalized);
      added.push(normalized);
    });
    if (sourcePeerId) {
      // Ask again for metadata we already know when a reconnect finds the
      // message but the local blob was missing after an interrupted transfer.
      (incoming || []).forEach((message) => {
        if (message?.attachment?.id && (!message.roomId || message.roomId === roomIdRef.current)) requestAttachmentFromPeer(sourcePeerId, message.attachment.id);
      });
    }
    if (!added.length) return [];
    const merged = trimMessagesToBudget(sortRoomMessages([...byId.values()]), MAX_CONVERSATION_BYTES, MAX_ROOM_MESSAGES);
    messagesRef.current = merged;
    setMessages(merged);
    void writeRoomMessages(roomIdRef.current, merged);
    const unreadIncoming = sourcePeerId
      ? added.filter((message) => message.kind !== 'system' && message.senderId !== clientIdRef.current).length
      : 0;
    const hasRecentIncomingMessage = sourcePeerId && added.some((message) => (
      message.kind !== 'system'
      && message.senderId !== clientIdRef.current
      && Number(message.timestamp) >= appStartedAtRef.current
    ));
    if (hasRecentIncomingMessage) playMessageNotification();
    if (unreadIncoming && activeContactIdRef.current) incrementUnread(roomUnreadKey(roomIdRef.current), unreadIncoming);
    broadcastRoomData({ type: 'messages', roomId: roomIdRef.current, messages: added }, sourcePeerId);
    return added;
  }, [broadcastRoomData, incrementUnread, observeMessageClocks, playMessageNotification, requestAttachmentFromPeer]);

  const addRoomEvent = useCallback((message) => {
    if (!message?.roomId || message.roomId !== roomIdRef.current) return;
    mergeMessages([message]);
  }, [mergeMessages]);

  const loadRoomMessages = useCallback(async (targetRoomId) => {
    const stored = (await readRoomMessages(targetRoomId)).map(formatMessage);
    observeMessageClocks(stored);
    if (roomIdRef.current !== targetRoomId) return;
    const byId = new Map(messagesRef.current.map((message) => [message.id, message]));
    stored.forEach((message) => byId.set(message.id, message));
    const ordered = trimMessagesToBudget(sortRoomMessages([...byId.values()]), MAX_CONVERSATION_BYTES, MAX_ROOM_MESSAGES);
    messagesRef.current = ordered;
    setMessages(ordered);
    void writeRoomMessages(targetRoomId, ordered);
  }, [observeMessageClocks]);

  const mergeDirectMessages = useCallback(async (conversationId, incoming, sourcePeerId = '') => {
    if (!conversationId || !Array.isArray(incoming) || !incoming.length) return [];
    observeMessageClocks(incoming);
    const current = directConversationRef.current === conversationId
      ? directMessagesRef.current
      : (await readDirectMessages(conversationId)).map(formatMessage);
    const byId = new Map(current.map((message) => [message.id, message]));
    const added = [];
    incoming.forEach((message) => {
      if (!message?.id || byId.has(message.id)) return;
      const normalized = formatMessage({ ...message, conversationId });
      byId.set(normalized.id, normalized);
      added.push(normalized);
    });
    if (sourcePeerId) {
      (incoming || []).forEach((message) => {
        if (message?.attachment?.id) requestAttachmentFromPeer(sourcePeerId, message.attachment.id);
      });
    }
    if (!added.length) return [];
    const merged = trimMessagesToBudget(sortDirectMessages([...byId.values()]), MAX_CONVERSATION_BYTES, MAX_DIRECT_MESSAGES);
    void writeDirectMessages(conversationId, merged);
    const remoteMessages = added.filter((message) => message.senderId && message.senderId !== clientIdRef.current);
    if (sourcePeerId && remoteMessages.some((message) => Number(message.timestamp) >= appStartedAtRef.current)) {
      playMessageNotification();
    }
    const remoteContactId = otherConversationParty(conversationId, clientIdRef.current);
    if (remoteMessages.length) {
      const latest = remoteMessages.at(-1);
      rememberContact({
        clientId: latest.senderId || remoteContactId,
        name: latest.senderName,
        avatar: latest.senderAvatar || latest.avatar || '',
        status: 'online',
        connected: true,
      });
      if (activeContactIdRef.current !== remoteContactId) incrementUnread(directUnreadKey(remoteContactId), remoteMessages.length);
    }
    if (directConversationRef.current === conversationId) {
      directMessagesRef.current = merged;
      setDirectMessages(merged);
    }
    return added;
  }, [incrementUnread, observeMessageClocks, playMessageNotification, rememberContact, requestAttachmentFromPeer]);

  const requestDirectSync = useCallback((peerId = directPeerIdRef.current, conversationId = directConversationRef.current, knownIds = directMessagesRef.current.map((message) => message.id)) => {
    if (!peerId || !conversationId) return;
    const channel = peerConnectionsRef.current.get(peerId)?.dataChannel;
    if (channel?.readyState !== 'open') return;
    sendDataChannelPacket(channel, {
      type: 'direct-sync-request',
      roomId: roomIdRef.current,
      conversationId,
      knownIds,
    });
  }, []);

  const loadDirectMessages = useCallback(async (peer) => {
    if (!peer) return;
    const contactId = contactIdFor(peer);
    if (!contactId) return;
    const conversationId = directConversationId(clientIdRef.current, peer.clientId || peer.peerId);
    activeContactIdRef.current = contactId;
    setActiveContactId(contactId);
    directConversationRef.current = conversationId;
    directPeerIdRef.current = peer.peerId || '';
    setDirectPeerId(peer.peerId || '');
    setDirectMessages([]);
    directMessagesRef.current = [];
    markUnreadAsRead(directUnreadKey(contactId));
    const stored = trimMessagesToBudget(sortDirectMessages((await readDirectMessages(conversationId)).map(formatMessage)), MAX_CONVERSATION_BYTES, MAX_DIRECT_MESSAGES);
    observeMessageClocks(stored);
    if (directConversationRef.current !== conversationId) return;
    directMessagesRef.current = stored;
    setDirectMessages(stored);
    requestDirectSync(peer.peerId, conversationId, stored.map((message) => message.id));
    stored.forEach((message) => {
      if (message.attachment?.id) requestAttachmentFromPeer(peer.peerId, message.attachment.id);
    });
  }, [markUnreadAsRead, observeMessageClocks, requestAttachmentFromPeer, requestDirectSync]);

  const openDirectChat = useCallback((peer) => {
    if (!peer) return;
    setRoomInfoOpen(false);
    setEditingRoomName(false);
    setMobileSidebarOpen(false);
    void loadDirectMessages(peer);
  }, [loadDirectMessages]);

  const closeDirectChat = useCallback(() => {
    activeContactIdRef.current = '';
    directPeerIdRef.current = '';
    directConversationRef.current = '';
    directMessagesRef.current = [];
    setActiveContactId('');
    setDirectPeerId('');
    setDirectMessages([]);
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
      sendDataChannelPacket(channel, {
        type: 'call-state',
        roomId: roomIdRef.current,
        peerId: peerIdRef.current,
        inCall: inCallRef.current,
        muted: isMutedRef.current,
        deafened: isDeafenedRef.current,
        camera: Boolean(cameraStreamRef.current),
        sharing: Boolean(screenStreamRef.current),
        sharingAudio: Boolean(screenAudioSessionRef.current),
      });
      requestDirectSync();
      messagesRef.current.forEach((message) => {
        if (message.attachment?.id) requestAttachmentFromPeer(peerId, message.attachment.id);
      });
      if (peerId === directPeerIdRef.current) {
        directMessagesRef.current.forEach((message) => {
          if (message.attachment?.id) requestAttachmentFromPeer(peerId, message.attachment.id);
        });
      }
    };

    const handleAttachmentFrame = (frame) => {
      const transferKey = `${peerId}:${frame.transferId}`;
      const transfer = incomingAttachmentTransfersRef.current.get(transferKey);
      if (!transfer || frame.index < 0 || frame.index >= transfer.total || transfer.parts[frame.index]) return;
      if (frame.payload.byteLength > ATTACHMENT_CHUNK_SIZE || transfer.received + frame.payload.byteLength > transfer.size) return;
      transfer.parts[frame.index] = frame.payload;
      transfer.received += frame.payload.byteLength;
      window.dispatchEvent(new CustomEvent('jump:attachment-progress', { detail: { attachmentId: transfer.attachmentId, percent: Math.round((transfer.received / Math.max(1, transfer.size)) * 100) } }));
    };

    const handlePayload = async (payload) => {
      if (payload.roomId !== roomIdRef.current) return;
      if (payload.type === 'attachment-request') {
        void sendAttachmentToPeer(peerId, payload.attachmentId);
        return;
      }
      if (payload.type === 'attachment-start') {
        const size = Number(payload.size);
        const total = Number(payload.total);
        const expectedTotal = size === 0 ? 0 : Math.ceil(size / ATTACHMENT_CHUNK_SIZE);
        if (!Number.isFinite(size) || size < 0 || size > MAX_ATTACHMENT_SIZE || !Number.isInteger(total) || total !== expectedTotal) return;
        const transferKey = `${peerId}:${payload.transferId}`;
        const previousTransfer = incomingAttachmentTransfersRef.current.get(transferKey);
        if (previousTransfer?.timeoutId) window.clearTimeout(previousTransfer.timeoutId);
        const timeoutId = window.setTimeout(() => {
          const current = incomingAttachmentTransfersRef.current.get(transferKey);
          if (!current) return;
          incomingAttachmentTransfersRef.current.delete(transferKey);
          requestedAttachmentIdsRef.current.delete(`${peerId}:${current.attachmentId}`);
          requestAttachmentFromPeer(peerId, current.attachmentId);
        }, 5 * 60 * 1000);
        incomingAttachmentTransfersRef.current.set(transferKey, {
          attachmentId: payload.attachmentId,
          transferId: payload.transferId,
          conversationId: payload.conversationId || roomIdRef.current,
          name: String(payload.name || 'arquivo').slice(0, 160),
          type: String(payload.mimeType || 'application/octet-stream').slice(0, 120),
          size,
          total,
          parts: [],
          received: 0,
          timeoutId,
        });
        window.dispatchEvent(new CustomEvent('jump:attachment-progress', { detail: { attachmentId: payload.attachmentId, percent: 0 } }));
        return;
      }
      if (payload.type === 'attachment-end') {
        const transferKey = `${peerId}:${payload.transferId}`;
        const transfer = incomingAttachmentTransfersRef.current.get(transferKey);
        if (!transfer) return;
        if (transfer.timeoutId) window.clearTimeout(transfer.timeoutId);
        const complete = transfer.parts.length === transfer.total && transfer.parts.every((part) => part instanceof Uint8Array);
        if (!complete) {
          incomingAttachmentTransfersRef.current.delete(transferKey);
          requestedAttachmentIdsRef.current.delete(`${peerId}:${transfer.attachmentId}`);
          requestAttachmentFromPeer(peerId, transfer.attachmentId);
          return;
        }
        const blob = new Blob(transfer.parts, { type: transfer.type });
        incomingAttachmentTransfersRef.current.delete(transferKey);
        if (blob.size !== transfer.size) {
          requestedAttachmentIdsRef.current.delete(`${peerId}:${transfer.attachmentId}`);
          requestAttachmentFromPeer(peerId, transfer.attachmentId);
          return;
        }
        const stored = await writeAttachmentBlob(transfer.attachmentId, blob, transfer);
        if (stored) {
          requestedAttachmentIdsRef.current.delete(`${peerId}:${transfer.attachmentId}`);
          window.dispatchEvent(new CustomEvent('jump:attachment-ready', { detail: { attachmentId: transfer.attachmentId } }));
          window.dispatchEvent(new CustomEvent('jump:attachment-progress', { detail: { attachmentId: transfer.attachmentId, percent: 100 } }));
        }
        return;
      }
      if (payload.type === 'direct-sync-request') {
        const stored = sortDirectMessages((await readDirectMessages(payload.conversationId)).map(formatMessage));
        const knownIds = new Set(payload.knownIds || []);
        const missing = stored.filter((message) => !knownIds.has(message.id));
        for (let index = 0; index < missing.length; index += 40) {
          await waitForDataChannelDrain(channel);
          sendDataChannelPacket(channel, { type: 'direct-messages', roomId: roomIdRef.current, conversationId: payload.conversationId, messages: missing.slice(index, index + 40) });
        }
        return;
      }
      if (payload.type === 'direct-message') {
        if (payload.toClientId && payload.toClientId !== clientIdRef.current) return;
        await mergeDirectMessages(payload.conversationId, payload.message ? [payload.message] : [], peerId);
        return;
      }
      if (payload.type === 'direct-messages') {
        await mergeDirectMessages(payload.conversationId, payload.messages || [], peerId);
        return;
      }
      if (payload.type === 'sync-request') {
        const knownIds = new Set(payload.knownIds || []);
        const missing = messagesRef.current.filter((message) => !knownIds.has(message.id));
        for (let index = 0; index < missing.length; index += 40) {
          await waitForDataChannelDrain(channel);
          sendDataChannelPacket(channel, { type: 'messages', roomId: roomIdRef.current, messages: missing.slice(index, index + 40) });
        }
        return;
      }
      if (payload.type === 'stream-watch') {
        void setPeerScreenDeliveryRef.current?.(peerId, payload.watching !== false);
        return;
      }
      if (payload.type === 'call-state') {
        const slot = peerConnectionsRef.current.get(peerId);
        const nextMediaState = {
          inCall: Boolean(payload.inCall),
          camera: Boolean(payload.camera),
          sharing: Boolean(payload.sharing),
          sharingAudio: Boolean(payload.sharingAudio),
        };
        const wasSharing = remoteSharingRef.current.get(peerId) === true;
        if (nextMediaState.sharing) remoteSharingRef.current.set(peerId, true);
        else remoteSharingRef.current.delete(peerId);
        if (!wasSharing && nextMediaState.sharing) {
          setStreamWatching((current) => ({ ...current, [peerId]: true }));
          if (inCallRef.current) playShareNotification('remote-start');
        } else if (wasSharing && !nextMediaState.sharing) {
          setStreamWatching((current) => {
            if (!(peerId in current)) return current;
            const next = { ...current };
            delete next[peerId];
            return next;
          });
          if (inCallRef.current) playShareNotification('remote-stop');
        }
        if (slot) slot.remoteMediaState = nextMediaState;
        if (nextMediaState.inCall) {
          const repairMissingMedia = (attempt = 0) => {
            window.setTimeout(() => {
              const stream = remoteStreamsRef.current.get(peerId);
              const missingAudio = !stream?.getAudioTracks?.().some((track) => track.readyState !== 'ended');
              const missingVideo = (nextMediaState.camera || nextMediaState.sharing)
                && !stream?.getVideoTracks?.().some((track) => track.readyState !== 'ended');
              if (!missingAudio && !missingVideo) return;
              repairPeerMediaRef.current?.(peerId);
              if (attempt < 3) repairMissingMedia(attempt + 1);
            }, 600 * (attempt + 1));
          };
          repairMissingMedia();
        }
        setRemoteCallStates((current) => ({
          ...current,
          [peerId]: {
            inCall: Boolean(payload.inCall),
            muted: Boolean(payload.muted),
            deafened: Boolean(payload.deafened),
            camera: Boolean(payload.camera),
            sharing: Boolean(payload.sharing),
            sharingAudio: Boolean(payload.sharingAudio),
          },
        }));
        return;
      }
      if (payload.type === 'messages') mergeMessages(payload.messages, peerId);
    };

    channel.onopen = requestSync;
    channel.onmessage = async (event) => {
      try {
        if (typeof event.data !== 'string') {
          const buffer = event.data instanceof Blob
            ? await event.data.arrayBuffer()
            : event.data instanceof ArrayBuffer
              ? event.data
              : event.data?.buffer?.slice(event.data.byteOffset || 0, (event.data.byteOffset || 0) + event.data.byteLength);
          const frame = buffer ? parseAttachmentFrame(buffer) : null;
          if (frame) handleAttachmentFrame(frame);
          return;
        }
        const payload = JSON.parse(event.data);
        if (payload.type === 'data-chunk') {
          if (payload.roomId !== roomIdRef.current || !Number.isInteger(payload.index) || !Number.isInteger(payload.total) || payload.index < 0 || payload.index >= payload.total) return;
          const chunkKey = `${peerId}:${payload.transferId}`;
          const current = dataChunksRef.current.get(chunkKey) || { total: payload.total, parts: [] };
          if (current.total !== payload.total) return;
          current.parts[payload.index] = payload.data;
          dataChunksRef.current.set(chunkKey, current);
          if (current.parts.length === current.total && current.parts.every((part) => typeof part === 'string')) {
            dataChunksRef.current.delete(chunkKey);
            void handlePayload(JSON.parse(current.parts.join('')));
          }
          return;
        }
        void handlePayload(payload);
      } catch {
        setPermissionError('Não foi possível sincronizar o histórico desta sala.');
      }
    };
    channel.onclose = () => {
      const current = peerConnectionsRef.current.get(peerId);
      if (current?.dataChannel !== channel) return;
      current.dataChannel = null;
      [...incomingAttachmentTransfersRef.current.entries()]
        .filter(([key]) => key.startsWith(`${peerId}:`))
        .forEach(([key, transfer]) => {
          if (transfer.timeoutId) window.clearTimeout(transfer.timeoutId);
          incomingAttachmentTransfersRef.current.delete(key);
        });
      [...requestedAttachmentIdsRef.current.entries()]
        .filter(([key]) => key.startsWith(`${peerId}:`))
        .forEach(([key, timeout]) => {
          window.clearTimeout(timeout);
          requestedAttachmentIdsRef.current.delete(key);
        });
      clearRemoteCallMedia(peerId);
      setRemoteCallStates((states) => {
        if (!states[peerId]) return states;
        const next = { ...states };
        delete next[peerId];
        return next;
      });
    };
    if (channel.readyState === 'open') requestSync();
  }, [clearRemoteCallMedia, mergeDirectMessages, mergeMessages, playShareNotification, requestAttachmentFromPeer, requestDirectSync, sendAttachmentToPeer]);

  const {
    closePeer,
    closeAllPeers,
    createPeerConnection,
    handlePeerSignal,
    replacePeerTrack,
    requestPeerNegotiation,
    setPeerScreenDelivery,
    setVideoEncodingProfile,
  } = usePeerMesh({
    peerConnectionsRef,
    pendingCandidatesRef,
    localPeerIdRef: peerIdRef,
    audioStreamRef: outboundAudioStreamRef,
    cameraStreamRef,
    screenStreamRef,
    screenAudioSessionRef,
    videoProfileRef,
    remoteStreamsRef,
    sendSignal,
    attachDataChannel,
    clearRemoteCallMedia,
    setRemoteStreams,
    onPeerError: setPermissionError,
  });
  repairPeerMediaRef.current = requestPeerNegotiation;
  setPeerScreenDeliveryRef.current = setPeerScreenDelivery;

  const handleSignalMessage = useCallback(async (message) => {
    if (message.type === 'hello') {
      peerIdRef.current = message.peerId;
      return;
    }
    if (message.type === 'rooms-state') {
      setRooms(message.rooms || []);
      return;
    }
    if (message.type === 'room-error') {
      setPermissionError(message.message || 'Não foi possível entrar nesta sala.');
      forgetRoomPassword(message.roomId);
      if (message.roomId === roomIdRef.current) roomPasswordRef.current = '';
      setRoomAccess({ roomId: message.roomId, name: message.name || prettyRoomName(message.roomId), password: '' });
      return;
    }
    if (message.type === 'room-state') {
      const nextPeers = Array.isArray(message.peers) ? message.peers : [];
      // A signaling reconnect gives this client a new peer id. Rebuild every
      // leg of the mesh because the other participants already discarded the
      // connections associated with the previous socket.
      closeAllPeers();
      roomIdRef.current = message.roomId;
      roomNameRef.current = message.name || prettyRoomName(message.roomId);
      setRoomId(message.roomId);
      setRoomName(roomNameRef.current);
      setRoomNameDraft(roomNameRef.current);
      setRoomProtected(Boolean(message.protected));
      setRoomCreatedAt(Number(message.createdAt) || 0);
      setPeers(nextPeers);
      nextPeers.forEach((peer) => rememberContact(peer, { connected: true, status: peer.status || 'online' }));
      addRoomEvent(roomCreatedMessage(message.roomId, message.createdAt, message.createdBy));
      addRoomEvent(roomJoinedMessage(message.roomId, message.clientId || clientIdRef.current, displayNameRef.current, message.joinedAt));
      // Hydrate the local history before opening DataChannels. This prevents a
      // fresh peer from answering a sync request with only the two system
      // events that are inserted while the room-state packet is processed.
      void loadRoomMessages(message.roomId).finally(() => {
        if (roomIdRef.current === message.roomId) nextPeers.forEach((peer) => createPeerConnection(peer.peerId, true));
      });
      return;
    }
    if (message.type === 'peer-joined') {
      if (message.roomId && message.roomId !== roomIdRef.current) return;
      setPeers((current) => current.some((peer) => peer.peerId === message.peer.peerId) ? current : [...current, message.peer]);
      rememberContact(message.peer, { connected: true, status: message.peer.status || 'online' });
      if (activeContactIdRef.current && activeContactIdRef.current === contactIdFor(message.peer)) {
        directPeerIdRef.current = message.peer.peerId;
        setDirectPeerId(message.peer.peerId);
      }
      addRoomEvent(roomJoinedMessage(message.roomId || roomIdRef.current, message.peer.clientId || message.peer.peerId, message.peer.name, message.joinedAt || message.peer.joinedAt));
      return;
    }
    if (message.type === 'room-renamed') {
      setRooms((current) => current.map((room) => room.id === message.roomId ? { ...room, name: message.name } : room));
      if (message.roomId === roomIdRef.current) {
        roomNameRef.current = message.name;
        setRoomName(message.name);
        setRoomNameDraft(message.name);
      }
      return;
    }
    if (message.type === 'room-deleted') {
      const remainingRooms = Array.isArray(message.rooms) ? message.rooms : [];
      setRooms(remainingRooms);
      if (message.roomId === roomIdRef.current) {
        await removeRoomMessages(message.roomId);
        forgetRoomPassword(message.roomId);
        setRoomInfoOpen(false);
        setEditingRoomName(false);
        setPermissionError(`A sala "${message.name || roomNameRef.current}" foi excluída.`);
        if (remainingRooms.length) {
          setPendingRoomFallback(remainingRooms[0]);
        } else {
          // Não recrie automaticamente o jump-house: a exclusão da última
          // sala deve deixar o diretório vazio até o usuário criar outra.
          closeAllPeers();
          pendingCandidatesRef.current.clear();
          dataChunksRef.current.clear();
          remoteStreamsRef.current.clear();
          setRemoteStreams({});
          setRemoteCallStates({});
          audioStreamRef.current?.getTracks().forEach((track) => track.stop());
          void screenAudioSessionRef.current?.stop();
          cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
          screenStreamRef.current?.getTracks().forEach((track) => track.stop());
          audioStreamRef.current = null;
          outboundAudioStreamRef.current = null;
          screenAudioSessionRef.current = null;
          cameraStreamRef.current = null;
          screenStreamRef.current = null;
          inCallRef.current = false;
          isMutedRef.current = false;
          isDeafenedRef.current = false;
          setInCall(false);
          setIsCameraOn(false);
          setIsSharing(false);
          setIsMuted(false);
          setIsDeafened(false);
          setCallDurationSeconds(0);
          setPeers([]);
          activeContactIdRef.current = '';
          directPeerIdRef.current = '';
          directConversationRef.current = '';
          directMessagesRef.current = [];
          setActiveContactId('');
          setDirectPeerId('');
          setDirectMessages([]);
          messagesRef.current = [];
          setMessages([]);
          roomIdRef.current = '';
          roomNameRef.current = 'Nenhuma sala';
          roomPasswordRef.current = '';
          setRoomId('');
          setRoomName('Nenhuma sala');
          setRoomNameDraft('');
          setRoomProtected(false);
          setRoomCreatedAt(0);
          setCallPanelOpen(false);
          window.history.replaceState({}, '', window.location.pathname);
          setPendingRoomFallback(null);
        }
      }
      return;
    }
    if (message.type === 'peer-updated') {
      setPeers((current) => current.map((peer) => peer.peerId === message.peer.peerId ? message.peer : peer));
      rememberContact(message.peer, { connected: true, status: message.peer.status || 'online' });
      return;
    }
    if (message.type === 'peer-left') {
      if (message.roomId && message.roomId !== roomIdRef.current) return;
      const departingPeer = peersRef.current.find((peer) => peer.peerId === message.peerId);
      if (departingPeer) rememberContact(departingPeer, { connected: false, status: 'offline', peerId: '', lastSeen: Date.now() });
      closePeer(message.peerId);
      if (message.peerId === directPeerIdRef.current) {
        directPeerIdRef.current = '';
        setDirectPeerId('');
      }
      setPeers((current) => current.filter((peer) => peer.peerId !== message.peerId));
      return;
    }
    if (message.type !== 'signal') return;
    await handlePeerSignal(message.from, message.data);
  }, [addRoomEvent, closeAllPeers, closePeer, createPeerConnection, handlePeerSignal, loadRoomMessages, rememberContact]);

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
          if (roomIdRef.current) sendSignal({ type: 'join', roomId: roomIdRef.current, roomName: roomNameRef.current, password: roomPasswordRef.current, name: displayNameRef.current, avatar: profileAvatarRef.current, status: profileStatusRef.current, clientId: clientIdRef.current });
        };
        socket.onmessage = (event) => {
          try { handleSignalMessage(JSON.parse(event.data)); } catch { /* Ignore malformed packets. */ }
        };
        socket.onerror = () => setSignalStatus('offline');
        socket.onclose = () => {
          if (wsRef.current === socket) wsRef.current = null;
          setSignalStatus('offline');
          peersRef.current.forEach((peer) => rememberContact(peer, { connected: false, status: 'offline', lastSeen: Date.now() }));
          setPeers((current) => current.map((peer) => ({ ...peer, connected: false, status: 'offline' })));
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
      closeAllPeers();
      void screenAudioSessionRef.current?.stop();
      audioStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenAudioSessionRef.current = null;
    };
  }, [closeAllPeers, handleSignalMessage, rememberContact, sendSignal]);

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

  // Measure each active microphone stream locally. The analyser is connected
  // only to an AnalyserNode (never to the destination), so it cannot create an
  // echo; it merely drives the small green speaking ring in the call UI.
  useEffect(() => {
    const remoteEntries = Object.entries(remoteStreams).map(([peerId, entry]) => [peerId, { ...entry, voiceStream: entry?.microphoneStream || entry?.stream }]).filter(([peerId, entry]) => (
      remoteCallStates[peerId]?.inCall === true
      && remoteCallStates[peerId]?.muted !== true
      && entry?.voiceStream?.getAudioTracks?.().some((track) => track.readyState !== 'ended')
    ));
    const localStream = inCall && !isMuted ? audioStreamRef.current : null;
    if (!localStream && !remoteEntries.length) {
      setSpeakingPeers((current) => (Object.keys(current).length ? {} : current));
      return undefined;
    }
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) return undefined;
    let context;
    try {
      context = new AudioContextConstructor();
    } catch {
      return undefined;
    }
    if (context.state === 'suspended') void context.resume().catch(() => {});
    const monitors = [];
    const addMonitor = (id, stream) => {
      if (!stream?.getAudioTracks?.().length) return;
      try {
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.72;
        source.connect(analyser);
        monitors.push({ id, source, analyser, data: new Uint8Array(analyser.fftSize), speaking: false });
      } catch {
        // A stream can disappear while a peer is leaving; ignore that frame.
      }
    };
    addMonitor('self', localStream);
    remoteEntries.forEach(([peerId, entry]) => addMonitor(peerId, entry.voiceStream));
    if (!monitors.length) {
      void context.close().catch(() => {});
      return undefined;
    }
    let frame = 0;
    let stopped = false;
    const updateSpeaking = () => {
      if (stopped) return;
      const next = {};
      monitors.forEach((monitor) => {
        monitor.analyser.getByteTimeDomainData(monitor.data);
        let energy = 0;
        monitor.data.forEach((sample) => {
          const normalized = (sample - 128) / 128;
          energy += normalized * normalized;
        });
        const level = Math.sqrt(energy / monitor.data.length);
        // Hysteresis keeps the ring stable around quiet syllables and room
        // noise instead of flickering every animation frame.
        if (monitor.speaking ? level < 0.032 : level > 0.052) monitor.speaking = !monitor.speaking;
        if (monitor.speaking) next[monitor.id] = true;
      });
      setSpeakingPeers((current) => {
        const currentKeys = Object.keys(current);
        const nextKeys = Object.keys(next);
        if (currentKeys.length === nextKeys.length && nextKeys.every((key) => current[key] === next[key])) return current;
        return next;
      });
      frame = window.requestAnimationFrame(updateSpeaking);
    };
    updateSpeaking();
    return () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
      monitors.forEach(({ source, analyser }) => {
        try { source.disconnect(); } catch { /* Stream already ended. */ }
        try { analyser.disconnect(); } catch { /* Stream already ended. */ }
      });
      void context.close().catch(() => {});
      setSpeakingPeers((current) => (Object.keys(current).length ? {} : current));
    };
  }, [inCall, isMuted, remoteCallStates, remoteStreams]);

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
      track.contentHint = 'speech';
      audioStreamRef.current = stream;
      outboundAudioStreamRef.current = stream;
      track.enabled = !isMutedRef.current;
      if (!(await replacePeerTrack('audioSender', track))) {
        stream.getTracks().forEach((mediaTrack) => mediaTrack.stop());
        audioStreamRef.current = null;
        outboundAudioStreamRef.current = null;
        return false;
      }
      inCallRef.current = true;
      callStartedAtRef.current = Date.now();
      setCallDurationSeconds(0);
      setInCall(true);
      announceCallState({ inCall: true, muted: isMutedRef.current });
      setCallPanelOpen(true);
      void refreshAudioDevices();
      return true;
    } catch (error) {
      setPermissionError(mediaErrorMessage(error, 'Permita o microfone para entrar na chamada.'));
      return false;
    }
  }, [announceCallState, refreshAudioDevices, replacePeerTrack]);

  const switchAudioInput = useCallback(async (deviceId) => {
    if (!inCallRef.current) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(audioConstraints(deviceId));
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('no-audio-track');
      track.contentHint = 'speech';
      track.enabled = !isMutedRef.current;
      const previousStream = audioStreamRef.current;
      audioStreamRef.current = stream;
      outboundAudioStreamRef.current = stream;
      if (!(await replacePeerTrack('audioSender', track))) {
        audioStreamRef.current = previousStream;
        outboundAudioStreamRef.current = previousStream;
        stream.getTracks().forEach((mediaTrack) => mediaTrack.stop());
        return false;
      }
      previousStream?.getTracks().forEach((oldTrack) => oldTrack.stop());
      void refreshAudioDevices();
      setPermissionError('');
      return true;
    } catch (error) {
      setPermissionError(mediaErrorMessage(error, 'Não foi possível trocar o microfone.'));
      return false;
    }
  }, [refreshAudioDevices, replacePeerTrack]);

  const leaveCall = useCallback(() => {
    const wasSharing = Boolean(screenStreamRef.current);
    const previousScreenStream = screenStreamRef.current;
    screenStreamRef.current = null;
    void screenAudioSessionRef.current?.stop();
    audioStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    previousScreenStream?.getTracks().forEach((track) => track.stop());
    audioStreamRef.current = null;
    outboundAudioStreamRef.current = null;
    screenAudioSessionRef.current = null;
    cameraStreamRef.current = null;
    screenStreamRef.current = null;
    void replacePeerTrack('audioSender', null);
    void replacePeerTrack('videoSender', null);
    void replacePeerTrack('screenAudioSender', null);
    inCallRef.current = false;
    isMutedRef.current = false;
    isDeafenedRef.current = false;
    announceCallState({ inCall: false, muted: false, deafened: false, camera: false, sharing: false, sharingAudio: false });
    setInCall(false);
    setIsCameraOn(false);
    setIsSharing(false);
    setIsMuted(false);
    setIsDeafened(false);
    setCallPanelOpen(false);
    if (wasSharing) playLocalShareStopped();
  }, [announceCallState, playLocalShareStopped, replacePeerTrack]);

  const joinRoom = useCallback((nextRoomId, nextRoomName = '', nextRoomPassword = '') => {
    const normalizedId = slugify(nextRoomId);
    const normalizedName = String(nextRoomName || prettyRoomName(normalizedId)).trim().slice(0, 48);
    const normalizedPassword = String(nextRoomPassword || '').trim().slice(0, 128);
    if (normalizedPassword) rememberRoomPassword(normalizedId, normalizedPassword);
    leaveCall();
    closeAllPeers();
    remoteStreamsRef.current.clear();
    remoteSharingRef.current.clear();
    setRemoteCallStates({});
    setStreamWatching({});
    setFocusedCallPeerId('');
    setVolumePopover(null);
    pendingCandidatesRef.current.clear();
    dataChunksRef.current.clear();
    setRemoteStreams({});
    closeDirectChat();
    setPeers([]);
    messagesRef.current = [];
    setMessages([]);
    setPermissionError('');
    markUnreadAsRead(roomUnreadKey(normalizedId));
    roomIdRef.current = normalizedId;
    roomNameRef.current = normalizedName;
    roomPasswordRef.current = normalizedPassword;
    setRoomId(normalizedId);
    setRoomName(normalizedName);
    setRoomNameDraft(normalizedName);
    setRoomProtected(Boolean(normalizedPassword));
    setRoomCreatedAt(0);
    void loadRoomMessages(normalizedId);
    window.history.replaceState({}, '', `${window.location.pathname}?room=${encodeURIComponent(normalizedId)}`);
    sendSignal({ type: 'join', roomId: normalizedId, roomName: normalizedName, password: normalizedPassword, name: displayNameRef.current, avatar: profileAvatarRef.current, status: profileStatusRef.current, clientId: clientIdRef.current });
    setMobileSidebarOpen(false);
  }, [closeAllPeers, closeDirectChat, leaveCall, loadRoomMessages, markUnreadAsRead, sendSignal]);

  const toggleMute = useCallback(async () => {
    if (!inCallRef.current && !(await startCall())) return;
    const nextMuted = !isMutedRef.current;
    isMutedRef.current = nextMuted;
    audioStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !nextMuted; });
    setIsMuted(nextMuted);
    announceCallState({ muted: nextMuted });
  }, [announceCallState, startCall]);

  const toggleDeafen = useCallback(() => {
    const nextDeafened = !isDeafenedRef.current;
    isDeafenedRef.current = nextDeafened;
    setIsDeafened(nextDeafened);
    announceCallState({ deafened: nextDeafened });
  }, [announceCallState]);

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
      await replacePeerTrack('videoSender', null);
      setIsCameraOn(false);
      announceCallState({ camera: false });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      cameraStreamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      track.contentHint = 'motion';
      if (!(await replacePeerTrack('videoSender', track))) {
        cameraStreamRef.current = null;
        stream.getTracks().forEach((mediaTrack) => mediaTrack.stop());
        return;
      }
      setIsCameraOn(true);
      announceCallState({ camera: true });
    } catch (error) {
      setPermissionError(mediaErrorMessage(error, 'Permita a câmera para ligar seu vídeo.'));
    }
  }, [announceCallState, replacePeerTrack, startCall]);

  const updateScreenShareProfile = useCallback((profileId) => {
    videoProfileRef.current = profileId;
    setScreenShareProfileId(profileId);
    localStorage.setItem(SCREEN_SHARE_PROFILE_KEY, profileId);
    void setVideoEncodingProfile(profileId);
  }, [setVideoEncodingProfile]);

  const updateCallChatSplit = useCallback((percent) => {
    const next = Math.max(25, Math.min(75, Number(percent) || 50));
    setCallChatSplit(next);
    localStorage.setItem(CALL_CHAT_SPLIT_KEY, String(next));
  }, []);

  const {
    audioSource: screenShareAudioSource,
    cancelPicker: cancelScreenSharePicker,
    changeIncludeAudio: changeScreenShareAudio,
    changeSyncAudio: changeScreenShareAudioSync,
    chooseVideoSource: chooseScreenShareVideo,
    includeAudio: screenShareIncludesAudio,
    loading: screenShareSourcesLoading,
    mediaCapabilities: screenShareMediaCapabilities,
    pickerOpen: screenSharePickerOpen,
    setAudioSource: setScreenShareAudioSource,
    setTab: setScreenShareTab,
    sources: screenShareSources,
    startScreenShare,
    stopScreenShare,
    syncAudio: screenShareAudioSync,
    tab: screenShareTab,
    toggleScreenShare,
    videoSource: screenShareVideoSource,
  } = useScreenShare({
    announceCallState,
    cameraStreamRef,
    inCallRef,
    onShareStarted: playLocalShareStarted,
    onShareStopped: playLocalShareStopped,
    replacePeerTrack,
    screenAudioSessionRef,
    screenStreamRef,
    setIsSharing,
    setPermissionError,
    setVideoEncodingProfile,
    startCall,
    profileId: screenShareProfileId,
    setProfileId: updateScreenShareProfile,
  });

  const changeStreamWatching = useCallback((peerId, watching) => {
    const nextWatching = Boolean(watching);
    const bundle = remoteStreams[peerId];
    bundle?.videoStream?.getVideoTracks?.().forEach((track) => { track.enabled = nextWatching; });
    bundle?.screenAudioStream?.getAudioTracks?.().forEach((track) => { track.enabled = nextWatching; });
    setStreamWatching((current) => ({ ...current, [peerId]: nextWatching }));
    const channel = peerConnectionsRef.current.get(peerId)?.dataChannel;
    if (channel?.readyState === 'open') {
      try { sendDataChannelPacket(channel, { type: 'stream-watch', roomId: roomIdRef.current, watching: nextWatching }); } catch { /* Local pause still saves decode work. */ }
    }
  }, [remoteStreams]);

  const openParticipantVolumes = useCallback((event, person) => {
    if (person.self) return;
    event.preventDefault();
    setVolumePopover({ peerId: person.peerId, name: person.name, x: event.clientX, y: event.clientY });
  }, []);

  const updateParticipantVolumes = useCallback((peerId, values) => {
    setParticipantVolumes((current) => ({
      ...current,
      [peerId]: {
        voice: Math.max(0, Math.min(200, Number(values.voice) || 0)),
        stream: Math.max(0, Math.min(200, Number(values.stream) || 0)),
      },
    }));
  }, []);

  const publishMessage = useCallback((payload) => {
    if (!roomIdRef.current) return;
    const text = String(payload?.text || '').trim();
    if (!text && !payload?.image && !payload?.attachment) return;
    mergeMessages([{
      id: messageId(),
      roomId: roomIdRef.current,
      senderId: peerIdRef.current || 'local',
      senderName: displayNameRef.current,
      senderAvatar: profileAvatarRef.current,
      text,
      image: payload?.image || '',
      imageName: String(payload?.imageName || '').slice(0, 120),
      attachment: payload?.attachment || undefined,
      logicalClock: nextMessageClock(),
      timestamp: Date.now(),
    }]);
  }, [mergeMessages, nextMessageClock]);

  const publishDirectMessage = useCallback(async (payload) => {
    const peer = peers.find((candidate) => contactIdFor(candidate) === activeContactIdRef.current);
    const contact = contacts.find((candidate) => candidate.id === activeContactIdRef.current);
    const conversationId = directConversationRef.current;
    const channel = peer ? peerConnectionsRef.current.get(peer.peerId)?.dataChannel : null;
    if (!contact || !conversationId || channel?.readyState !== 'open') {
      setPermissionError('A conexão P2P com este amigo ainda não está pronta.');
      return;
    }
    const message = {
      id: messageId(),
      conversationId,
      senderId: clientIdRef.current,
      senderName: displayNameRef.current,
      senderAvatar: profileAvatarRef.current,
      recipientId: contact.clientId || contact.id,
      recipientName: contact.name,
      recipientAvatar: contact.avatar || '',
      text: String(payload?.text || '').trim(),
      image: payload?.image || '',
      imageName: String(payload?.imageName || '').slice(0, 120),
      attachment: payload?.attachment || undefined,
      logicalClock: nextMessageClock(),
      timestamp: Date.now(),
    };
    if (!message.text && !message.image && !message.attachment) return;
    try {
      sendDataChannelPacket(channel, {
        type: 'direct-message',
        roomId: roomIdRef.current,
        conversationId,
        fromClientId: clientIdRef.current,
        toClientId: peer.clientId || peer.peerId,
        message,
      });
      await mergeDirectMessages(conversationId, [message]);
      if (message.attachment?.id) await sendAttachmentToPeer(peer.peerId, message.attachment.id);
    } catch {
      setPermissionError('Não foi possível enviar esta mensagem P2P.');
    }
  }, [contacts, mergeDirectMessages, nextMessageClock, peers, sendAttachmentToPeer]);

  const sendMessage = useCallback((event) => {
    event.preventDefault();
    const cleanDraft = draft.trim();
    if (!cleanDraft) return;
    if (!activeContactIdRef.current && !roomIdRef.current) {
      setPermissionError('Crie ou selecione uma sala antes de enviar mensagens.');
      return;
    }
    if (activeContactIdRef.current) {
      void publishDirectMessage({ text: cleanDraft }).finally(() => scrollMessageListToBottom('smooth'));
    } else {
      publishMessage({ text: cleanDraft });
      scrollMessageListToBottom('smooth');
    }
    setDraft('');
  }, [draft, publishDirectMessage, publishMessage, scrollMessageListToBottom]);

  const handleAttachmentFile = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!activeContactIdRef.current && !roomIdRef.current) {
      setPermissionError('Crie ou selecione uma sala antes de enviar arquivos.');
      return;
    }
    if (file.size > MAX_ATTACHMENT_SIZE) {
      setPermissionError(`Escolha um arquivo de até ${formatFileSize(MAX_ATTACHMENT_SIZE)}.`);
      return;
    }
    try {
      setPermissionError('');
      const attachmentId = messageId();
      const conversationId = activeContactIdRef.current ? directConversationRef.current : roomIdRef.current;
      const attachment = {
        id: attachmentId,
        name: String(file.name || 'arquivo').slice(0, 160),
        type: String(file.type || 'application/octet-stream').slice(0, 120),
        size: file.size,
        ready: true,
      };
      const stored = await writeAttachmentBlob(attachmentId, file, { ...attachment, conversationId });
      if (!stored) {
        setPermissionError('Não foi possível guardar o arquivo neste computador. Verifique o espaço disponível.');
        return;
      }
      if (activeContactIdRef.current) {
        await publishDirectMessage({ attachment });
      } else {
        publishMessage({ attachment });
      }
      scrollMessageListToBottom('smooth');
    } catch (error) {
      setPermissionError(error?.message === 'image-too-large' ? 'Esse arquivo ficou grande demais para enviar pela conexão P2P.' : 'Não foi possível preparar esse arquivo.');
    }
  }, [publishDirectMessage, publishMessage, scrollMessageListToBottom]);

  const saveProfile = useCallback((event) => {
    event?.preventDefault();
    const nextName = nameDraft.trim().slice(0, 32) || displayNameRef.current;
    const nextStatus = normalizePresenceStatus(profileStatusRef.current);
    if (!nextName) return;
    localStorage.setItem('jump-name', nextName);
    displayNameRef.current = nextName;
    setDisplayName(nextName);
    localStorage.setItem(PROFILE_STATUS_KEY, nextStatus);
    setProfileStatus(nextStatus);
    setProfileSettingsOpen(false);
    sendSignal({ type: 'profile', name: nextName, avatar: profileAvatarRef.current, status: nextStatus });
  }, [nameDraft, sendSignal]);

  const updateProfileStatus = useCallback((nextStatus) => {
    const normalized = normalizePresenceStatus(nextStatus);
    profileStatusRef.current = normalized;
    setProfileStatus(normalized);
    sendSignal({ type: 'profile', name: displayNameRef.current, avatar: profileAvatarRef.current, status: normalized });
  }, [sendSignal]);

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
      profileAvatarRef.current = avatar;
      sendSignal({ type: 'profile', name: displayNameRef.current, avatar, status: profileStatusRef.current });
    } catch {
      setPermissionError('Não foi possível carregar essa foto.');
    }
  }, [sendSignal]);

  const createRoom = useCallback((event) => {
    event.preventDefault();
    const label = roomDraft.trim();
    const password = roomPasswordDraft.trim();
    if (!label || !password) {
      setPermissionError('Defina um nome e uma senha para criar a sala.');
      return;
    }
    joinRoom(slugify(label), label, password);
    setRoomDraft('');
    setRoomPasswordDraft('');
    setShowRoomCreator(false);
  }, [joinRoom, roomDraft, roomPasswordDraft]);

  const openRoom = useCallback((room) => {
    const storedPassword = rememberedRoomPassword(room.id);
    if (room.protected && !storedPassword) {
      setPermissionError('Digite a senha para entrar nesta sala.');
      setRoomAccess({ roomId: room.id, name: room.name, password: '' });
      return;
    }
    markUnreadAsRead(roomUnreadKey(room.id));
    joinRoom(room.id, room.name, storedPassword);
  }, [joinRoom, markUnreadAsRead]);

  const submitRoomAccess = useCallback((event) => {
    event.preventDefault();
    const password = roomAccess?.password?.trim() || '';
    if (!roomAccess || !password) {
      setPermissionError('Digite a senha desta sala.');
      return;
    }
    rememberRoomPassword(roomAccess.roomId, password);
    joinRoom(roomAccess.roomId, roomAccess.name, password);
    setRoomAccess(null);
    setPermissionError('');
  }, [joinRoom, roomAccess]);

  const beginRoomNameEdit = useCallback(() => {
    setRoomNameDraft(roomName);
    setEditingRoomName(true);
    setRoomInfoOpen(false);
  }, [roomName]);

  const cancelRoomNameEdit = useCallback(() => {
    setRoomNameDraft(roomNameRef.current);
    setEditingRoomName(false);
  }, []);

  const saveRoomName = useCallback((event) => {
    event?.preventDefault();
    const nextName = roomNameDraft.replace(/\s+/g, ' ').trim().slice(0, 48);
    if (!nextName) {
      setPermissionError('Defina um nome para a sala.');
      return;
    }
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setPermissionError('Conecte-se à rede antes de renomear a sala.');
      return;
    }
    roomNameRef.current = nextName;
    setRoomName(nextName);
    setRoomNameDraft(nextName);
    setRooms((current) => current.map((room) => room.id === roomIdRef.current ? { ...room, name: nextName } : room));
    setEditingRoomName(false);
    sendSignal({ type: 'rename-room', roomId: roomIdRef.current, name: nextName });
  }, [roomNameDraft, sendSignal]);

  const deleteRoom = useCallback(() => {
    if (!roomIdRef.current) return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setPermissionError('Conecte-se à rede antes de excluir a sala.');
      return;
    }
    const confirmed = window.confirm(`Excluir a sala "${roomNameRef.current}"? Essa ação remove a sala para todos os participantes.`);
    if (!confirmed) return;
    sendSignal({ type: 'delete-room', roomId: roomIdRef.current });
  }, [sendSignal]);

  useEffect(() => {
    if (!pendingRoomFallback) return;
    const nextRoom = pendingRoomFallback;
    setPendingRoomFallback(null);
    const storedPassword = rememberedRoomPassword(nextRoom.id);
    if (nextRoom.protected && !storedPassword) {
      setRoomAccess({ roomId: nextRoom.id, name: nextRoom.name, password: '' });
      return;
    }
    joinRoom(nextRoom.id, nextRoom.name, storedPassword);
  }, [joinRoom, pendingRoomFallback]);

  const handleUpdate = useCallback(async () => {
    const desktop = globalThis.jumpDesktop;
    if (!desktop || desktop.isPackaged !== true) {
      // Builds locais não consultam o updater nem exibem uma falsa atualização.
      setUpdateDialogOpen(false);
      return;
    }
    setUpdateDialogOpen(true);
    try {
      let result;
      if (updateState.status === 'available') {
        result = await desktop.downloadUpdate();
      } else if (updateState.status === 'downloaded') {
        result = await desktop.installUpdate();
      } else {
        result = await desktop.checkForUpdates();
      }
      if (result?.status) {
        setUpdateState((current) => (result.revision || 0) < (current.revision || 0) ? current : { ...current, ...result });
      }
    } catch (error) {
      setUpdateState({ status: 'error', message: error?.message || 'Não foi possível consultar atualizações.' });
    }
  }, [updateState.status]);

  const isDesktop = Boolean(globalThis.jumpDesktop?.isDesktop);
  const isOfficialDesktopBuild = isDesktop && globalThis.jumpDesktop?.isPackaged === true;
  const isDevelopmentDesktopBuild = isDesktop && !isOfficialDesktopBuild;
  const updateBusy = ['checking', 'downloading', 'installing'].includes(updateState.status);
  const updateDialogHeading = isDevelopmentDesktopBuild || updateState.status === 'dev'
    ? 'versão de desenvolvimento'
    : updateState.status === 'checking'
    ? 'procurando atualizações...'
    : updateState.status === 'downloading'
      ? `baixando atualização ${updateState.percent || 0}%`
      : updateState.status === 'installing'
        ? 'instalando atualização...'
      : updateState.status === 'available'
        ? 'atualização encontrada'
        : updateState.status === 'downloaded'
          ? 'atualização pronta'
          : updateState.status === 'not-available'
            ? 'você já está atualizado'
            : updateState.status === 'dev'
              ? 'atualização indisponível'
              : updateState.status === 'error'
                ? 'não foi possível atualizar'
                : 'atualizações';
  const updateDialogMessage = isDevelopmentDesktopBuild || updateState.status === 'dev'
    ? 'atualizações só ficam disponíveis na versão oficial empacotada'
    : updateState.status === 'checking'
    ? 'consultando o servidor de atualizações'
    : updateState.status === 'downloading'
      ? 'aguarde enquanto o pacote é baixado'
      : updateState.status === 'installing'
        ? 'o JUMP será fechado e reaberto automaticamente'
      : updateState.message || (updateState.status === 'available'
        ? `versão ${updateState.version || 'nova'} disponível`
        : updateState.status === 'downloaded'
          ? 'reinicie o aplicativo para concluir'
          : updateState.status === 'not-available'
            ? 'nenhuma versão nova foi encontrada'
            : 'clique em atualizar para consultar novamente');
  const updateProgress = updateState.status === 'downloading'
    ? Math.max(0, Math.min(100, Number(updateState.percent) || 0))
    : 38;
  const updateLabel = isDevelopmentDesktopBuild
    ? 'versão dev'
    : updateState.status === 'available'
    ? 'baixar update'
    : updateState.status === 'downloaded'
      ? 'reiniciar e atualizar'
      : updateState.status === 'downloading'
        ? `baixando ${updateState.percent || 0}%`
        : updateState.status === 'installing'
          ? 'instalando'
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
  const activeCallParticipants = useMemo(() => participants.filter((person) => person.self ? inCall : remoteCallStates[person.peerId]?.inCall === true), [inCall, participants, remoteCallStates]);
  const hasActiveCall = Boolean(inCall || Object.values(remoteCallStates).some((state) => state.inCall === true));
  const chatVisible = !callPanelOpen || chatPanelOpen;
  useEffect(() => {
    if (focusedCallPeerId && !activeCallParticipants.some((person) => person.peerId === focusedCallPeerId)) setFocusedCallPeerId('');
  }, [activeCallParticipants, focusedCallPeerId]);
  useEffect(() => {
    if (!hasActiveCall) {
      callStartedAtRef.current = 0;
      setCallDurationSeconds(0);
      return undefined;
    }
    if (!callStartedAtRef.current) callStartedAtRef.current = Date.now();
    const updateDuration = () => setCallDurationSeconds(Math.floor((Date.now() - callStartedAtRef.current) / 1000));
    updateDuration();
    const timer = window.setInterval(updateDuration, 1000);
    return () => window.clearInterval(timer);
  }, [hasActiveCall]);
  const directoryFriends = useMemo(() => {
    const byId = new Map(contacts.map((contact) => [contact.id, { ...contact }]));
    peers.forEach((peer) => {
      const id = contactIdFor(peer);
      if (!id) return;
      const previous = byId.get(id) || {};
      byId.set(id, {
        ...previous,
        ...peer,
        id,
        clientId: peer.clientId || previous.clientId || id,
        status: normalizePresenceStatus(peer.status || previous.status || 'online'),
        connected: peer.connected !== false,
        lastSeen: Date.now(),
      });
    });
    return [...byId.values()].filter((contact) => contact.name);
  }, [contacts, peers]);
  const directPeer = directoryFriends.find((peer) => peer.id === activeContactId) || null;
  const isDirectChat = Boolean(activeContactId && directPeer);
  const hasActiveRoom = Boolean(roomId);
  const visibleMessages = isDirectChat ? directMessages : messages;
  const visibleMessageContext = isDirectChat ? `direct:${directConversationRef.current}` : `room:${roomId}`;
  useEffect(() => {
    const contextChanged = messageListContextRef.current !== visibleMessageContext;
    if (contextChanged) {
      messageListContextRef.current = visibleMessageContext;
      messageListStickToBottomRef.current = true;
    }
    if (!messageListStickToBottomRef.current) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const list = messageListRef.current;
      if (!list || !messageListStickToBottomRef.current) return;
      list.scrollTop = list.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isDirectChat, visibleMessageContext, visibleMessages.length]);
  const directoryRooms = useMemo(() => {
    if (!roomId) return rooms;
    if (rooms.some((room) => room.id === roomId)) return rooms;
    return [{ id: roomId, name: roomName, count: peerCount, protected: roomProtected }, ...rooms];
  }, [peerCount, roomId, roomName, roomProtected, rooms]);
  const filteredRooms = directoryRooms.filter((room) => `${room.name} ${room.id}`.toLowerCase().includes(roomSearch.toLowerCase()));
  const filteredFriends = directoryFriends.filter((person) => `${person.name} ${person.clientId || person.peerId}`.toLowerCase().includes(roomSearch.toLowerCase()));
  const currentRoomDirectoryEntry = directoryRooms.find((room) => room.id === roomId);
  const infoCreatedAt = roomCreatedAt || currentRoomDirectoryEntry?.createdAt || 0;
  const infoMemberCount = signalStatus === 'connected' ? peers.length + 1 : peers.length;
  const infoMessageCount = messages.filter((message) => message.kind !== 'system').length;
  const infoCreatedLabel = infoCreatedAt
    ? new Date(infoCreatedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    : 'indisponível';

  return (
    <>
      {isDesktop && <DesktopTitleBar />}
      <div className={`app-shell ${isDesktop ? 'has-desktop-titlebar' : ''}`}>
      <aside className={`workspace-sidebar ${mobileSidebarOpen ? 'is-mobile-open' : ''}`}>
        <div className="workspace-head">
          <img src={winAppIcon} alt="JUMP" className="workspace-head-icon" draggable="false" />
          <div className="workspace-head-copy">
            <h1>JUMP NETWORK</h1>
            <p className="eyebrow"><span className="network-status-light" /> rede em tempo real</p>
          </div>
        </div>
        <div className="search-box" role="search">
          <label htmlFor="sidebar-search">Localizar:</label>
          <span className="search-input-frame"><input id="sidebar-search" value={roomSearch} onChange={(event) => setRoomSearch(event.target.value)} placeholder="salas ou amigos" aria-label="Buscar salas e amigos" /></span>
          <button type="button" aria-label="Localizar" onClick={() => document.getElementById('sidebar-search')?.focus()}><Search size={14} /></button>
        </div>

        <div className="side-scroll">
          <section className="directory-group unified-directory-section is-rooms" aria-labelledby="rooms-directory-title">
            <div className="section-label directory-caption">
              <span className="directory-caption-title"><WinIcon name="computer" size={19} /><strong id="rooms-directory-title">salas</strong><small>· {directoryRooms.length}</small></span>
              <button type="button" className="directory-header-button" aria-label={showRoomCreator ? 'Fechar criação de sala' : 'Criar sala'} onClick={() => setShowRoomCreator((value) => !value)}><Plus size={14} /></button>
            </div>
            {showRoomCreator && (
              <form className="room-creator" onSubmit={createRoom}>
                <strong>Nova sala</strong>
                <label><span>Nome:</span><input autoFocus value={roomDraft} onChange={(event) => setRoomDraft(event.target.value)} aria-label="Nome da sala" /></label>
                <label><span>Senha:</span><input type="password" value={roomPasswordDraft} onChange={(event) => setRoomPasswordDraft(event.target.value)} aria-label="Senha da sala" /></label>
                <div className="room-creator-actions">
                  <button type="submit">Criar</button>
                  <button type="button" onClick={() => setShowRoomCreator(false)}>Cancelar</button>
                </div>
              </form>
            )}
            <div className="directory-list" role="list" aria-label="Salas">
              {filteredRooms.map((room) => (
                <div className={`server-entry ${!isDirectChat && room.id === roomId ? 'is-current' : ''}`} key={room.id} role="listitem">
                  <button type="button" className={`directory-row room-list-row ${!isDirectChat && room.id === roomId ? 'is-current' : ''}`} onClick={() => openRoom(room)}>
                    <span className="directory-item-icon room-item-icon"><WinIcon name="computer" size={25} />{room.protected && <LockKeyhole size={11} className="room-lock-badge" />}</span>
                    <span className="directory-item-copy"><strong>{room.name}</strong><small>{room.protected ? 'sala protegida' : 'chat e chamada'}</small></span>
                   {unreadCounts[roomUnreadKey(room.id)] > 0 && <span className="directory-item-badge unread-badge has-unread" aria-label={`${unreadCounts[roomUnreadKey(room.id)]} mensagens não lidas`}>{unreadCounts[roomUnreadKey(room.id)]}</span>}
                  </button>
                  {!isDirectChat && room.id === roomId && activeCallParticipants.length > 0 && (
                    <div className="server-call-members" aria-label="Participantes em call nesta sala">
                      <div className="server-call-label"><WinIcon name="phone" size={20} /><span>em chamada · {activeCallParticipants.length}</span></div>
                      <div className="voice-member-list">
                        {activeCallParticipants.map((person) => {
                          const callState = person.self ? { muted: isMuted, deafened: isDeafened, sharing: isSharing } : (remoteCallStates[person.peerId] || {});
                          const muted = Boolean(callState.muted);
                          return (
                            <div className="voice-member" key={person.peerId}>
                              <Avatar initials={initialsFor(person.name)} tone={person.self ? 'yellow' : toneFor(person.peerId)} size="xs" src={person.avatar} alt={person.name} live speaking={Boolean(speakingPeers[person.self ? 'self' : person.peerId])} />
                              <span><strong>{person.self ? `${person.name} (você)` : person.name}</strong><small>{muted ? 'mutado' : 'conectado'}</small></span>
                              <span className="voice-member-status" aria-label="Estados da chamada">
                                {muted && <MicOff size={13} className="voice-member-mic is-muted" />}
                                {callState.deafened && <VolumeX size={13} className="voice-member-mic is-deafened" />}
                                {callState.sharing && <MonitorUp size={13} className="voice-member-mic is-sharing" />}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {filteredRooms.length === 0 && <div className="directory-empty"><WinIcon name="computer" size={25} /><span><strong>{signalStatus === 'connected' ? 'Nenhuma sala encontrada' : 'Conectando à rede...'}</strong><small>{signalStatus === 'connected' ? 'Tente outro nome ou crie uma sala.' : 'Aguarde alguns instantes.'}</small></span></div>}
          </section>

          <section className="directory-group unified-directory-section is-friends" aria-labelledby="friends-directory-title">
            <div className="section-label directory-caption">
              <span className="directory-caption-title"><WinIcon name="people" size={19} /><strong id="friends-directory-title">amigos</strong><small>· {directoryFriends.length}</small></span>
              <span className="directory-presence">{directoryFriends.filter((person) => person.connected && person.status !== 'offline').length ? 'conectados' : 'vazio'}</span>
            </div>
            <div className="directory-list" role="list" aria-label="Amigos">
              {filteredFriends.map((person) => (
                <button type="button" className={`directory-row friend-list-row ${activeContactId === person.id ? 'is-current' : ''}`} key={person.id} onClick={() => openDirectChat(person)}>
                  <span className="directory-item-icon"><Avatar initials={initialsFor(person.name)} tone={toneFor(person.id)} size="md" src={person.avatar} alt={person.name} presence={person.status} /></span>
                  <span className="directory-item-copy"><strong>{person.name}</strong><small>{remoteStreams[person.peerId] ? 'em chamada' : presenceLabel(person.status)}</small></span>
                  {unreadCounts[directUnreadKey(person.id)] > 0 && <span className="directory-item-badge friend-state-badge has-unread" aria-label={`${unreadCounts[directUnreadKey(person.id)]} mensagens não lidas`}>{unreadCounts[directUnreadKey(person.id)]}</span>}
                </button>
              ))}
            </div>
            {filteredFriends.length === 0 && <div className="directory-empty"><WinIcon name="people" size={25} /><span><strong>Nenhum amigo salvo</strong><small>Quando você conversar com alguém, o contato ficará disponível aqui mesmo offline.</small></span></div>}
          </section>
        </div>

        <div className="profile-strip">
          <button type="button" className="profile-avatar-button" onClick={() => { setNameDraft(displayName); setProfileSettingsOpen(true); }} aria-label="Abrir configurações do perfil" title="Configurações do perfil">
            <Avatar initials={initialsFor(displayName)} tone="yellow" size="md" src={profileAvatar} alt={displayName} presence={profileStatus} />
          </button>
          <button type="button" className="profile-name" onClick={() => { setNameDraft(displayName); setProfileSettingsOpen(true); }}><strong>{displayName}</strong></button>
          <div className="profile-actions"><IconButton label="Configurações do perfil" onClick={() => { setNameDraft(displayName); setProfileSettingsOpen(true); }}><Settings2 size={15} /></IconButton></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button type="button" className="mobile-menu" onClick={() => setMobileSidebarOpen(true)} aria-label="Abrir menu"><PanelLeft size={17} /></button>
          <div className="breadcrumb"><span>JUMP NETWORK</span><span className="slash">/</span><strong>{isDirectChat ? directPeer.name : roomName}</strong></div>
          <div className="topbar-actions">
            {isDesktop && <button type="button" className={`update-button ${updateState.status === 'downloaded' ? 'is-ready' : ''} ${isDevelopmentDesktopBuild ? 'is-dev' : ''}`} onClick={isDevelopmentDesktopBuild ? undefined : handleUpdate} disabled={isDevelopmentDesktopBuild || updateBusy} aria-disabled={isDevelopmentDesktopBuild} title={isDevelopmentDesktopBuild ? 'Versão de desenvolvimento — atualizações desativadas' : 'Verificar atualizações'}><WinIcon name={isDevelopmentDesktopBuild ? 'app' : 'update'} size={20} /> {updateLabel}</button>}
            <SignalBadge status={signalStatus} peerCount={peerCount} />
            <button type="button" className="invite-button" onClick={copyRoomInvite} disabled={!roomId} title="Copiar convite da sala"><Link2 size={17} /> {inviteCopied ? 'copiado' : 'copiar convite'}</button>
            <IconButton label={callPanelOpen ? 'Fechar chamada' : 'Abrir chamada'} className={`call-header-button ${hasActiveCall ? 'has-call' : ''}`} active={callPanelOpen} onClick={() => setCallPanelOpen((value) => !value)}><WinIcon name="phone" size={22} />{hasActiveCall && <span className="call-header-dot" />}</IconButton>
            <IconButton label={callPanelOpen ? (chatPanelOpen ? 'Ocultar chat' : 'Mostrar chat') : 'Chat da sala'} className="chat-toggle-button" active={callPanelOpen && chatPanelOpen} disabled={!callPanelOpen} onClick={() => setChatPanelOpen((value) => !value)}><MessageCircle size={20} /></IconButton>
            <IconButton label="Notificações"><WinIcon name="bell" size={21} /></IconButton>
            <IconButton label="Ajuda"><CircleHelp size={16} /></IconButton>
          </div>
        </header>

        <div className="dashboard-scroll">
          <div className={`content-grid ${callPanelOpen ? 'is-call-open' : 'is-chat-only'} ${!chatVisible ? 'is-chat-hidden' : ''}`}>
            <div className={`content-column ${callPanelOpen ? 'is-call-visible' : 'is-chat-visible'} ${callPanelOpen && chatVisible ? 'has-call-chat-split' : ''} ${!chatVisible ? 'is-chat-hidden' : ''}`} style={callPanelOpen && chatVisible ? { '--call-pane-percent': `${callChatSplit}%` } : undefined}>
              {callPanelOpen && <section className="stage-card">
                <div className="stage-header">
                  <div className="stage-title"><strong>{roomName} call {formatCallDuration(callDurationSeconds)}</strong></div>
                  <button type="button" className="stage-header-close win98-close-control" disabled aria-label="Janela da chamada fixa" title="Janela da chamada fixa">×</button>
                </div>
                <div className={`stage-body ${activeCallParticipants.length ? 'has-participants' : 'is-empty'} ${focusedCallPeerId ? 'has-focused-stream' : ''}`}>
                  <div className={`call-stream-grid ${focusedCallPeerId ? 'has-focused-stream' : ''}`}>
                    {activeCallParticipants.length ? activeCallParticipants.map((person) => {
                      const localVideoStream = person.self
                        ? (isSharing ? screenStreamRef.current : isCameraOn ? cameraStreamRef.current : null)
                        : null;
                      const remoteBundle = person.self ? null : remoteStreams[person.peerId];
                      const videoStream = localVideoStream || remoteBundle?.videoStream || null;
                      const remoteCallState = remoteCallStates[person.peerId] || {};
                      const expectsVideo = person.self ? (isSharing || isCameraOn) : (remoteCallState.sharing || remoteCallState.camera);
                      const hasVideo = Boolean(expectsVideo && videoStream?.getVideoTracks?.().some((track) => track.readyState !== 'ended'));
                      const personIsSpeaking = Boolean(speakingPeers[person.self ? 'self' : person.peerId]);
                      const personLabel = person.self ? `${person.name} (você)` : person.name;
                      const isWatching = person.self || streamWatching[person.peerId] !== false;
                      const volumes = participantVolumes[person.peerId] || { voice: 100, stream: 100 };
                      const stateLabel = person.self
                        ? (isSharing ? `compartilhando a tela${screenAudioSessionRef.current ? ' + áudio' : ''}` : isCameraOn ? 'câmera ativa' : 'no palco')
                        : (remoteCallState.sharing ? (isWatching ? `compartilhando a tela${remoteCallState.sharingAudio ? ' + áudio' : ''}` : 'transmissão pausada por você') : remoteCallState.camera ? 'câmera ativa' : 'em chamada');
                      return (
                        <CallStreamCard
                          key={person.peerId}
                          avatar={<Avatar initials={initialsFor(person.name)} tone={person.self ? 'yellow' : toneFor(person.peerId)} size="xl" src={person.avatar} alt={person.name} live={person.self || Boolean(remoteStreams[person.peerId])} speaking={personIsSpeaking} />}
                          hasVideo={hasVideo}
                          isDeafened={isDeafened}
                          isFocused={focusedCallPeerId === person.peerId}
                          isSelf={person.self}
                          isSharing={person.self ? isSharing : remoteCallState.sharing}
                          isSharingAudio={person.self ? Boolean(screenAudioSessionRef.current) : remoteCallState.sharingAudio}
                          isSpeaking={personIsSpeaking}
                          isWatching={isWatching}
                          label={personLabel}
                          microphoneStream={remoteBundle?.microphoneStream}
                          onContextMenu={person.self ? undefined : (event) => openParticipantVolumes(event, person)}
                          onDoubleClick={() => setFocusedCallPeerId((current) => current === person.peerId ? '' : person.peerId)}
                          onWatchingChange={(watching) => changeStreamWatching(person.peerId, watching)}
                          screenAudioStream={remoteBundle?.screenAudioStream}
                          sinkId={selectedAudioOutputId}
                          stateLabel={stateLabel}
                          streamVolume={volumes.stream / 100}
                          videoStream={videoStream}
                          voiceVolume={volumes.voice / 100}
                        />
                      );
                    }) : (
                      <div className="call-empty-card">
                        <div className={`call-empty-state dialup-state ${signalStatus === 'connected' ? 'is-ready' : 'is-connecting'}`}>
                          <div className="dialup-titlebar"><strong>Conexão de rede</strong><button type="button" className="win98-close-control" disabled aria-label="Aviso fixo">×</button></div>
                          <div className="dialup-visual"><span className="connection-animation" aria-hidden="true" style={{ '--connection-sprite': `url(${winConnectionSprite})` }} /></div>
                          <strong>{signalStatus === 'connected' ? 'linha P2P pronta' : 'conectando à rede...'}</strong>
                          <small>{signalStatus === 'connected' ? 'aguardando outro participante' : 'discando para o servidor de sinalização'}</small>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="stage-controls">
                  <div className="stage-control-hint">{inCall ? 'mídia P2P ativa' : 'entre na sala para habilitar áudio e tela'}</div>
                  <div className="call-controls">
                    <IconButton label={isMuted ? 'Ativar microfone' : 'Silenciar microfone'} className={isMuted ? 'control-off' : ''} active={inCall && !isMuted} onClick={toggleMute}>{isMuted ? <MicOff size={18} /> : <Mic size={18} />}</IconButton>
                    <IconButton label={isDeafened ? 'Ativar áudio' : 'Desativar áudio'} className={isDeafened ? 'control-off' : ''} active={inCall && !isDeafened} onClick={toggleDeafen}>{isDeafened ? <VolumeX size={18} /> : <Headphones size={18} />}</IconButton>
                    <IconButton label={isCameraOn ? 'Desligar câmera' : 'Ligar câmera'} className={isCameraOn ? 'control-on' : ''} active={isCameraOn} onClick={toggleCamera}>{isCameraOn ? <Video size={18} /> : <VideoOff size={18} />}</IconButton>
                    <IconButton label={isSharing ? 'Parar compartilhamento' : 'Compartilhar tela'} className={isSharing ? 'control-on' : ''} active={isSharing} onClick={toggleScreenShare}><MonitorUp size={18} /></IconButton>
                    <IconButton label="Configurar dispositivos de áudio" className={showDeviceSettings ? 'control-on' : ''} active={showDeviceSettings} onClick={() => setShowDeviceSettings((value) => !value)}><Settings2 size={17} /></IconButton>
                    <span className="controls-divider" />
                    {inCall ? <button type="button" className="leave-button" onClick={leaveCall}><WinIcon name="phone" size={23} /> sair</button> : <button type="button" className="join-call-button" onClick={startCall}><WinIcon name="phone" size={23} /> entrar na chamada</button>}
                  </div>
                </div>
                {showDeviceSettings && (
                  <div className="device-settings-popover" role="dialog" aria-labelledby="device-settings-title">
                    <div className="device-settings-titlebar">
                      <div className="device-settings-titlebar-label"><img className="room-info-titlebar-icon" src={winAppIcon} alt="" aria-hidden="true" draggable="false" /><strong id="device-settings-title">JUMP — dispositivos de áudio</strong></div>
                      <div className="device-settings-title-actions">
                        <button type="button" className="device-refresh-button" onClick={refreshAudioDevices} aria-label="Atualizar dispositivos" title="Atualizar dispositivos"><RefreshCw size={13} /></button>
                        <button type="button" className="device-close-button win98-close-control" onClick={() => setShowDeviceSettings(false)} aria-label="Fechar configurações de áudio" title="Fechar">×</button>
                      </div>
                    </div>
                    <div className="device-settings-body">
                      <label className="device-field"><span><Mic size={14} /> microfone</span><select value={selectedAudioInputId} onChange={handleAudioInputChange}><option value="">microfone padrão</option>{audioInputDevices.map((device, index) => <option key={device.deviceId || `input-${index}`} value={device.deviceId}>{device.label || `microfone ${index + 1}`}</option>)}</select></label>
                      <label className="device-field"><span><Volume2 size={14} /> saída</span><select value={selectedAudioOutputId} onChange={handleAudioOutputChange}><option value="">saída padrão do sistema</option>{audioOutputDevices.map((device, index) => <option key={device.deviceId || `output-${index}`} value={device.deviceId}>{device.label || `saída ${index + 1}`}</option>)}</select></label>
                      <small className="device-settings-hint">A troca do microfone vale imediatamente. A saída usa o seletor do sistema quando o navegador oferece suporte.</small>
                    </div>
                  </div>
                )}
              </section>}

              {volumePopover && (
                <ParticipantVolumePopover
                  anchor={volumePopover}
                  name={volumePopover.name}
                  values={participantVolumes[volumePopover.peerId] || { voice: 100, stream: 100 }}
                  sharing={Boolean(remoteCallStates[volumePopover.peerId]?.sharingAudio)}
                  onChange={(values) => updateParticipantVolumes(volumePopover.peerId, values)}
                  onClose={() => setVolumePopover(null)}
                />
              )}

              {callPanelOpen && chatVisible && <PaneResizeHandle value={callChatSplit} onChange={updateCallChatSplit} />}

              {(permissionError || signalStatus !== 'connected') && <div className={`notice-bar ${permissionError ? 'is-warning' : ''}`}><span>{permissionError || 'Sinalização offline: peers conectados continuam conversando; novas entradas precisam do servidor.'}</span><IconButton label="Fechar aviso" className="notice-close-button win98-close-control" onClick={() => setPermissionError('')}><X size={15} /></IconButton></div>}

              {chatVisible && <section className="chat-card">
                <div className="chat-head">
                  <div className="chat-head-title">
                    {isDirectChat ? (
                      <div className="direct-chat-heading">
                        <Avatar initials={initialsFor(directPeer.name)} tone={toneFor(directPeer.id)} size="md" src={directPeer.avatar} alt={directPeer.name} presence={directPeer.status} />
                        <div><h3>{directPeer.name}</h3></div>
                      </div>
                    ) : editingRoomName ? (
                      <form className="room-name-editor" onSubmit={saveRoomName}>
                        <input autoFocus value={roomNameDraft} onChange={(event) => setRoomNameDraft(event.target.value)} aria-label="Nome da sala" maxLength={48} />
                        <button type="submit" aria-label="Salvar nome da sala" title="Salvar"><Check size={13} /></button>
                        <button type="button" className="win98-close-control" aria-label="Cancelar edição" title="Cancelar" onClick={cancelRoomNameEdit}><X size={13} /></button>
                      </form>
                    ) : (
                      <div className="room-name-heading"><h3>{roomName}</h3><IconButton label="Editar nome da sala" className="room-edit-button" onClick={beginRoomNameEdit}><WinIcon name="pencil" size={25} /></IconButton></div>
                    )}
                  </div>
                  <div className="chat-head-actions">
                    {isDirectChat ? (
                      <IconButton label="Voltar para a sala" onClick={closeDirectChat}><WinIcon name="computer" size={19} /></IconButton>
                    ) : (
                      <>
                        <IconButton label="Informações da sala" className={roomInfoOpen ? 'is-active' : ''} active={roomInfoOpen} onClick={() => { setRoomInfoOpen((value) => !value); setEditingRoomName(false); }}><Info size={16} /></IconButton>
                        <IconButton label="Excluir sala" className="room-delete-button win98-close-control win98-close-control--danger" onClick={deleteRoom}><X size={16} /></IconButton>
                      </>
                    )}
                  </div>
                </div>
                {!isDirectChat && roomInfoOpen && (
                  <div className="room-info-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setRoomInfoOpen(false); }}>
                    <div className="room-info-dialog" role="dialog" aria-modal="true" aria-labelledby="room-info-title" onMouseDown={(event) => event.stopPropagation()}>
                      <div className="room-info-titlebar">
                        <div className="room-info-titlebar-label"><img className="room-info-titlebar-icon" src={winAppIcon} alt="" aria-hidden="true" draggable="false" /><strong id="room-info-title">JUMP — informações da sala</strong></div>
                        <button type="button" className="win98-close-control" aria-label="Fechar informações" onClick={() => setRoomInfoOpen(false)}>×</button>
                      </div>
                      <div className="room-info-body">
                        <div className="room-info-symbol" aria-hidden="true"><Info size={25} /></div>
                        <div className="room-info-data">
                          <strong className="room-info-room-name">{roomName}</strong>
                          <dl>
                            <div><dt>criada em</dt><dd>{infoCreatedLabel}</dd></div>
                            <div><dt>membros</dt><dd>{infoMemberCount}</dd></div>
                            <div><dt>mensagens</dt><dd>{infoMessageCount}</dd></div>
                          </dl>
                        </div>
                      </div>
                      <div className="room-info-actions"><button type="button" className="room-info-ok" onClick={() => setRoomInfoOpen(false)}>OK</button></div>
                    </div>
                  </div>
                )}
                <div className="message-list" ref={messageListRef} onScroll={updateMessageListStickiness}>
                  {visibleMessages.length === 0 ? (isDirectChat ? <div className="empty-chat direct-empty-chat"><MessageCircle size={18} /><strong>Nenhuma mensagem ainda.</strong></div> : <div className="empty-chat"><MessageCircle size={18} /><strong>Nenhuma mensagem ainda.</strong><span>Seja a primeira pessoa a escrever nesta sala.</span></div>) : visibleMessages.map((message, index) => {
                    const previousMessage = visibleMessages[index - 1];
                    const currentSender = message.senderId || message.senderName;
                    const previousSender = previousMessage?.senderId || previousMessage?.senderName;
                    const senderChanged = index > 0 && currentSender !== previousSender;

                    if (message.kind === 'system') {
                      return (
                        <article className="message message-system" key={message.id} role="status">
                          <span className="message-system-prefix">[SYS]</span>
                          <div className="message-content">
                            <p>{message.text}</p>
                            <time>{message.time}</time>
                          </div>
                        </article>
                      );
                    }

                    return (
                      <article className={`message${senderChanged ? ' is-sender-change' : ''}`} key={message.id}>
                        <Avatar initials={message.initials} tone={message.tone} size="md" src={message.avatar} alt={message.senderName} />
                        <div className="message-content"><div className="message-meta"><strong>{message.senderName}</strong><time>{message.time}</time></div>{message.text && <p>{message.text}</p>}{(message.image || message.attachment) && <MessageAttachment message={message} />}</div>
                      </article>
                    );
                  })}
                </div>
                <input ref={imageInputRef} className="hidden-file-input" type="file" accept="*/*" onChange={handleAttachmentFile} />
                <form className="message-composer" onSubmit={sendMessage}><button type="button" className="composer-add" aria-label="Enviar arquivo" title="Enviar arquivo" disabled={!hasActiveRoom && !isDirectChat} onClick={() => imageInputRef.current?.click()}><Paperclip size={18} /></button><span className="composer-prompt" aria-hidden="true">$</span><div className="composer-input-shell"><input ref={composerInputRef} value={draft} disabled={!hasActiveRoom && !isDirectChat} onChange={(event) => { setDraft(event.target.value); window.requestAnimationFrame(updateComposerCursor); }} onSelect={updateComposerCursor} onClick={updateComposerCursor} onKeyUp={updateComposerCursor} placeholder={isDirectChat ? `escreva para ${directPeer.name}` : hasActiveRoom ? 'escreva para esta sala' : 'crie ou selecione uma sala'} /> <span className="composer-cursor" aria-hidden="true" style={{ left: `${composerCursorLeft}px` }} /></div><button type="submit" className="composer-send" aria-label="Enviar mensagem" disabled={!hasActiveRoom && !isDirectChat}><WinIcon name="send" size={25} /></button></form>
              </section>}
            </div>

          </div>
        </div>
      </main>

      {updateDialogOpen && (
        <div className="update-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setUpdateDialogOpen(false);
        }}>
          <section className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="update-titlebar">
              <div className="update-titlebar-label"><img className="room-info-titlebar-icon" src={winAppIcon} alt="" aria-hidden="true" draggable="false" /><strong id="update-dialog-title">JUMP — atualização</strong></div>
              <button type="button" className="win98-close-control" aria-label="Fechar atualização" onClick={() => setUpdateDialogOpen(false)}>×</button>
            </div>
            <div className={`update-body ${updateBusy ? 'is-busy' : ''}`}>
              <div className="update-search-visual" aria-hidden="true">
                <WinIcon name="update" size={44} />
                {updateBusy && <span className="update-search-dots"><i /><i /><i /></span>}
              </div>
              <strong className="update-heading">{updateDialogHeading}</strong>
              <small className="update-message">{updateDialogMessage}</small>
              {updateBusy && <div className="update-progress" role="progressbar" aria-label="Progresso da atualização" aria-valuemin="0" aria-valuemax="100" aria-valuenow={updateState.status === 'downloading' ? updateProgress : undefined}><span style={{ width: `${updateProgress}%` }} /></div>}
            </div>
            <div className="update-actions">
              {updateState.status === 'available' && <button type="button" className="dialog-primary" onClick={handleUpdate}>baixar</button>}
              {updateState.status === 'downloaded' && <button type="button" className="dialog-primary" onClick={handleUpdate}>reiniciar e atualizar</button>}
              {updateState.status === 'error' && <button type="button" className="dialog-primary" onClick={handleUpdate}>tentar novamente</button>}
              <button type="button" className="dialog-secondary" onClick={() => setUpdateDialogOpen(false)}>{updateBusy ? 'ocultar' : 'OK'}</button>
            </div>
          </section>
        </div>
      )}

      {screenSharePickerOpen && <ScreenShareDialog
        appIcon={winAppIcon}
        sources={screenShareSources}
        loading={screenShareSourcesLoading}
        mediaCapabilities={screenShareMediaCapabilities}
        tab={screenShareTab}
        onTabChange={setScreenShareTab}
        videoSource={screenShareVideoSource}
        audioSource={screenShareAudioSource}
        onVideoSource={chooseScreenShareVideo}
        onAudioSource={setScreenShareAudioSource}
        includeAudio={screenShareIncludesAudio}
        onIncludeAudio={changeScreenShareAudio}
        syncAudio={screenShareAudioSync}
        onSyncAudio={changeScreenShareAudioSync}
        profileId={screenShareProfileId}
        onProfile={updateScreenShareProfile}
        onConfirm={startScreenShare}
        onCancel={cancelScreenSharePicker}
      />}

      {profileSettingsOpen && (
        <div className="profile-settings-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setProfileSettingsOpen(false); }}>
          <form className="profile-settings-dialog" onSubmit={saveProfile} role="dialog" aria-modal="true" aria-labelledby="profile-settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="profile-settings-titlebar">
              <div className="profile-settings-titlebar-label"><img className="room-info-titlebar-icon" src={winAppIcon} alt="" aria-hidden="true" draggable="false" /><strong id="profile-settings-title">JUMP — configurações do perfil</strong></div>
              <button type="button" className="win98-close-control" aria-label="Fechar configurações do perfil" onClick={() => setProfileSettingsOpen(false)}>×</button>
            </div>
            <div className="profile-settings-body">
              <input ref={profilePhotoInputRef} className="hidden-file-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleProfilePhoto} />
              <div className="profile-settings-preview">
                <button type="button" className="profile-settings-avatar-button" onClick={() => profilePhotoInputRef.current?.click()} aria-label="Mudar imagem do perfil">
                  <Avatar initials={initialsFor(displayName)} tone="yellow" size="lg" src={profileAvatar} alt={displayName} presence={profileStatus} />
                </button>
                <div><strong>{displayName}</strong><small>identidade deste computador</small><button type="button" className="profile-change-photo" onClick={() => profilePhotoInputRef.current?.click()}><Camera size={13} /> mudar imagem</button></div>
              </div>
              <label className="profile-settings-field"><span>nome</span><input autoFocus value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} maxLength={32} aria-label="Nome do perfil" /></label>
              <fieldset className="profile-status-fieldset">
                <legend>status</legend>
                <div className="profile-status-options" role="radiogroup" aria-label="Status do perfil">
                  {[
                    ['online', 'online'],
                    ['dnd', 'não perturbe'],
                    ['offline', 'offline'],
                  ].map(([value, label]) => (
                    <button type="button" key={value} className={`profile-status-option ${profileStatus === value ? 'is-selected' : ''}`} aria-pressed={profileStatus === value} onClick={() => updateProfileStatus(value)}>
                      <PresenceIcon status={value} size={19} /><strong>{label}</strong>
                    </button>
                  ))}
                </div>
              </fieldset>
            </div>
            <div className="profile-settings-actions"><button type="button" className="dialog-secondary" onClick={() => setProfileSettingsOpen(false)}>cancelar</button><button type="submit" className="dialog-primary"><Check size={14} /> salvar</button></div>
          </form>
        </div>
      )}

      {roomAccess && (
        <div className="room-dialog-backdrop" role="presentation">
          <form className="room-dialog" onSubmit={submitRoomAccess} role="dialog" aria-modal="true" aria-labelledby="room-dialog-title">
            <button type="button" className="room-dialog-close win98-close-control" onClick={() => { setRoomAccess(null); setPermissionError(''); }} aria-label="Fechar"><X size={16} /></button>
            <span className="card-kicker">acesso à sala</span>
            <h2 id="room-dialog-title">{roomAccess.name}</h2>
            <p>Esta sala é protegida. Digite a senha uma vez; ela será lembrada neste dispositivo.</p>
            <label className="room-dialog-field"><span>senha</span><input autoFocus type="password" value={roomAccess.password} onChange={(event) => setRoomAccess((current) => current ? { ...current, password: event.target.value } : current)} placeholder="senha da sala" /></label>
            <div className="room-dialog-actions"><button type="button" className="dialog-secondary" onClick={() => { setRoomAccess(null); setPermissionError(''); }}>cancelar</button><button type="submit" className="dialog-primary"><LockKeyhole size={14} /> entrar</button></div>
          </form>
        </div>
      )}
      </div>
    </>
  );
}

const rootElement = document.getElementById('root');
const jumpRoot = rootElement.__jumpRoot || createRoot(rootElement);
rootElement.__jumpRoot = jumpRoot;
jumpRoot.render(<App />);

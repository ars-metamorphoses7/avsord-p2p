const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const FRAME_BYTES = (SAMPLE_RATE / 50) * CHANNELS * BYTES_PER_SAMPLE;
const MAX_STREAM_BUFFER_BYTES = FRAME_BYTES * 50;
const STREAM_REFRESH_MS = 1_000;
const STARTUP_GRACE_MS = 120;

function stringProperty(properties, ...keys) {
  for (const key of keys) {
    const value = properties?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeAudioStream(entry, properties = {}) {
  const index = Number(entry?.index ?? entry?.id ?? properties['object.serial']);
  const objectId = Number(properties['object.id'] ?? entry?.id);
  const target = String(properties['object.id'] ?? properties['object.serial'] ?? entry?.id ?? entry?.index ?? '').trim();
  if (!target && !Number.isFinite(index)) return null;
  return {
    id: Number.isFinite(index) ? index : objectId,
    pulseIndex: Number.isFinite(Number(entry?.index)) ? Number(entry.index) : null,
    target,
    processId: Number(stringProperty(properties, 'application.process.id')) || 0,
    processBinary: stringProperty(properties, 'application.process.binary'),
    applicationName: stringProperty(properties, 'application.name'),
    mediaName: stringProperty(properties, 'media.name'),
    nodeName: stringProperty(properties, 'node.name'),
    nodeDescription: stringProperty(properties, 'node.description'),
  };
}

function parsePulseAudioStreams(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => normalizeAudioStream(entry, entry?.properties || {})).filter(Boolean);
}

function parsePipeWireStreams(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => String(entry?.type || '').includes('Node'))
    .map((entry) => {
      const properties = entry?.info?.props || entry?.props || {};
      return String(properties['media.class'] || '') === 'Stream/Output/Audio'
        ? normalizeAudioStream({ id: entry.id }, properties)
        : null;
    })
    .filter(Boolean);
}

async function listLinuxAudioStreams() {
  try {
    const { stdout } = await execFileAsync('pactl', ['--format=json', 'list', 'sink-inputs'], {
      timeout: 2_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const streams = parsePulseAudioStreams(JSON.parse(stdout || '[]'));
    if (streams.length) return streams;
  } catch {
    // Fall through to native PipeWire discovery for systems without
    // pipewire-pulse/pactl.
  }
  try {
    const { stdout } = await execFileAsync('pw-dump', [], {
      timeout: 3_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parsePipeWireStreams(JSON.parse(stdout || '[]'));
  } catch {
    return [];
  }
}

function isJumpAudioStream(stream, selfPid = process.pid) {
  const names = [stream?.applicationName, stream?.nodeName, stream?.processBinary]
    .map(normalizeName)
    .filter(Boolean);
  return Number(stream?.processId) === Number(selfPid)
    || names.some((name) => name === 'jump' || name === 'jumpp2p' || name.includes('jumpnetwork'));
}

function linuxAudioStreamKey(stream) {
  return String(stream?.pulseIndex || stream?.target || stream?.id || '');
}

function linuxAudioCommands(stream) {
  const pulseIndex = Number(stream?.pulseIndex);
  const target = String(stream?.target || '').trim();
  const commands = [];
  if (Number.isFinite(pulseIndex) && pulseIndex > 0) {
    commands.push({
      command: 'parec',
      args: [
        '--raw',
        '--format=s16le',
        `--rate=${SAMPLE_RATE}`,
        `--channels=${CHANNELS}`,
        `--monitor-stream=${pulseIndex}`,
        '--latency-msec=40',
        '--client-name=JUMP audio bridge',
        '--stream-name=JUMP selected audio',
      ],
    });
  }
  if (target) {
    commands.push({
      command: 'pw-record',
      args: [
        '--format=s16',
        `--rate=${SAMPLE_RATE}`,
        `--channels=${CHANNELS}`,
        '--media-category=Capture',
        `--target=${target}`,
        '-',
      ],
    });
  }
  return commands;
}

function captureError(command, code, signal, stderr) {
  const details = String(stderr || '').trim();
  const reason = details || (signal ? `sinal ${signal}` : `código ${code}`);
  return new Error(`${command} não conseguiu capturar o áudio (${reason}).`);
}

function spawnLinuxAudioCapture(command, args, onChunk) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    let settled = false;
    let stopped = false;
    let startupTimer = null;

    const cleanupStartupTimer = () => {
      if (startupTimer) clearTimeout(startupTimer);
      startupTimer = null;
    };

    const fail = (error) => {
      cleanupStartupTimer();
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* Process may already have exited. */ }
      reject(error);
    };

    child.once('error', (error) => fail(error));
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
    });
    child.stdout?.on('data', (chunk) => {
      if (!stopped) onChunk(chunk);
    });
    child.once('close', (code, signal) => {
      if (!settled) fail(captureError(command, code, signal, stderr));
    });
    child.once('spawn', () => {
      startupTimer = setTimeout(() => {
        startupTimer = null;
        if (child.exitCode !== null || child.signalCode) {
          fail(captureError(command, child.exitCode, child.signalCode, stderr));
          return;
        }
        settled = true;
        resolve({
          stop() {
            if (stopped) return;
            stopped = true;
            cleanupStartupTimer();
            try { child.kill('SIGTERM'); } catch { /* Process may already have exited. */ }
          },
        });
      }, STARTUP_GRACE_MS);
    });
  });
}

class LinuxPcmMixer {
  constructor(onChunk) {
    this.onChunk = onChunk;
    this.entries = new Map();
    this.stopped = false;
    this.refreshTimer = null;
    this.tickTimer = setInterval(() => this.tick(), 20);
  }

  streamKey(stream) {
    return linuxAudioStreamKey(stream);
  }

  async addStream(stream) {
    const key = this.streamKey(stream);
    if (!key || this.stopped || this.entries.has(key)) return;
    const entry = { key, stream, buffer: Buffer.alloc(0), capture: null };
    this.entries.set(key, entry);
    try {
      entry.capture = await startLinuxStreamCapture(stream, (chunk) => this.append(entry, chunk));
      if (this.stopped) entry.capture.stop();
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }

  removeStream(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.capture?.stop?.();
    this.entries.delete(key);
  }

  append(entry, chunk) {
    if (this.stopped || !this.entries.has(entry.key)) return;
    const incoming = Buffer.from(chunk || []);
    if (!incoming.length) return;
    const combined = entry.buffer.length ? Buffer.concat([entry.buffer, incoming]) : incoming;
    const maxBytes = MAX_STREAM_BUFFER_BYTES + (combined.length % (BYTES_PER_SAMPLE * CHANNELS));
    entry.buffer = combined.length > maxBytes ? combined.subarray(combined.length - maxBytes) : combined;
  }

  tick() {
    if (this.stopped) return;
    const mixed = Buffer.alloc(FRAME_BYTES);
    for (const entry of this.entries.values()) {
      const completeBytes = Math.min(FRAME_BYTES, entry.buffer.length - (entry.buffer.length % (BYTES_PER_SAMPLE * CHANNELS)));
      if (completeBytes <= 0) continue;
      const chunk = entry.buffer.subarray(0, completeBytes);
      entry.buffer = entry.buffer.subarray(completeBytes);
      for (let offset = 0; offset < completeBytes; offset += BYTES_PER_SAMPLE) {
        const sum = mixed.readInt16LE(offset) + chunk.readInt16LE(offset);
        mixed.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), offset);
      }
    }
    this.onChunk(mixed);
  }

  async refresh(selectStreams) {
    if (this.stopped) return;
    const streams = await listLinuxAudioStreams();
    const selected = streams.filter(selectStreams);
    const wanted = new Map(selected.map((stream) => [this.streamKey(stream), stream]));
    for (const key of this.entries.keys()) {
      if (!wanted.has(key)) this.removeStream(key);
    }
    const errors = [];
    await Promise.all([...wanted.entries()].map(async ([key, stream]) => {
      if (this.entries.has(key)) return;
      try {
        await this.addStream(stream);
      } catch (error) {
        errors.push(error);
      }
    }));
    return errors;
  }

  startRefresh(selectStreams) {
    this.refreshTimer = setInterval(() => {
      void this.refresh(selectStreams);
    }, STREAM_REFRESH_MS);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    clearInterval(this.tickTimer);
    for (const entry of this.entries.values()) entry.capture?.stop?.();
    this.entries.clear();
  }
}

async function startLinuxStreamCapture(stream, onChunk) {
  let lastError = null;
  for (const { command, args } of linuxAudioCommands(stream)) {
    try {
      return await spawnLinuxAudioCapture(command, args, onChunk);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('A fonte de áudio Linux não está disponível.');
}

async function startLinuxSystemAudio(onChunk, target = {}) {
  const streams = await listLinuxAudioStreams();
  const requestedStreamId = String(target.audioStreamId || target.audioTarget || '').trim();
  const requestedProcessId = Number(target.processId) || 0;
  const systemAudio = target.systemAudio !== false;
  const selectStreams = systemAudio
    ? (stream) => !isJumpAudioStream(stream)
    : (stream) => !isJumpAudioStream(stream)
      && ((requestedStreamId && (String(stream.pulseIndex || '') === requestedStreamId || stream.target === requestedStreamId))
        || (requestedProcessId > 0 && stream.processId === requestedProcessId));
  const selected = streams.filter(selectStreams);
  if (!systemAudio && !selected.length) {
    throw new Error('A janela selecionada não possui áudio ativo no Linux. Reproduza algum áudio e tente novamente.');
  }
  const mixer = new LinuxPcmMixer(onChunk);
  try {
    const initialErrors = [];
    await Promise.all(selected.map(async (stream) => {
      try {
        await mixer.addStream(stream);
      } catch (error) {
        initialErrors.push(error);
      }
    }));
    if (selected.length && mixer.entries.size === 0) {
      mixer.stop();
      const detail = initialErrors[0]?.message || '';
      throw new Error(`Não foi possível capturar o áudio do sistema no Linux. Instale/ative PulseAudio ou PipeWire.${detail ? ` ${detail}` : ''}`);
    }
    mixer.startRefresh(selectStreams);
    return mixer;
  } catch (error) {
    mixer.stop();
    throw error;
  }
}

module.exports = {
  isJumpAudioStream,
  linuxAudioStreamKey,
  linuxAudioCommands,
  listLinuxAudioStreams,
  parsePipeWireStreams,
  parsePulseAudioStreams,
  startLinuxSystemAudio,
};

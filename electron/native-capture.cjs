const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Windows-only native screen capture. Chromium's desktop capturer blocks on the
// GPU for each frame and then idles as long again (50% CPU budget), so a game
// that keeps the GPU busy at 60-100 FPS was streamed at half its frame rate.
// native/capture/jump-capture.exe captures with Windows.Graphics.Capture into
// shared GPU textures; each finished frame is imported here with the
// `sharedTexture` API and forwarded to the renderer that asked for it, where it
// feeds a MediaStreamTrackGenerator (see src/media/nativeScreenCapture.js).
const READY_TIMEOUT_MS = 5_000;
const MAX_FRAMES_IN_FLIGHT = 3;
const MAX_FAILED_SENDS = 30;
const STATS_INTERVAL_MS = 10_000;

function parseCaptureLine(line) {
  const [type, ...fields] = String(line || '').trim().split(/\s+/);
  const numbers = fields.map(Number);
  if (type === 'TEX' && fields.length === 5) {
    return { type, generation: numbers[0], slot: numbers[1], handle: fields[2], width: numbers[3], height: numbers[4] };
  }
  if (type === 'FRAME' && fields.length === 3) return { type, generation: numbers[0], slot: numbers[1], timestampUs: numbers[2] };
  if (type === 'READY' && fields.length === 2) return { type, width: numbers[0], height: numbers[1] };
  if (type === 'ENDED' || type === 'ERROR') return { type, reason: fields.join(' ') || type.toLowerCase() };
  return null;
}

/** Helper arguments that select the source picked in the share dialog. */
function captureTargetArgs(sourceId, displayId, screenApi) {
  const window = /^window:(\d+):/.exec(String(sourceId || ''));
  if (window) return ['--window', window[1]];
  if (!/^screen:/.test(String(sourceId || ''))) return null;
  const display = screenApi?.getAllDisplays?.().find((candidate) => String(candidate.id) === String(displayId));
  if (display && typeof screenApi.dipToScreenPoint === 'function') {
    const center = screenApi.dipToScreenPoint({
      x: Math.round(display.bounds.x + display.bounds.width / 2),
      y: Math.round(display.bounds.y + display.bounds.height / 2),
    });
    return ['--monitor-point', `${Math.round(center.x)},${Math.round(center.y)}`];
  }
  const index = Number(/^screen:(\d+):/.exec(sourceId)?.[1]);
  return ['--monitor', String(Number.isInteger(index) ? index : 0)];
}

function nativeCaptureHelperPath(app, resourcesPath = process.resourcesPath) {
  return app.isPackaged
    ? path.join(resourcesPath, 'jump-capture.exe')
    : path.join(app.getAppPath(), 'native', 'bin', 'jump-capture.exe');
}

function handleBuffer(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function createNativeCapture({
  helperPath,
  sharedTexture,
  screenApi,
  platform = process.platform,
  pid = process.pid,
  spawnProcess = spawn,
  exists = fs.existsSync,
  disabled = false,
  log = (message) => console.info(`[native-capture] ${message}`),
} = {}) {
  let session = null;

  const available = () => !disabled && platform === 'win32' && Boolean(sharedTexture?.importSharedTexture) && exists(helperPath);

  function stop(reason = 'stopped') {
    const current = session;
    session = null;
    if (!current) return;
    current.stopped = true;
    try { current.child.stdin.write('STOP\n'); } catch { /* already gone */ }
    setTimeout(() => { if (current.child.exitCode === null) current.child.kill(); }, 1_000).unref?.();
    log(`parada (${reason})`);
  }

  function start({ sourceId, displayId = '', frame, onEnded = () => {} }) {
    stop('restart');
    if (!available()) return Promise.resolve({ ok: false, reason: 'unavailable' });
    const target = captureTargetArgs(sourceId, displayId, screenApi);
    if (!target || !frame) return Promise.resolve({ ok: false, reason: 'unsupported-source' });

    const child = spawnProcess(helperPath, ['--pid', String(pid), '--fps', '60', ...target], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const current = { child, stopped: false, textures: new Map(), inFlight: 0, failedSends: 0, frames: 0, skipped: 0 };
    session = current;

    return new Promise((resolve) => {
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        if (!result.ok && session === current) stop(result.reason);
        resolve(result);
      };
      const readyTimer = setTimeout(() => settle({ ok: false, reason: 'timeout' }), READY_TIMEOUT_MS);
      const statsTimer = setInterval(() => {
        if (current.stopped) { clearInterval(statsTimer); return; }
        log(`${(current.frames / (STATS_INTERVAL_MS / 1000)).toFixed(1)} fps enviados, ${current.skipped} descartados`);
        current.frames = 0;
        current.skipped = 0;
      }, STATS_INTERVAL_MS);
      statsTimer.unref?.();
      const end = (reason) => {
        if (current.stopped) return;
        if (session === current) stop(reason);
        onEnded(reason);
      };
      const release = (generation, slot) => {
        try { child.stdin.write(`REL ${generation} ${slot}\n`); } catch { /* exited */ }
      };

      const onFrame = ({ generation, slot, timestampUs }) => {
        const texture = current.textures.get(`${generation}:${slot}`);
        // The encoder is behind: return the slot instead of queueing frames.
        if (!texture || current.inFlight >= MAX_FRAMES_IN_FLIGHT) {
          current.skipped += 1;
          release(generation, slot);
          return;
        }
        let imported;
        try {
          imported = sharedTexture.importSharedTexture({
            textureInfo: {
              pixelFormat: 'bgra',
              codedSize: { width: texture.width, height: texture.height },
              visibleRect: { x: 0, y: 0, width: texture.width, height: texture.height },
              timestamp: timestampUs,
              handle: { ntHandle: texture.handle },
            },
            allReferencesReleased: () => release(generation, slot),
          });
        } catch (error) {
          release(generation, slot);
          end(`import: ${error?.message || error}`);
          return;
        }
        current.inFlight += 1;
        current.frames += 1;
        sharedTexture.sendSharedTexture({ frame, importedSharedTexture: imported })
          .then(() => { current.failedSends = 0; })
          .catch(() => {
            current.failedSends += 1;
            if (current.failedSends >= MAX_FAILED_SENDS) end('renderer-unreachable');
          })
          .finally(() => {
            current.inFlight -= 1;
            imported.release();
          });
      };

      let buffered = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffered += chunk;
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const message = parseCaptureLine(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          if (!message || current.stopped) continue;
          if (message.type === 'TEX') {
            current.textures.set(`${message.generation}:${message.slot}`, { handle: handleBuffer(message.handle), width: message.width, height: message.height });
          } else if (message.type === 'FRAME') {
            onFrame(message);
          } else if (message.type === 'READY') {
            log(`iniciada ${message.width}x${message.height} (${target.join(' ')})`);
            settle({ ok: true, width: message.width, height: message.height });
          } else if (message.type === 'ERROR') {
            log(`erro ${message.reason}`);
            if (settled) end(message.reason);
            else settle({ ok: false, reason: message.reason });
          } else if (message.type === 'ENDED') {
            end(message.reason);
          }
        }
      });
      child.on('error', (error) => settle({ ok: false, reason: `spawn: ${error.message}` }));
      child.on('exit', (code) => {
        if (!settled) settle({ ok: false, reason: `exit ${code}` });
        else end(`exit ${code}`);
      });
    });
  }

  return { available, start, stop, get active() { return Boolean(session); } };
}

function setupNativeCapture({ app, ipcMain, sharedTexture, screen }) {
  const capture = createNativeCapture({
    helperPath: nativeCaptureHelperPath(app),
    sharedTexture,
    screenApi: screen,
    disabled: String(process.env.JUMP_NATIVE_CAPTURE || '').trim() === '0',
  });
  ipcMain.handle('native-capture:start', (event, options = {}) => capture.start({
    sourceId: String(options.sourceId || ''),
    displayId: String(options.displayId || ''),
    frame: event.senderFrame,
    onEnded: (reason) => {
      if (!event.sender.isDestroyed()) event.sender.send('native-capture:ended', String(reason));
    },
  }));
  ipcMain.handle('native-capture:stop', () => capture.stop());
  app.on('will-quit', () => capture.stop('quit'));
  return capture;
}

module.exports = { captureTargetArgs, createNativeCapture, nativeCaptureHelperPath, parseCaptureLine, setupNativeCapture };

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  isJumpAudioStream,
  listLinuxAudioStreams,
  startLinuxSystemAudio,
} = require('./linux-system-audio.cjs');

const execFileAsync = promisify(execFile);

async function visibleWindowProcesses() {
  if (process.platform === 'linux') return visibleLinuxWindowProcesses();
  if (process.platform !== 'win32') return [];
  const command = "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Id,ProcessName,MainWindowTitle,@{Name='MainWindowHandle';Expression={[string]$_.MainWindowHandle}} | ConvertTo-Json -Compress";
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((entry) => Number(entry?.Id) > 0);
  } catch {
    return [];
  }
}

function xpropStrings(value) {
  return [...String(value || '').matchAll(/"((?:\\.|[^"\\])*)"/g)]
    .map((match) => match[1].replace(/\\([\\"])/g, '$1'));
}

function xpropValue(output, property) {
  const line = String(output || '').split(/\r?\n/).find((entry) => entry.startsWith(`${property}(`));
  return line ? line.slice(line.indexOf('=') + 1).trim() : '';
}

async function visibleLinuxWindowProcesses() {
  try {
    const { stdout } = await execFileAsync('xprop', ['-root', '_NET_CLIENT_LIST_STACKING'], {
      timeout: 2_000,
      maxBuffer: 64 * 1024,
    });
    const handles = [...String(stdout || '').matchAll(/0x[0-9a-f]+/gi)].map((match) => match[0]);
    const entries = await Promise.all(handles.map(async (handle) => {
      try {
        const { stdout: properties } = await execFileAsync('xprop', ['-id', handle, '_NET_WM_PID', 'WM_CLASS', '_NET_WM_NAME', 'WM_NAME'], {
          timeout: 1_000,
          maxBuffer: 32 * 1024,
        });
        const pid = Number.parseInt(xpropValue(properties, '_NET_WM_PID'), 10);
        if (!(pid > 0)) return null;
        const classes = xpropStrings(xpropValue(properties, 'WM_CLASS'));
        const title = xpropStrings(xpropValue(properties, '_NET_WM_NAME'))[0]
          || xpropStrings(xpropValue(properties, 'WM_NAME'))[0]
          || '';
        return {
          Id: pid,
          ProcessName: classes[1] || classes[0] || '',
          MainWindowTitle: title,
          MainWindowHandle: handle,
        };
      } catch {
        return null;
      }
    }));
    return entries.filter(Boolean);
  } catch {
    // Wayland sessions may not expose X11 window metadata. The audio stream
    // name matching below still enables sources whose names match an app.
    return [];
  }
}

function windowHandleFromSourceId(sourceId) {
  const match = /^window:([^:]+):/.exec(String(sourceId || ''));
  return match?.[1] || '';
}

function windowHandleAliases(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const numeric = /^0x/i.test(raw) ? Number.parseInt(raw, 16) : Number.parseInt(raw, 10);
  if (!Number.isFinite(numeric)) return [raw];
  return [...new Set([raw, String(numeric), `0x${numeric.toString(16)}`])];
}

function addWindowProcessAliases(map, processInfo) {
  windowHandleAliases(processInfo?.MainWindowHandle).forEach((handle) => map.set(handle, processInfo));
}

function normalizedMatch(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function linuxAudioStreamForWindow(source, processInfo, audioStreams) {
  const processId = Number(processInfo?.Id) || 0;
  const byProcess = processId > 0
    ? audioStreams.find((stream) => stream.processId === processId && !isJumpAudioStream(stream))
    : null;
  if (byProcess) return byProcess;
  const sourceNames = [source?.name, processInfo?.ProcessName, processInfo?.MainWindowTitle]
    .map(normalizedMatch)
    .filter((name) => name.length >= 3);
  if (!sourceNames.length) return null;
  return audioStreams.find((stream) => {
    if (isJumpAudioStream(stream)) return false;
    const streamNames = [stream.applicationName, stream.nodeName, stream.processBinary, stream.mediaName, stream.nodeDescription]
      .map(normalizedMatch)
      .filter(Boolean);
    return sourceNames.some((sourceName) => streamNames.some((streamName) => (
      sourceName === streamName || sourceName.includes(streamName) || streamName.includes(sourceName)
    )));
  }) || null;
}

function stopTracksSafely(capture) {
  try { capture?.stop?.(); } catch { /* Capture may already be stopped. */ }
}

function setupDesktopMedia({ desktopCapturer, ipcMain, session }) {
  let processAudioCapture = null;
  let captureWebContents = null;
  let allowedProcessIds = new Set();

  const stopProcessAudio = () => {
    stopTracksSafely(processAudioCapture);
    processAudioCapture = null;
    captureWebContents = null;
  };

  const allowedPermissions = new Set(['media', 'display-capture']);
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => allowedPermissions.has(permission));
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(allowedPermissions.has(permission)));

  ipcMain.handle('desktop:sources', async () => {
    try {
      const [sources, processes, audioStreams] = await Promise.all([
        desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 180 },
          fetchWindowIcons: true,
        }),
        visibleWindowProcesses(),
        process.platform === 'linux' ? listLinuxAudioStreams() : Promise.resolve([]),
      ]);
      const byHandle = new Map();
      processes.forEach((entry) => addWindowProcessAliases(byHandle, entry));
      const byTitle = new Map(processes.map((entry) => [String(entry.MainWindowTitle || '').trim().toLowerCase(), entry]));
      const mapped = sources.map((source) => {
        const type = source.id.startsWith('window:') ? 'window' : 'screen';
        const processInfo = type === 'window'
          ? byHandle.get(windowHandleFromSourceId(source.id)) || byTitle.get(String(source.name || '').trim().toLowerCase())
          : null;
        const linuxAudioStream = process.platform === 'linux' && type === 'window'
          ? linuxAudioStreamForWindow(source, processInfo, audioStreams)
          : null;
        const audioProcessId = Number(linuxAudioStream?.processId || processInfo?.Id) || 0;
        const hasLinuxSystemAudio = process.platform === 'linux' && type === 'screen';
        const hasLinuxWindowAudio = process.platform === 'linux' && type === 'window' && Boolean(linuxAudioStream);
        return {
          id: source.id,
          name: source.name,
          type,
          displayId: source.display_id || '',
          thumbnail: source.thumbnail?.toDataURL?.() || '',
          appIcon: source.appIcon?.toDataURL?.() || '',
          processId: process.platform === 'linux' ? audioProcessId : Number(processInfo?.Id) || 0,
          processName: processInfo?.ProcessName || '',
          audioSupported: process.platform === 'win32'
            ? (type === 'screen' || Number(processInfo?.Id) > 0)
            : hasLinuxSystemAudio || hasLinuxWindowAudio,
          audioMode: hasLinuxSystemAudio ? 'system' : hasLinuxWindowAudio ? 'process' : '',
          audioStreamId: linuxAudioStream?.pulseIndex || linuxAudioStream?.target || 0,
          audioTarget: linuxAudioStream?.target || '',
          audioLabel: hasLinuxSystemAudio
            ? 'áudio do sistema (sem o JUMP)'
            : hasLinuxWindowAudio
              ? `áudio de ${linuxAudioStream.applicationName || processInfo?.ProcessName || 'este aplicativo'}`
              : '',
        };
      });
      allowedProcessIds = new Set(mapped.map((source) => source.processId).filter(Boolean));
      return mapped;
    } catch (error) {
      console.error('JUMP desktop sources failed:', error);
      return [];
    }
  });

  ipcMain.handle('desktop:audio-start', async (event, target = {}) => {
    stopProcessAudio();
    const processId = Number(target.processId) || 0;
    const systemAudio = target.type === 'screen' || target.systemAudio === true;
    if (process.platform !== 'win32' && process.platform !== 'linux') {
      return { ok: false, message: 'Captura de áudio da tela não está disponível nesta plataforma.' };
    }
    if (process.platform === 'win32' && !systemAudio && !allowedProcessIds.has(processId)) {
      return { ok: false, message: 'O aplicativo de áudio selecionado não está mais disponível.' };
    }
    captureWebContents = event.sender;
    const sendChunk = (chunk) => {
      if (!captureWebContents || captureWebContents.isDestroyed()) return;
      captureWebContents.send('desktop:audio-data', chunk);
    };
    try {
      if (process.platform === 'linux') {
        processAudioCapture = await startLinuxSystemAudio(sendChunk, {
          audioStreamId: target.audioStreamId || '',
          audioTarget: target.audioTarget || '',
          processId,
          systemAudio,
        });
        return { ok: true, mode: systemAudio ? 'system' : 'process', backend: 'pulseaudio-pipewire', processId };
      }
      // Loaded only on Windows so Linux packages never initialize a Windows
      // native binary. loopback-capture uses WASAPI process/system loopback.
      const { LoopbackCapture } = require('loopback-capture');
      processAudioCapture = new LoopbackCapture();
      if (systemAudio) processAudioCapture.startSystemAudio(sendChunk);
      else processAudioCapture.start(processId, true, sendChunk);
      return { ok: true, mode: systemAudio ? 'system' : 'process', processId };
    } catch (error) {
      stopProcessAudio();
      console.error('JUMP desktop audio capture failed:', error);
      return { ok: false, message: error?.message || 'Não foi possível capturar o áudio selecionado.' };
    }
  });
  ipcMain.handle('desktop:audio-stop', () => {
    stopProcessAudio();
    return { ok: true };
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      });
      const source = sources.find((candidate) => candidate.id.startsWith('screen:')) || sources[0];
      callback(source ? { video: source } : {});
    } catch (error) {
      console.error('JUMP screen capture failed:', error);
      callback({});
    }
  }, { useSystemPicker: true });

  return { stopProcessAudio };
}

module.exports = { setupDesktopMedia, visibleWindowProcesses, windowHandleFromSourceId };

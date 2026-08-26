const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { startLinuxSystemAudio } = require('./linux-system-audio.cjs');

const execFileAsync = promisify(execFile);

async function visibleWindowProcesses() {
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

function windowHandleFromSourceId(sourceId) {
  const match = /^window:([^:]+):/.exec(String(sourceId || ''));
  return match?.[1] || '';
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
      const [sources, processes] = await Promise.all([
        desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 180 },
          fetchWindowIcons: true,
        }),
        visibleWindowProcesses(),
      ]);
      const byHandle = new Map(processes.map((entry) => [String(entry.MainWindowHandle), entry]));
      const byTitle = new Map(processes.map((entry) => [String(entry.MainWindowTitle || '').trim().toLowerCase(), entry]));
      const mapped = sources.map((source) => {
        const type = source.id.startsWith('window:') ? 'window' : 'screen';
        const processInfo = type === 'window'
          ? byHandle.get(windowHandleFromSourceId(source.id)) || byTitle.get(String(source.name || '').trim().toLowerCase())
          : null;
        return {
          id: source.id,
          name: source.name,
          type,
          displayId: source.display_id || '',
          thumbnail: source.thumbnail?.toDataURL?.() || '',
          appIcon: source.appIcon?.toDataURL?.() || '',
          processId: Number(processInfo?.Id) || 0,
          processName: processInfo?.ProcessName || '',
          audioSupported: process.platform === 'win32'
            ? (type === 'screen' || Number(processInfo?.Id) > 0)
            : process.platform === 'linux' && type === 'screen',
          audioLabel: process.platform === 'linux' && type === 'screen'
            ? 'áudio do sistema (PulseAudio/PipeWire)'
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
    if (process.platform === 'linux' && !systemAudio) {
      return { ok: false, message: 'No Linux, selecione uma tela para transmitir o áudio do sistema.' };
    }
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
        processAudioCapture = await startLinuxSystemAudio(sendChunk);
        return { ok: true, mode: 'system', backend: 'pulseaudio-pipewire', processId: 0 };
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

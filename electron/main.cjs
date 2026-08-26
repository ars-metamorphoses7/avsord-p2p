const { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, session } = require('electron');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');
const { createRoomSessionStore, normalizeRoomId, normalizeSignalOrigin } = require('./room-session-store.cjs');
const { createUpdateController } = require('./update-controller.cjs');
const { setupDesktopMedia } = require('./desktop-media.cjs');

let mainWindow;
let signalingServer;
let desktopMedia;
let roomSessionStore;
let signalingPort = Number(process.env.PORT || 8787);
let pendingDeepLink = process.argv.find((argument) => argument.startsWith('jump://')) || '';
const hasSingleInstanceLock = app.requestSingleInstanceLock();

// A fullscreen game makes the call window invisible. Chromium normally lowers
// an invisible renderer's priority, which can starve desktop capture even when
// the network and hardware encoder still have capacity.
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Linux VA-API remains an unsupported/driver-dependent Chromium path. Keep it
// opt-in until the release matrix proves Intel and AMD configurations, and do
// not bypass the GPU blocklist or driver workarounds. The renderer still checks
// `video_encode` plus RTCStats before presenting the path as hardware-backed.
const requestedLinuxVideoAcceleration = String(
  process.env.JUMP_LINUX_VIDEO_ACCELERATION || '',
).trim().toLowerCase();
if (process.platform === 'linux' && requestedLinuxVideoAcceleration === 'vaapi') {
  const enabledFeatures = new Set(app.commandLine.getSwitchValue('enable-features')
    .split(',')
    .map((feature) => feature.trim())
    .filter(Boolean));
  enabledFeatures.add('AcceleratedVideoEncoder');
  app.commandLine.appendSwitch('enable-features', [...enabledFeatures].join(','));
}

// On Windows 11 24H2 Chromium M150 silently prefers WGC for whole-screen
// capture. A repeated external-source A/B on this runtime measured the DXGI
// Desktop Duplication path at 56.99 presented FPS versus 54.95 for WGC, with a
// tighter 18.3 ms versus 24.2 ms frame-interval p95. Keep WGC for individual
// windows (where it is the safe occlusion-independent capturer), but use DDA
// for an entire display. The environment escape hatch makes driver-specific
// regressions recoverable without a new build.
const requestedScreenCaptureBackend = String(process.env.JUMP_SCREEN_CAPTURE_BACKEND || '').trim().toLowerCase();
if (process.platform === 'win32' && requestedScreenCaptureBackend !== 'wgc') {
  const disabledFeatures = new Set(app.commandLine.getSwitchValue('disable-features')
    .split(',')
    .map((feature) => feature.trim())
    .filter(Boolean));
  disabledFeatures.add('AllowWgcScreenCapturer');
  app.commandLine.appendSwitch('disable-features', [...disabledFeatures].join(','));
}

function publishWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('window:state', { maximized: mainWindow.isMaximized() });
}

function setupWindowControls() {
  ipcMain.handle('window:state', () => ({ maximized: Boolean(mainWindow?.isMaximized()) }));
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return { maximized: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { maximized: mainWindow.isMaximized() };
  });
  ipcMain.on('window:close', () => mainWindow?.close());
}

function setupClipboard() {
  ipcMain.handle('clipboard:write-text', (_event, value) => {
    clipboard.writeText(String(value ?? ''));
    return { ok: true };
  });
}

function preferredNetworkAddress() {
  const addresses = Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => (entries || [])
    .filter((entry) => (entry.family === 'IPv4' || entry.family === 4) && !entry.internal)
    .map((entry) => ({ name, address: entry.address })));
  addresses.sort((a, b) => Number(/radmin|vpn/i.test(b.name)) - Number(/radmin|vpn/i.test(a.name)));
  return addresses[0]?.address || '127.0.0.1';
}

function parseDeepLink(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'jump:') return null;
    const rawSignal = parsed.searchParams.get('signal') || '';
    const signal = normalizeSignalOrigin(rawSignal);
    if (rawSignal && !signal) return null;
    return {
      room: normalizeRoomId(parsed.searchParams.get('room')),
      signal,
    };
  } catch {
    return null;
  }
}

async function openDeepLink(value) {
  const invite = parseDeepLink(value);
  if (!invite || !mainWindow) return;
  const query = new URLSearchParams({ room: invite.room });
  if (invite.signal) query.set('signal', invite.signal);
  await mainWindow.loadURL(`http://127.0.0.1:${signalingPort}/?${query.toString()}`);
}

function setupRoomSessionPersistence() {
  roomSessionStore = createRoomSessionStore({
    filePath: path.join(app.getPath('userData'), 'room-sessions.json'),
  });
  ipcMain.handle('room-session:remember', (_event, value) => roomSessionStore.remember(value));
  ipcMain.handle('room-session:forget', (_event, value) => roomSessionStore.forget(value));
  ipcMain.handle('room-session:list', () => roomSessionStore.listRecent());
}

function setupUpdater() {
  ipcMain.handle('invite:url', (_event, roomId, currentSignal = '') => {
    const signal = normalizeSignalOrigin(currentSignal) || `http://${preferredNetworkAddress()}:${signalingPort}`;
    return `jump://join?signal=${encodeURIComponent(signal)}&room=${encodeURIComponent(normalizeRoomId(roomId))}`;
  });

  autoUpdater.autoDownload = false;
  // A instalação é disparada pelo botão da interface. Isso evita que um
  // pacote Linux peça autenticação inesperadamente ao fechar o aplicativo.
  autoUpdater.autoInstallOnAppQuit = false;
  const controller = createUpdateController({
    autoUpdater,
    isPackaged: app.isPackaged,
    sendState: (state) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('update:state', state);
    },
  });
  ipcMain.handle('update:state', () => controller.getState());
  ipcMain.handle('update:check', () => controller.check());
  ipcMain.handle('update:download', () => controller.download());
  ipcMain.handle('update:install', () => controller.install());
}

function setupMediaDiagnostics() {
  ipcMain.handle('media:capabilities', async () => {
    const featureStatus = app.getGPUFeatureStatus();
    const videoEncode = featureStatus?.video_encode || 'unknown';
    const enabledStates = new Set(['enabled', 'enabled_on', 'enabled_force', 'enabled_force_on']);
    let gpu = null;
    try {
      const info = await app.getGPUInfo('basic');
      const active = info?.gpuDevice?.find((device) => device.active) || info?.gpuDevice?.[0];
      gpu = active ? { vendorId: active.vendorId, deviceId: active.deviceId } : null;
    } catch { /* GPU details are diagnostic-only. */ }
    return {
      hardwareAcceleration: app.isHardwareAccelerationEnabled(),
      hardwareVideoEncoding: enabledStates.has(videoEncode),
      videoEncode,
      gpu,
      linuxVideoAcceleration: {
        requested: requestedLinuxVideoAcceleration || 'off',
        acceleratedVideoEncoderRequested: process.platform === 'linux'
          && requestedLinuxVideoAcceleration === 'vaapi',
      },
    };
  });
}

async function startSignalingServer() {
  process.env.PORT ||= String(signalingPort);
  process.env.HOST ||= '0.0.0.0';
  // The packaged app is installed inside an asar archive, so room metadata
  // must live in Electron's writable per-user data directory.
  process.env.JUMP_DATA_DIR ||= app.getPath('userData');
  signalingPort = Number(process.env.PORT);
  const serverPath = path.join(app.getAppPath(), 'server.mjs');
  const module = await import(pathToFileURL(serverPath).href);
  signalingServer = module.server;
  if (!signalingServer.listening) {
    await new Promise((resolve) => signalingServer.once('listening', resolve));
  }
}

async function createWindow() {
  await startSignalingServer();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    icon: path.join(app.getAppPath(), 'src', 'assets', 'win98', 'jump-app-icon.png'),
    backgroundColor: '#030604',
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow.on('maximize', publishWindowState);
  mainWindow.on('unmaximize', publishWindowState);
  const explicitInvite = parseDeepLink(pendingDeepLink);
  const rememberedSession = explicitInvite ? null : roomSessionStore?.getActive();
  const initialSession = explicitInvite || (rememberedSession ? {
    room: rememberedSession.roomId,
    signal: rememberedSession.signal,
  } : null);
  const query = new URLSearchParams({ room: initialSession?.room || 'jump-house' });
  if (initialSession?.signal) query.set('signal', initialSession.signal);
  await mainWindow.loadURL(`http://127.0.0.1:${signalingPort}/?${query.toString()}`);
  pendingDeepLink = '';
  mainWindow.on('closed', () => { mainWindow = null; });
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  if (process.platform === 'win32') {
    if (app.isPackaged) app.setAsDefaultProtocolClient('jump');
    else app.setAsDefaultProtocolClient('jump', process.execPath, [path.resolve(__dirname, '..')]);
  } else if (process.platform === 'linux' && app.isPackaged) {
    app.setAsDefaultProtocolClient('jump');
  }

  app.on('second-instance', (_event, commandLine) => {
    const deepLink = commandLine.find((argument) => argument.startsWith('jump://'));
    if (deepLink) {
      pendingDeepLink = deepLink;
      void openDeepLink(deepLink);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    pendingDeepLink = url;
    void openDeepLink(url);
  });

  app.whenReady().then(async () => {
    setupRoomSessionPersistence();
    setupUpdater();
    setupWindowControls();
    setupClipboard();
    setupMediaDiagnostics();
    desktopMedia = setupDesktopMedia({ desktopCapturer, ipcMain, session });
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((error) => {
    console.error('JUMP desktop failed to start:', error);
    app.quit();
  });

  app.on('before-quit', () => {
    desktopMedia?.stopProcessAudio();
    signalingServer?.close();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

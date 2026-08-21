const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let signalingServer;
let signalingPort = Number(process.env.PORT || 8787);
let pendingDeepLink = process.argv.find((argument) => argument.startsWith('jump://')) || '';
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function publishUpdateState(state) {
  mainWindow?.webContents.send('update:state', state);
}

function setupMediaCapture() {
  const allowedPermissions = new Set(['media', 'display-capture']);
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => allowedPermissions.has(permission));
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(allowedPermissions.has(permission)));
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
    return {
      room: parsed.searchParams.get('room') || 'jump-house',
      signal: parsed.searchParams.get('signal') || '',
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

function setupUpdater() {
  ipcMain.handle('invite:url', (_event, roomId) => {
    const signal = `http://${preferredNetworkAddress()}:${signalingPort}`;
    return `jump://join?signal=${encodeURIComponent(signal)}&room=${encodeURIComponent(String(roomId || 'jump-house'))}`;
  });

  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) {
      publishUpdateState({ status: 'dev', message: 'Atualizações só funcionam no aplicativo empacotado.' });
      return { status: 'dev' };
    }
    try {
      await autoUpdater.checkForUpdates();
      return { status: 'checking' };
    } catch (error) {
      publishUpdateState({ status: 'error', message: error.message });
      return { status: 'error', message: error.message };
    }
  });

  ipcMain.handle('update:download', async () => {
    if (!app.isPackaged) return { status: 'dev' };
    try {
      await autoUpdater.downloadUpdate();
      return { status: 'downloading' };
    } catch (error) {
      publishUpdateState({ status: 'error', message: error.message });
      return { status: 'error', message: error.message };
    }
  });

  ipcMain.handle('update:install', () => {
    if (!app.isPackaged) return { status: 'dev' };
    autoUpdater.quitAndInstall(false, true);
    return { status: 'installing' };
  });

  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  // A instalação é disparada pelo botão da interface. Isso evita que um
  // pacote Linux peça autenticação inesperadamente ao fechar o aplicativo.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => publishUpdateState({ status: 'checking' }));
  autoUpdater.on('update-available', (_event, info) => publishUpdateState({ status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => publishUpdateState({ status: 'not-available' }));
  autoUpdater.on('download-progress', (progress) => publishUpdateState({ status: 'downloading', percent: Math.round(progress.percent) }));
  autoUpdater.on('update-downloaded', (_event, _releaseNotes, _releaseName, _releaseDate, updateUrl) => publishUpdateState({ status: 'downloaded', url: updateUrl }));
  autoUpdater.on('error', (error) => publishUpdateState({ status: 'error', message: error.message }));

}

async function startSignalingServer() {
  process.env.PORT ||= String(signalingPort);
  process.env.HOST ||= '0.0.0.0';
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
    backgroundColor: '#121116',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  const invite = parseDeepLink(pendingDeepLink);
  const query = new URLSearchParams({ room: invite?.room || 'jump-house' });
  if (invite?.signal) query.set('signal', invite.signal);
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
    setupUpdater();
    setupMediaCapture();
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((error) => {
    console.error('JUMP desktop failed to start:', error);
    app.quit();
  });

  app.on('before-quit', () => {
    signalingServer?.close();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

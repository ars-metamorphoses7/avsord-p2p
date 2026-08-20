const { app, BrowserWindow, ipcMain } = require('electron');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let signalingServer;
let signalingPort = Number(process.env.PORT || 8787);

function publishUpdateState(state) {
  mainWindow?.webContents.send('update:state', state);
}

function preferredNetworkAddress() {
  const addresses = Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => (entries || [])
    .filter((entry) => (entry.family === 'IPv4' || entry.family === 4) && !entry.internal)
    .map((entry) => ({ name, address: entry.address })));
  addresses.sort((a, b) => Number(/radmin|vpn/i.test(b.name)) - Number(/radmin|vpn/i.test(a.name)));
  return addresses[0]?.address || '127.0.0.1';
}

function setupUpdater() {
  ipcMain.handle('invite:url', (_event, roomId) => `http://${preferredNetworkAddress()}:${signalingPort}/?room=${encodeURIComponent(String(roomId || 'jump-house'))}`);

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
    autoUpdater.quitAndInstall();
    return { status: 'installing' };
  });

  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
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
  await mainWindow.loadURL(`http://127.0.0.1:${signalingPort}/?room=jump-house`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  setupUpdater();
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

// Stand-in for a game: a separate process (own GPU process) that renders a
// heavy WebGL scene fullscreen without vsync or frame-rate cap, and prints its
// own frame timing once per second as `GAME {...}` JSON lines on stdout.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.setPath('userData', path.join(app.getPath('temp'), `jump-game-load-${process.pid}`));

const load = Math.max(1, Math.min(4000, Number(process.env.GAME_LOAD) || 60));
const depth = process.env.GAME_DEPTH ?? '2';
const scene = process.env.GAME_SCENE || 'game';

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    fullscreen: true,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    webPreferences: { backgroundThrottling: false, contextIsolation: true },
  });
  window.setAlwaysOnTop(true, 'screen-saver');
  await window.loadFile(path.join(__dirname, 'index.html'), { query: { load: String(load), depth, scene } });
  setInterval(async () => {
    try {
      const stats = await window.webContents.executeJavaScript('globalThis.__game.take()');
      process.stdout.write(`GAME ${JSON.stringify({ t: Date.now(), ...stats })}\n`);
    } catch { /* window closing */ }
  }, 1000);
});

app.on('window-all-closed', () => app.quit());

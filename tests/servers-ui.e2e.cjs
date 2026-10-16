const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const port = 23000 + Math.floor(Math.random() * 1000);
const data = mkdtempSync(path.join(tmpdir(), 'jump-servers-test-'));
const windows = [];
let server;
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await wait(100); }
  throw new Error('Timed out');
}
const run = (w, code) => w.webContents.executeJavaScript(code);
const shot = async (w, name) => { await wait(400); w.webContents.invalidate(); await wait(200); writeFileSync(path.join(data, `${name}.png`), (await w.capturePage()).toPNG()); };
app.whenReady().then(async () => {
  // JUMP_LOCAL_ADMIN=0: both windows run on this PC, but only the room creator may manage it.
  server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), HOST: '127.0.0.1', JUMP_DATA_DIR: data, JUMP_LOCAL_ADMIN: '0' }, windowsHide: true, stdio: 'ignore' });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } });
  for (let i = 0; i < 2; i++) {
    const w = new BrowserWindow({ show: true, x: -3000, y: 0, width: 1440, height: 920, webPreferences: { partition: `servers-test-${i}`, backgroundThrottling: false } });
    windows.push(w);
    w.webContents.session.setPermissionRequestHandler((_a, _b, cb) => cb(true));
    await w.loadURL(`http://127.0.0.1:${port}/?room=dono-test`);
    await until(() => run(w, "!!document.querySelector('.room-name-heading')"));
    await wait(500);
  }
  const [a, b] = windows;
  assert(await run(a, "!!document.querySelector('.room-edit-button') && !!document.querySelector('.room-delete-button')"), 'owner sees manage buttons');
  assert(await run(b, "!document.querySelector('.room-edit-button') && !document.querySelector('.room-delete-button')"), 'guest has no manage buttons');

  await run(a, "document.querySelector('[aria-label=\"Informações da sala\"]').click()");
  await until(() => run(a, "!!document.querySelector('.room-transfer select')"));
  await shot(a, 'room-info-owner');
  await run(a, "window.confirm = () => true; (() => { const s = document.querySelector('.room-transfer select'); const v = s.options[1].value; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, v); s.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await until(() => run(b, "!!document.querySelector('.room-edit-button')"));
  await until(() => run(a, "!document.querySelector('.room-edit-button')"));

  await run(b, "document.querySelector('.call-header-button').click()");
  await until(() => run(b, "!!document.querySelector('.join-call-button')"));
  await run(b, "document.querySelector('.join-call-button').click()");
  await until(() => run(b, "!!document.querySelector('.leave-button')"));
  await wait(500);
  const deafenedBefore = await run(b, "document.querySelectorAll('.voice-member-mic.is-deafened').length");
  await run(b, "window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', ctrlKey: true, shiftKey: true, bubbles: true }))");
  await until(() => run(b, `document.querySelectorAll('.voice-member-mic.is-deafened').length > ${deafenedBefore}`));

  await run(b, "document.querySelector('[aria-label=\"Configurações\"]').click()");
  await until(() => run(b, "!!document.querySelector('#mute-bind-title')"));
  await shot(b, 'settings-binds');
  await run(b, "document.querySelector('[aria-label=\"Fechar configurações\"]').click()");

  await run(b, "document.querySelector('.servers-open-button').click()");
  await until(() => run(b, "!!document.querySelector('.servers-dialog')"));
  await until(() => run(b, "document.querySelector('.servers-list').textContent.includes('online')"));
  await shot(b, 'servers-dialog');

  const offline = new BrowserWindow({ show: true, x: -3000, y: 0, width: 1440, height: 920, webPreferences: { partition: 'servers-test-offline' } });
  windows.push(offline);
  await offline.loadURL(`http://127.0.0.1:${port}/?room=x&signal=${encodeURIComponent('http://127.0.0.1:9')}`);
  await until(() => run(offline, "!!document.querySelector('.notice-actions')"));
  await shot(offline, 'offline-notice');
  console.log(`PASS: ownership, transfer, deafen bind, servers dialog, offline notice. Screenshots: ${data}`);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
app.on('quit', () => server?.kill());

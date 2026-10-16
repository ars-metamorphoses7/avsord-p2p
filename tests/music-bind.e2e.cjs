const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const port = 22000 + Math.floor(Math.random() * 1000);
const data = mkdtempSync(path.join(tmpdir(), 'jump-music-test-'));
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
app.whenReady().then(async () => {
  server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), HOST: '127.0.0.1', JUMP_DATA_DIR: data }, windowsHide: true, stdio: 'ignore' });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } });
  for (let i = 0; i < 2; i++) {
    const w = new BrowserWindow({ show: false, width: 1440, height: 920, webPreferences: { partition: `music-test-${i}`, backgroundThrottling: false } });
    windows.push(w);
    w.webContents.session.setPermissionRequestHandler((_a, _b, cb) => cb(true));
    await w.loadURL(`http://127.0.0.1:${port}/?room=music-test`);
    await until(() => run(w, "!!document.querySelector('.call-header-button')"));
    await run(w, "if (!document.querySelector('.join-call-button')) document.querySelector('.call-header-button').click()");
    await until(() => run(w, "!!document.querySelector('.join-call-button')"));
    await run(w, "document.querySelector('.join-call-button').click()");
    await until(() => run(w, "!!document.querySelector('.music-bot')"));
  }
  const [a, b] = windows;
  await run(a, `(() => { const input = document.querySelector('#music-url'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://youtu.be/M7lc1UVf-VE'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await wait(100);
  await run(a, "document.querySelector('.music-bot form').requestSubmit()");
  await until(() => run(b, "document.querySelector('.music-bot').textContent.includes('1 vídeo(s) na fila')"));
  await until(() => run(b, "document.querySelector('.music-bot').dataset.playerState === '1'"));
  await until(() => run(a, "document.querySelector('.music-bot').dataset.playerState === '1'"));
  // A second participant can add to the same queue.
  await run(b, `(() => { const input = document.querySelector('#music-url'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://youtu.be/jNQXAC9IVRw'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await wait(100);
  await run(b, "document.querySelector('.music-bot form').requestSubmit()");
  await until(() => run(a, "document.querySelector('.music-bot').textContent.includes('2 vídeo(s) na fila') && document.querySelector('.music-queue').textContent.length > 0"));
  assert(await run(a, "!document.querySelector('.music-warning')"), 'both clients have the Jukebox');
  console.log('Queue on A:', await run(a, "document.querySelector('.music-bot p').textContent + ' | ' + document.querySelector('.music-queue').textContent"));
  await run(b, "[...document.querySelectorAll('.music-bot button')].find(b => b.textContent === 'Pausar').click()");
  await until(() => run(a, "document.querySelector('.music-titlebar').textContent.includes('Pausado')"));
  await run(a, "window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', ctrlKey: true, shiftKey: true, bubbles: true }))");
  await until(() => run(a, "!!document.querySelector('[aria-label=\"Ativar microfone\"]')"));
  await run(a, "window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', ctrlKey: true, shiftKey: true, repeat: true, bubbles: true }))");
  assert(await run(a, "!!document.querySelector('[aria-label=\"Ativar microfone\"]')"));
  await wait(4000);
  console.log('YouTube player:', await run(a, "({ iframe: !!document.querySelector('.music-player iframe'), alert: document.querySelector('.music-bot [role=alert]')?.textContent || '' })"));
  writeFileSync(path.join(data, 'jukebox.png'), (await a.capturePage()).toPNG());
  await run(a, "document.querySelector('[aria-label=\"Configurações\"]').click()");
  await until(() => run(a, "!!document.querySelector('#mute-bind-title')"));
  await run(a, "document.querySelector('.mute-bind-settings button').click()");
  await run(a, "window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F8', key: 'F8', bubbles: true }))");
  await until(() => run(a, "localStorage.getItem('jump-mute-bind') === 'F8' && document.querySelector('.mute-bind-settings button').textContent === 'F8'"));
  await wait(500);
  writeFileSync(path.join(data, 'settings.png'), (await a.capturePage()).toPNG());
  await run(a, "document.querySelector('[aria-label=\"Fechar configurações\"]').click(); document.querySelector('.leave-button').click()");
  await until(() => run(a, "!document.querySelector('.music-bot')"));
  await run(a, "if (!document.querySelector('.join-call-button')) document.querySelector('.call-header-button').click()");
  await until(() => run(a, "!!document.querySelector('.join-call-button')"));
  await run(a, "window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F8', key: 'F8', bubbles: true }))");
  await wait(200);
  assert(await run(a, "!!document.querySelector('.join-call-button')"), 'bind must not join a call');
  console.log(`PASS: two-participant queue/pause, mute bind/repeat, settings, call cleanup. Screenshots: ${data}`);
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  windows.forEach(w => w.destroy()); server?.kill(); app.exit(process.exitCode || 0);
});

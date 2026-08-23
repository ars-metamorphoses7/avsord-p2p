const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const port = 18_000 + Math.floor(Math.random() * 1_000);
const room = `mesh-e2e-${Date.now()}`;
let signalingProcess;
const windows = [];

app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('auto-select-desktop-capture-source', 'Entire screen');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(100);
  }
  throw new Error(`Timeout esperando: ${label}`);
}

async function startServer() {
  signalingProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: projectRoot,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let serverError = '';
  signalingProcess.stderr.on('data', (chunk) => { serverError += chunk.toString(); });
  await waitFor(async () => {
    if (signalingProcess.exitCode !== null) throw new Error(serverError || `Servidor encerrou com ${signalingProcess.exitCode}`);
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      return false;
    }
  }, 'servidor de sinalização');
}

async function stopServer() {
  const processToStop = signalingProcess;
  signalingProcess = null;
  if (!processToStop || processToStop.exitCode !== null) return;
  const exited = new Promise((resolve) => processToStop.once('exit', resolve));
  processToStop.kill();
  await Promise.race([exited, wait(3_000)]);
}

async function createParticipant(index) {
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 760,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      partition: `mesh-e2e-${index}`,
      preload: path.join(projectRoot, 'electron', 'preload.cjs'),
    },
  });
  window.webContents.session.setPermissionCheckHandler(() => true);
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(true));
  windows.push(window);
  await window.loadURL(`http://127.0.0.1:${port}/?room=${room}&meshDebug=1`);
  return window;
}

async function click(window, selector) {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Elemento ausente: ${selector}`);
}

async function count(window, selector) {
  return window.webContents.executeJavaScript(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
}

async function inboundRtpCount(window, kind) {
  return window.webContents.executeJavaScript(`(async () => {
    const peers = [...(globalThis.__jumpPeerMesh?.peerConnectionsRef.current || [])];
    let flowing = 0;
    for (const [, slot] of peers) {
      const stats = await slot.pc.getStats();
      const hasInbound = [...stats.values()].some((report) => report.type === 'inbound-rtp'
        && report.kind === ${JSON.stringify(kind)}
        && !report.isRemote
        && Number(report.bytesReceived) > 0);
      if (hasInbound) flowing += 1;
    }
    return flowing;
  })()`);
}

async function run() {
  await app.whenReady();
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(true));
  ipcMain.handle('window:state', () => ({ maximized: false }));
  ipcMain.handle('update:state', () => ({ status: 'dev', revision: 0 }));
  ipcMain.handle('media:capabilities', () => ({ hardwareAcceleration: true, hardwareVideoEncoding: true, videoEncode: 'enabled' }));
  ipcMain.handle('desktop:sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      type: source.id.startsWith('window:') ? 'window' : 'screen',
      displayId: source.display_id || '',
      thumbnail: source.thumbnail?.toDataURL?.() || '',
      appIcon: source.appIcon?.toDataURL?.() || '',
      processId: source.id.startsWith('window:') ? process.pid : 0,
      processName: source.id.startsWith('window:') ? 'electron' : '',
      audioSupported: true,
    }));
  });
  await startServer();

  for (let index = 0; index < 3; index += 1) await createParticipant(index);
  await waitFor(() => Promise.all(windows.map((window) => count(window, '.signal-badge.is-connected'))).then((values) => values.every(Boolean)), 'três clientes sinalizados');
  await waitFor(() => Promise.all(windows.map((window) => window.webContents.executeJavaScript("document.querySelector('.signal-badge')?.textContent.includes('3 conectados')"))).then((values) => values.every(Boolean)), 'sala com três participantes');

  for (const window of windows) {
    await click(window, 'button[aria-label="Abrir chamada"]');
    await click(window, '.join-call-button');
  }
  await waitFor(() => Promise.all(windows.map((window) => count(window, '.leave-button'))).then((values) => values.every(Boolean)), 'todos dentro da chamada');
  await waitFor(() => Promise.all(windows.map((window) => count(window, '.call-stream-card'))).then((values) => values.every((value) => value === 3)), 'malha de áudio com três participantes', 20_000);
  try {
    await waitFor(() => Promise.all(windows.map((window) => count(window, '.call-stream-card audio'))).then((values) => values.every((value) => value === 2)), 'duas faixas remotas de áudio por participante', 20_000);
  } catch (error) {
    const diagnostics = await Promise.all(windows.map((window) => window.webContents.executeJavaScript(`(() => ({
      audioElements: document.querySelectorAll('.call-stream-card audio').length,
      notice: document.querySelector('.notice-bar')?.textContent || '',
      peers: [...(globalThis.__jumpPeerMesh?.peerConnectionsRef.current || [])].map(([peerId, slot]) => ({
        peerId,
        connectionState: slot.pc.connectionState,
        iceConnectionState: slot.pc.iceConnectionState,
        signalingState: slot.pc.signalingState,
        audioSender: Boolean(slot.audioSender.track),
        audioReceiver: {
          muted: slot.pc.getReceivers().find((receiver) => receiver.track?.kind === 'audio')?.track?.muted,
          readyState: slot.pc.getReceivers().find((receiver) => receiver.track?.kind === 'audio')?.track?.readyState,
        },
        localAudioMsid: /m=audio[\\s\\S]*?a=msid:/m.test(slot.pc.localDescription?.sdp || ''),
        remoteAudioMsid: /m=audio[\\s\\S]*?a=msid:/m.test(slot.pc.remoteDescription?.sdp || ''),
      })),
    }))()`)));
    process.stderr.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
    throw error;
  }
  await waitFor(() => Promise.all(windows.map((window) => inboundRtpCount(window, 'audio'))).then((values) => values.every((value) => value === 2)), 'RTP de áudio fluindo em todas as seis direções', 20_000);

  await click(windows[0], 'button[aria-label="Compartilhar tela"]');
  await waitFor(() => count(windows[0], '.screen-share-source'), 'seletor de tela do Electron', 20_000);
  if (await count(windows[0], '.screen-share-tabs button') !== 2) throw new Error('O seletor não exibiu as abas de vídeo e áudio.');
  if (await count(windows[0], '.screen-share-quality button') !== 3) throw new Error('O seletor não exibiu os três perfis de qualidade.');
  if (await count(windows[0], '.screen-share-audio-options input[type="checkbox"]') !== 2) throw new Error('O seletor não exibiu os controles de áudio e vínculo automático.');
  if (process.env.JUMP_UI_SCREENSHOT) {
    windows[0].showInactive();
    await wait(150);
    const image = await windows[0].capturePage();
    fs.writeFileSync(process.env.JUMP_UI_SCREENSHOT, image.toPNG());
    windows[0].hide();
  }
  await click(windows[0], '.screen-share-audio-options input[type="checkbox"]:first-of-type');
  await click(windows[0], '.screen-share-audio-options label:nth-of-type(2) input');
  await waitFor(() => windows[0].webContents.executeJavaScript("!document.querySelector('.screen-share-tabs button:nth-child(2)')?.disabled"), 'aba manual de áudio habilitada');
  await click(windows[0], '.screen-share-tabs button:nth-child(2)');
  await waitFor(() => count(windows[0], '.screen-share-source'), 'fontes manuais de áudio');
  await click(windows[0], '.screen-share-audio-options input[type="checkbox"]:first-of-type');
  await waitFor(() => windows[0].webContents.executeJavaScript("document.querySelector('.screen-share-tabs button:first-child')?.getAttribute('aria-selected') === 'true'"), 'retorno automático à aba de vídeo sem áudio');
  await click(windows[0], '.screen-share-source');
  await click(windows[0], '.screen-share-actions .dialog-primary');
  await waitFor(() => count(windows[0], 'button[aria-label="Parar compartilhamento"]'), 'compartilhamento local ativo', 20_000);
  await waitFor(() => Promise.all(windows.slice(1).map((window) => count(window, '.voice-member-mic.is-sharing'))).then((values) => values.every(Boolean)), 'compartilhamento anunciado aos peers', 20_000);
  await waitFor(() => Promise.all(windows.slice(1).map((window) => count(window, '.call-stream-card video'))).then((values) => values.every(Boolean)), 'faixa de tela recebida pelos peers', 20_000);
  await waitFor(() => Promise.all(windows.slice(1).map((window) => inboundRtpCount(window, 'video'))).then((values) => values.every((value) => value >= 1)), 'RTP da tela recebido pelos dois peers', 20_000);
  await waitFor(() => windows[0].webContents.executeJavaScript(`(() => [...globalThis.__jumpPeerMesh.peerConnectionsRef.current.values()].every((slot) => {
    const encoding = slot.videoSender?.getParameters?.().encodings?.[0];
    return Number(encoding?.maxBitrate) > 0 && Number(encoding?.maxFramerate) > 0;
  }))()`), 'perfil de bitrate e FPS aplicado aos remetentes', 20_000);

  // Recreate the signaling service to exercise the renderer's reconnect path.
  // Existing media tracks must be rebound to the peers' new socket identities.
  await stopServer();
  await startServer();
  await waitFor(() => Promise.all(windows.map((window) => window.webContents.executeJavaScript("document.querySelector('.signal-badge')?.textContent.includes('3 conectados')"))).then((values) => values.every(Boolean)), 'três participantes após reconexão', 20_000);
  try {
    await waitFor(() => Promise.all(windows.map((window) => count(window, '.call-stream-card .call-stream-media'))).then((values) => values.every((value) => value >= 2)), 'mídia remota refeita após reconexão', 20_000);
  } catch (error) {
    const reconnectDiagnostics = await Promise.all(windows.map((window) => window.webContents.executeJavaScript(`(() => ({
      cards: document.querySelectorAll('.call-stream-card').length,
      audioElements: document.querySelectorAll('.call-stream-card audio').length,
      callStates: document.querySelectorAll('.voice-member').length,
      streamPeerIds: [...(globalThis.__jumpPeerMesh?.remoteStreamsRef.current.keys() || [])],
      peerConnections: [...(globalThis.__jumpPeerMesh?.peerConnectionsRef.current || [])].map(([peerId, slot]) => ({
        peerId,
        connectionState: slot.pc.connectionState,
        signalingState: slot.pc.signalingState,
        audioSender: Boolean(slot.audioSender.track),
        direction: slot.audioTransceiver.direction,
        currentDirection: slot.audioTransceiver.currentDirection,
        localAudioMsid: /m=audio[\\s\\S]*?a=msid:/m.test(slot.pc.localDescription?.sdp || ''),
        remoteAudioMsid: /m=audio[\\s\\S]*?a=msid:/m.test(slot.pc.remoteDescription?.sdp || ''),
      })),
    }))()`)));
    process.stderr.write(`${JSON.stringify(reconnectDiagnostics, null, 2)}\n`);
    throw error;
  }
  await waitFor(() => Promise.all(windows.map((window) => inboundRtpCount(window, 'audio'))).then((values) => values.every((value) => value === 2)), 'RTP de áudio após reconexão', 20_000);
  await waitFor(() => Promise.all(windows.slice(1).map((window) => inboundRtpCount(window, 'video'))).then((values) => values.every((value) => value >= 1)), 'tela após reconexão', 20_000);

  process.stdout.write('OK: 3 participantes, RTP de áudio/tela e reconexão da malha validados.\n');
}

run().then(() => app.exit(0)).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
}).finally(() => {
  windows.forEach((window) => {
    if (!window.isDestroyed()) window.destroy();
  });
  signalingProcess?.kill();
});

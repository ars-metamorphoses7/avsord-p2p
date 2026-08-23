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
    width: 1440,
    height: 900,
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

async function captureDebug(window, suffix) {
  if (!process.env.JUMP_UI_SCREENSHOT) return;
  const parsed = path.parse(process.env.JUMP_UI_SCREENSHOT);
  const target = path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext || '.png'}`);
  window.showInactive();
  await wait(150);
  const image = await window.capturePage();
  fs.writeFileSync(target, image.toPNG());
  window.hide();
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
  ipcMain.handle('desktop:audio-start', () => ({ ok: true, mode: 'process', processId: process.pid }));
  ipcMain.handle('desktop:audio-stop', () => ({ ok: true }));
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
  if (await count(windows[0], '.screen-share-quality button') !== 2) throw new Error('O seletor não exibiu somente desempenho e qualidade.');
  await windows[0].webContents.executeJavaScript(`(() => {
    const buttons = [...document.querySelectorAll('.screen-share-quality button')];
    const quality = buttons.find((button) => button.textContent.includes('qualidade'));
    quality?.click();
  })()`);
  await waitFor(() => windows[0].webContents.executeJavaScript("document.querySelector('.screen-share-quality button.is-selected')?.textContent.includes('qualidade')"), 'modo qualidade selecionável');
  await windows[0].webContents.executeJavaScript(`(() => {
    const buttons = [...document.querySelectorAll('.screen-share-quality button')];
    const performance = buttons.find((button) => button.textContent.includes('desempenho'));
    performance?.click();
  })()`);
  await waitFor(() => windows[0].webContents.executeJavaScript("document.querySelector('.screen-share-quality button.is-selected')?.textContent.includes('desempenho')"), 'modo desempenho selecionável');
  if (await count(windows[0], '.screen-share-audio-options input[type="checkbox"]') !== 2) throw new Error('O seletor não exibiu os controles de áudio e vínculo automático.');
  if (process.env.JUMP_UI_SCREENSHOT) {
    await captureDebug(windows[0], 'picker');
  }
  await click(windows[0], '.screen-share-audio-options input[type="checkbox"]:first-of-type');
  await click(windows[0], '.screen-share-audio-options label:nth-of-type(2) input');
  await waitFor(() => windows[0].webContents.executeJavaScript("!document.querySelector('.screen-share-tabs button:nth-child(2)')?.disabled"), 'aba manual de áudio habilitada');
  await click(windows[0], '.screen-share-tabs button:nth-child(2)');
  await waitFor(() => count(windows[0], '.screen-share-source'), 'fontes manuais de áudio');
  await click(windows[0], '.screen-share-source');
  await click(windows[0], '.screen-share-tabs button:first-child');
  await click(windows[0], '.screen-share-source');
  await click(windows[0], '.screen-share-actions .dialog-primary');
  await waitFor(() => count(windows[0], 'button[aria-label="Parar compartilhamento"]'), 'compartilhamento local ativo', 20_000);
  await waitFor(() => Promise.all(windows.slice(1).map((window) => count(window, '.voice-member-mic.is-sharing'))).then((values) => values.every(Boolean)), 'compartilhamento anunciado aos peers', 20_000);
  await waitFor(() => Promise.all(windows.slice(1).map((window) => count(window, '.call-stream-card video'))).then((values) => values.every(Boolean)), 'faixa de tela recebida pelos peers', 20_000);
  await waitFor(() => Promise.all(windows.slice(1).map((window) => count(window, '.call-stream-share-audio'))).then((values) => values.every((value) => value === 1)), 'áudio da transmissão separado do microfone', 20_000);
  await waitFor(() => Promise.all(windows.slice(1).map((window) => inboundRtpCount(window, 'video'))).then((values) => values.every((value) => value >= 1)), 'RTP da tela recebido pelos dois peers', 20_000);
  await waitFor(() => windows[0].webContents.executeJavaScript(`(() => [...globalThis.__jumpPeerMesh.peerConnectionsRef.current.values()].every((slot) => {
    const encoding = slot.videoSender?.getParameters?.().encodings?.[0];
    return Number(encoding?.maxBitrate) > 0 && Number(encoding?.maxFramerate) > 0;
  }))()`), 'perfil de bitrate e FPS aplicado aos remetentes', 20_000);
  await waitFor(() => windows[0].webContents.executeJavaScript(`(() => [...globalThis.__jumpPeerMesh.peerConnectionsRef.current.values()].every((slot) => {
    const videoStream = slot.videoSenderStream;
    const audioStream = slot.screenAudioSenderStream;
    return videoStream?.id && videoStream.id === audioStream?.id;
  }))()`), 'áudio e vídeo publicados com a mesma linha do tempo', 20_000);
  try {
    await waitFor(() => Promise.all(windows.slice(1).map((window) => window.webContents.executeJavaScript(`(() => [...globalThis.__jumpPeerMesh.peerConnectionsRef.current.values()]
      .filter((slot) => slot.remoteMediaState?.sharing)
      .every((slot) => {
        const expected = { performance: 140, quality: 180 }[slot.remoteMediaState.sharingProfile];
        return slot.remotePlaybackProfile === slot.remoteMediaState.sharingProfile
          && (!('jitterBufferTarget' in slot.videoTransceiver.receiver) || slot.videoTransceiver.receiver.jitterBufferTarget === expected)
          && (!('jitterBufferTarget' in slot.screenAudioTransceiver.receiver) || slot.screenAudioTransceiver.receiver.jitterBufferTarget === expected);
      }))()`))).then((values) => values.every(Boolean)), 'buffer de reprodução fixo e sincronizado', 20_000);
  } catch (error) {
    const playbackDiagnostics = await Promise.all(windows.slice(1).map((window) => window.webContents.executeJavaScript(`(() => [...globalThis.__jumpPeerMesh.peerConnectionsRef.current.values()].map((slot) => ({
      sharing: slot.remoteMediaState?.sharing,
      profile: slot.remotePlaybackProfile,
      hasVideoTarget: 'jitterBufferTarget' in slot.videoTransceiver.receiver,
      videoTarget: slot.videoTransceiver.receiver.jitterBufferTarget,
      hasAudioTarget: 'jitterBufferTarget' in slot.screenAudioTransceiver.receiver,
      audioTarget: slot.screenAudioTransceiver.receiver.jitterBufferTarget,
    })))()`)));
    process.stderr.write(`${JSON.stringify(playbackDiagnostics, null, 2)}\n`);
    throw error;
  }
  await waitFor(() => windows[0].webContents.executeJavaScript(`(() => [...globalThis.__jumpPeerMesh.peerConnectionsRef.current.values()].every((slot) => (
    slot.videoAdaptation?.profileId === 'performance'
    && slot.videoAdaptation?.targetFps === 60
    && Number(slot.videoAdaptation?.effectiveWidth) <= 1280
  )))()`), 'controlador automático de desempenho ativo', 20_000);

  await windows[1].webContents.executeJavaScript("document.querySelector('.chat-toggle-button.is-active')?.click()");

  await windows[1].webContents.executeJavaScript(`(() => {
    const card = [...document.querySelectorAll('.call-stream-card')].find((entry) => entry.textContent.includes('compartilhando a tela'));
    card?.querySelector('.call-stream-viewport')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await waitFor(() => count(windows[1], '.call-stream-grid.has-focused-stream .call-stream-card.is-focused'), 'transmissão maximizada dentro da chamada');
  const focusedLayout = await windows[1].webContents.executeJavaScript(`(() => {
    const grid = document.querySelector('.call-stream-grid.has-focused-stream');
    const card = grid?.querySelector('.call-stream-card.is-focused');
    const viewport = card?.querySelector('.call-stream-viewport');
    const video = viewport?.querySelector('video');
    const caption = card?.querySelector('.call-stream-caption');
    if (!grid || !card || !viewport || !video || !caption) return null;
    const cardRect = card.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const captionRect = caption.getBoundingClientRect();
    const visibleCards = [...grid.querySelectorAll('.call-stream-card')]
      .filter((entry) => getComputedStyle(entry).display !== 'none').length;
    return {
      visibleCards,
      objectFit: getComputedStyle(video).objectFit,
      viewportInsideCard: viewportRect.top >= cardRect.top - 1 && viewportRect.bottom <= captionRect.top + 1,
      captionInsideCard: captionRect.bottom <= cardRect.bottom + 1,
      fillsStage: cardRect.height > 600 && viewportRect.width > 1000,
    };
  })()`);
  if (!focusedLayout || focusedLayout.visibleCards !== 1 || focusedLayout.objectFit !== 'contain'
    || !focusedLayout.viewportInsideCard || !focusedLayout.captionInsideCard || !focusedLayout.fillsStage) {
    throw new Error(`Layout focado cortado ou com participantes duplicados: ${JSON.stringify(focusedLayout)}`);
  }
  await captureDebug(windows[1], 'focused');
  await windows[1].webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.call-stream-card.is-focused');
    card?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 220 }));
  })()`);
  await waitFor(() => count(windows[1], '.participant-volume-popover input[type="range"]'), 'mixer individual aberto com clique direito');
  await captureDebug(windows[1], 'mixer');
  if (await count(windows[1], '.participant-volume-popover input[type="range"]') !== 2) throw new Error('O mixer não separou microfone e transmissão.');
  await windows[1].webContents.executeJavaScript(`(() => {
    const slider = document.querySelectorAll('.participant-volume-popover input[type="range"]')[1];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(slider, '35');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(() => windows[1].webContents.executeJavaScript(`(() => {
    const streamAudio = document.querySelector('.call-stream-share-audio');
    const microphoneAudio = document.querySelector('.call-stream-audio:not(.call-stream-share-audio)');
    return Math.abs(Number(streamAudio?.volume) - 0.35) < 0.01 && Number(microphoneAudio?.volume) === 1;
  })()`), 'volumes de transmissão e microfone independentes');
  await click(windows[1], '.participant-volume-popover .win98-close-control');

  await windows[1].webContents.executeJavaScript(`(() => {
    const card = [...document.querySelectorAll('.call-stream-card')].find((entry) => entry.textContent.includes('compartilhando a tela'));
    card?.querySelector('.call-stream-watch-toggle')?.click();
  })()`);
  await waitFor(() => count(windows[1], '.call-stream-card.is-paused .call-stream-paused'), 'transmissão pausada pelo espectador');
  await captureDebug(windows[1], 'paused');
  await waitFor(() => windows[0].webContents.executeJavaScript(`(() => [...globalThis.__jumpPeerMesh.peerConnectionsRef.current.values()].some((slot) => (
    slot.videoSender?.getParameters?.().encodings?.[0]?.active === false
    && slot.screenAudioSender?.getParameters?.().encodings?.[0]?.active === false
  )))()`), 'remetente parou vídeo e áudio para o espectador', 20_000);
  await click(windows[1], '.call-stream-card.is-paused .call-stream-paused button');
  await waitFor(() => windows[0].webContents.executeJavaScript(`(() => [...globalThis.__jumpPeerMesh.peerConnectionsRef.current.values()].every((slot) => (
    slot.videoSender?.getParameters?.().encodings?.[0]?.active !== false
    && slot.screenAudioSender?.getParameters?.().encodings?.[0]?.active !== false
  )))()`), 'transmissão retomada para o espectador', 20_000);
  await windows[1].webContents.executeJavaScript("document.querySelector('.call-stream-card.is-focused .call-stream-viewport')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
  await waitFor(async () => (await count(windows[1], '.call-stream-grid.has-focused-stream')) === 0, 'layout restaurado após segundo clique duplo');

  // Recreate the signaling service to exercise the renderer's reconnect path.
  // Existing media tracks must be rebound to the peers' new socket identities.
  await stopServer();
  await startServer();
  await waitFor(() => Promise.all(windows.map((window) => window.webContents.executeJavaScript("document.querySelector('.signal-badge')?.textContent.includes('3 conectados')"))).then((values) => values.every(Boolean)), 'três participantes após reconexão', 20_000);
  try {
    await waitFor(() => Promise.all(windows.map((window, index) => window.webContents.executeJavaScript(`(() => (
      document.querySelectorAll('.call-stream-card audio').length >= 2
      && (${index} === 0 || document.querySelectorAll('.call-stream-card video').length >= 1)
    ))()`))).then((values) => values.every(Boolean)), 'mídia remota refeita após reconexão', 20_000);
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
  await waitFor(() => Promise.all(windows.slice(1).map((window) => count(window, '.call-stream-share-audio'))).then((values) => values.every((value) => value === 1)), 'áudio separado após reconexão', 20_000);

  process.stdout.write('OK: 3 participantes, A/V sincronizado, foco sem corte, pausa, mixer, RTP e reconexão validados.\n');
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

const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const port = 19_000 + Math.floor(Math.random() * 800);
const room = `diagnostics-e2e-${Date.now()}`;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jump-screen-diagnostics-'));
const preload = path.join(projectRoot, 'electron', 'preload.cjs');
const windows = [];

process.env.PORT = String(port);
process.env.HOST = '127.0.0.1';
process.env.JUMP_STREAM_DIAGNOSTICS = '1';
process.env.JUMP_APP_COMMIT = 'diagnostics-integration-test';

app.setPath('userData', userData);
app.setAppPath(projectRoot);
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('auto-select-desktop-capture-source', 'Entire screen');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(100);
  }
  throw new Error(`Timeout esperando: ${label}`);
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

function grantPermissions(targetSession) {
  targetSession.setPermissionCheckHandler(() => true);
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(true));
}

async function createReceiverWindow() {
  const receiver = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      partition: `diagnostics-receiver-${Date.now()}`,
      preload,
    },
  });
  grantPermissions(receiver.webContents.session);
  windows.push(receiver);
  await receiver.loadURL(`http://127.0.0.1:${port}/?room=${room}&meshDebug=1`);
  return receiver;
}

async function instrumentReceiverVideoFrames(receiver) {
  return receiver.webContents.executeJavaScript(`(() => {
    const native = HTMLVideoElement.prototype.requestVideoFrameCallback;
    if (typeof native !== 'function') return false;
    globalThis.__jumpRenderFrameCallbackRegistrations = 0;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function instrumentedRequestVideoFrameCallback(...args) {
      globalThis.__jumpRenderFrameCallbackRegistrations += 1;
      return native.call(this, ...args);
    };
    return true;
  })()`);
}

function diagnosticsRoot() {
  return path.join(userData, 'diagnostics', 'screen-share');
}

function readArtifacts() {
  const root = diagnosticsRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(root, entry), 'utf8')));
}

async function run() {
  // Requiring the production entrypoint is intentional: this test must cover
  // its IPC handlers, signaling server startup, BrowserWindow and preload.
  require(path.join(projectRoot, 'electron', 'main.cjs'));
  await app.whenReady();
  grantPermissions(session.defaultSession);
  await waitFor(() => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed()), 'janela principal do Electron');
  const sender = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
  windows.push(sender);
  await waitFor(() => sender.webContents.executeJavaScript("document.readyState === 'complete'").catch(() => false), 'carga inicial da janela principal');
  await sender.loadURL(`http://127.0.0.1:${port}/?room=${room}&meshDebug=1`);
  const receiver = await createReceiverWindow();
  if (new URL(receiver.webContents.getURL()).searchParams.has('streamTelemetry')) {
    throw new Error('O receiver de diagnostics não deve depender de ?streamTelemetry.');
  }
  const receiverVideoFramesAvailable = await instrumentReceiverVideoFrames(receiver);

  await waitFor(() => Promise.all([sender, receiver].map((window) => (
    window.webContents.executeJavaScript('globalThis.jumpDesktop?.streamDiagnosticsEnabled === true')
  ))).then((values) => values.every(Boolean)), 'flag de diagnóstico no preload');
  const config = await sender.webContents.executeJavaScript('globalThis.jumpDesktop.getStreamDiagnosticsConfig()');
  const expectedOutputDirectory = path.join(userData, 'diagnostics', 'screen-share');
  if (!config.enabled || config.outputDirectory !== expectedOutputDirectory
      || config.activationSource !== 'environment' || config.appVersion !== '1.0.26'
      || config.appCommit !== 'diagnostics-integration-test'
      || !config.environment?.electronVersion || !config.environment?.display) {
    throw new Error(`A bridge de diagnóstico não retornou o manifesto de ambiente esperado: ${JSON.stringify(config)}`);
  }
  const settingsBridgeReady = await sender.webContents.executeJavaScript(`Boolean(
    globalThis.jumpDesktop?.relaunchStreamDiagnostics
    && globalThis.jumpDesktop?.openStreamDiagnosticsDirectory
  )`);
  if (!settingsBridgeReady) throw new Error('A bridge de controles de Field Run Diagnostics não está disponível.');
  await click(sender, 'button[aria-label="Configurações"]');
  await waitFor(() => sender.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('.app-settings-dialog');
    return dialog?.textContent.includes('Field Run Diagnostics')
      && dialog.textContent.includes('Ativado — forçado pelo ambiente')
      && dialog.textContent.includes('1.0.26')
      && Boolean(dialog.querySelector('button[disabled]'));
  })()`), 'configurações de Field Run Diagnostics');
  await click(sender, 'button[aria-label="Fechar configurações"]');

  await waitFor(() => Promise.all([sender, receiver].map((window) => window.webContents.executeJavaScript(
    "document.querySelector('.signal-badge.is-connected')?.textContent.includes('conectados')",
  ))).then((values) => values.every(Boolean)), 'clientes sinalizados');
  for (const window of [sender, receiver]) {
    await click(window, 'button[aria-label="Abrir chamada"]');
    await click(window, '.join-call-button');
  }
  await waitFor(() => Promise.all([sender, receiver].map((window) => window.webContents.executeJavaScript(
    "Boolean(document.querySelector('.leave-button'))",
  ))).then((values) => values.every(Boolean)), 'clientes dentro da chamada');
  await waitFor(() => Promise.all([sender, receiver].map((window) => window.webContents.executeJavaScript(
    "document.querySelector('.field-diagnostics-indicator')?.textContent === 'FIELD DIAGNOSTICS ON'",
  ))).then((values) => values.every(Boolean)), 'indicador visível de Field Run Diagnostics');

  await click(sender, 'button[aria-label="Compartilhar tela"]');
  await waitFor(() => sender.webContents.executeJavaScript("document.querySelectorAll('.screen-share-source').length > 0"), 'fontes de captura');
  await click(sender, '.screen-share-source');
  await click(sender, '.screen-share-actions .dialog-primary');
  await waitFor(() => sender.webContents.executeJavaScript(
    'Boolean(document.querySelector(\'button[aria-label="Parar compartilhamento"]\'))',
  ), 'compartilhamento ativo');
  await waitFor(() => receiver.webContents.executeJavaScript(
    "Boolean(document.querySelector('.voice-member-mic.is-sharing'))",
  ), 'call-state com runId anunciado');
  await waitFor(() => receiver.webContents.executeJavaScript(
    "document.querySelectorAll('.call-stream-card video').length > 0",
  ), 'vídeo remoto recebido');
  await waitFor(() => receiver.webContents.executeJavaScript(
    "document.readyState === 'complete' && Boolean(document.querySelector('.leave-button')) && document.querySelectorAll('.call-stream-card video').length > 0",
  ), 'renderer do receiver vivo com vídeo remoto');
  await wait(3_500);

  await click(sender, 'button[aria-label="Parar compartilhamento"]');
  await waitFor(() => readArtifacts().length >= 2, 'artefatos sender/receiver gravados', 20_000);
  const artifacts = readArtifacts();
  const runIds = [...new Set(artifacts.map((artifact) => artifact.runId))];
  const senderArtifacts = artifacts.filter((artifact) => artifact.role === 'sender');
  const receiverArtifacts = artifacts.filter((artifact) => artifact.role === 'receiver');
  if (runIds.length !== 1 || !senderArtifacts.length || !receiverArtifacts.length) {
    throw new Error(`Correlação incompleta: ${JSON.stringify({ runIds, roles: artifacts.map((artifact) => artifact.role) })}`);
  }
  if (artifacts.some((artifact) => artifact.schemaVersion !== 1 || !artifact.samples.length)) {
    throw new Error('O smoke test encontrou artefato sem schema ou série temporal.');
  }
  const audioPaths = ['microphoneOutbound', 'microphoneInbound', 'screenAudioOutbound', 'screenAudioInbound'];
  if (artifacts.some((artifact) => artifact.samples.some((sample) => (
    !sample.audio || audioPaths.some((pathName) => !(pathName in sample.audio))
  )))) {
    throw new Error('O smoke test encontrou série temporal sem os quatro caminhos de áudio.');
  }
  if (artifacts.some((artifact) => !artifact.environment?.electronVersion || !artifact.environment?.display)) {
    throw new Error('O smoke test encontrou artefato sem manifesto de ambiente.');
  }
  if (artifacts.some((artifact) => artifact.capture?.source?.name || artifact.capture?.source?.title || artifact.capture?.source?.windowTitle)) {
    throw new Error('O smoke test encontrou título de janela no artefato de diagnóstico.');
  }
  const receiverRenderWindowCount = receiverArtifacts.reduce((count, artifact) => count + (artifact.render?.windows?.length || 0), 0);
  const receiverRenderFrameCallbackRegistrations = receiverVideoFramesAvailable
    ? await receiver.webContents.executeJavaScript('globalThis.__jumpRenderFrameCallbackRegistrations || 0')
    : 0;
  if (receiverVideoFramesAvailable && receiverRenderFrameCallbackRegistrations < 1) {
    throw new Error('O receiver não registrou requestVideoFrameCallback apesar de o runtime suportá-lo.');
  }
  if (receiverVideoFramesAvailable && receiverRenderWindowCount < 1) {
    throw new Error('O artefato do receiver não contém render diagnostics.');
  }
  await waitFor(() => receiver.webContents.executeJavaScript(
    "document.readyState === 'complete' && Boolean(document.querySelector('.leave-button'))",
  ), 'receiver vivo após a coleta de render diagnostics');
  const receiverWithCorrelation = receiverArtifacts.find((artifact) => artifact.correlation);
  if (!receiverWithCorrelation || !Object.prototype.hasOwnProperty.call(receiverWithCorrelation.correlation, 'senderAnnouncedStartedAtMs')) {
    throw new Error('O smoke test encontrou receiver sem correlação explícita do timestamp remoto.');
  }
  const output = {
    userData,
    artifactCount: artifacts.length,
    senderCount: senderArtifacts.length,
    receiverCount: receiverArtifacts.length,
    receiverVideoFramesAvailable,
    receiverRenderFrameCallbackRegistrations,
    receiverRenderWindowCount,
    runId: runIds[0],
    sampleCounts: artifacts.map((artifact) => ({ role: artifact.role, participantId: artifact.participantId, samples: artifact.samples.length })),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

async function cleanup() {
  for (const window of [...windows].reverse()) {
    if (window && !window.isDestroyed()) window.close();
  }
  await wait(250);
  if (app.isReady()) app.quit();
  await fsp.rm(userData, { recursive: true, force: true }).catch(() => {});
}

run()
  .catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  })
  .finally(() => cleanup());

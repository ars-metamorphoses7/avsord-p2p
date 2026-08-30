const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const WebSocket = require('ws');

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, '..');
const executable = path.join(projectRoot, 'release', 'win-unpacked', 'JUMP.exe');
let smokeRoot;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(check, label, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await wait(150);
  }
  throw new Error(`Timeout esperando ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function targetForPort(debugPort) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json`);
  if (!response.ok) throw new Error(`DevTools HTTP ${response.status}`);
  const targets = await response.json();
  const target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
  if (!target) throw new Error('Nenhuma página DevTools disponível.');
  return target;
}

async function evaluate(debugPort, expression) {
  const target = await targetForPort(debugPort);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  try {
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout de avaliação DevTools.')), 10_000);
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.id !== 1) return;
        clearTimeout(timeout);
        resolve(message);
      });
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text || 'Falha na avaliação DevTools.');
    return response.result?.result?.value;
  } finally {
    socket.close();
  }
}

async function waitForReady(debugPort) {
  await waitFor(() => evaluate(debugPort, 'document.readyState === "complete"'), 'a página do JUMP');
  await waitFor(() => evaluate(debugPort, 'typeof globalThis.jumpDesktop?.getStreamDiagnosticsConfig === "function"'), 'o preload do JUMP');
}

function startPackagedJump({ debugPort, fieldMode = false, appDataDirectory, roomId = 'jump-house', signalOrigin = '', signalPort }) {
  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${appDataDirectory}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--auto-select-desktop-capture-source=Entire screen',
  ];
  if (fieldMode) args.push('--jump-stream-diagnostics');
  const deepLink = new URLSearchParams({ room: roomId });
  if (signalOrigin) deepLink.set('signal', signalOrigin);
  args.push(`jump://join?${deepLink.toString()}`);
  const localSignalPort = signalPort || (20_000 + Math.floor(Math.random() * 1_000));
  const environment = {
    ...process.env,
    APPDATA: appDataDirectory,
    LOCALAPPDATA: appDataDirectory,
    PORT: String(localSignalPort),
    HOST: '127.0.0.1',
    JUMP_USER_DATA_DIR: appDataDirectory,
    JUMP_STREAM_DIAGNOSTICS: '',
  };
  return require('node:child_process').spawn(executable, args, {
    cwd: path.dirname(executable),
    env: environment,
    windowsHide: true,
    stdio: 'ignore',
  });
}

async function stopWorkspaceJumpProcesses() {
  const escapedExecutable = executable.replace(/'/g, "''");
  const command = `$target = '${escapedExecutable}'; Get-CimInstance Win32_Process -Filter \"Name = 'JUMP.exe'\" | Where-Object { $_.ExecutablePath -eq $target } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command]).catch(() => {});
}

async function readConfig(debugPort) {
  return evaluate(debugPort, 'globalThis.jumpDesktop.getStreamDiagnosticsConfig()');
}

async function openSettingsAndRead(debugPort) {
  const clicked = await evaluate(debugPort, `(() => {
    const button = document.querySelector('button[aria-label="Configurações"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, 'o botão de Configurações deve estar disponível');
  return waitFor(async () => {
    const state = await evaluate(debugPort, `(() => {
      const dialog = document.querySelector('.app-settings-dialog');
      return dialog ? dialog.textContent : '';
    })()`);
    return state.includes('Field Run Diagnostics') ? state : null;
  }, 'a tela Field Run Diagnostics');
}

async function click(debugPort, selector) {
  const clicked = await evaluate(debugPort, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.click();
    return true;
  })()`);
  assert.equal(clicked, true, `elemento ausente: ${selector}`);
}

async function instrumentReceiverVideoFrames(debugPort) {
  return evaluate(debugPort, `(() => {
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

async function readArtifacts(appDataDirectory) {
  const root = path.join(appDataDirectory, 'diagnostics', 'screen-share');
  if (!await fs.stat(root).then(() => true).catch(() => false)) return [];
  const entries = await fs.readdir(root);
  return Promise.all(entries.filter((entry) => entry.endsWith('.json')).map(async (entry) => (
    JSON.parse(await fs.readFile(path.join(root, entry), 'utf8'))
  )));
}

async function run() {
  assert.equal(await fs.stat(executable).then(() => true).catch(() => false), true, 'Execute npm run desktop:dir antes do smoke empacotado.');
  smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jump-field-packaged-smoke-'));
  const normalAppData = path.join(smokeRoot, 'normal-appdata');
  const fieldAppData = path.join(smokeRoot, 'field-appdata');
  await fs.mkdir(normalAppData, { recursive: true });
  await fs.mkdir(fieldAppData, { recursive: true });

  const normalPort = 22_001;
  const normal = startPackagedJump({ debugPort: normalPort, appDataDirectory: normalAppData, signalPort: 23_001 });
  try {
    await waitForReady(normalPort);
    const config = await readConfig(normalPort);
    assert.equal(config.enabled, false);
    assert.equal(config.activationSource, 'off');
    assert.equal(config.appVersion, '1.0.27');
    assert.match(config.appCommit || '', /^[0-9a-f]{7,64}$/i);
    assert.equal((await fs.readdir(config.outputDirectory).catch(() => [])).length, 0, 'o modo normal não cria artefatos');
    const settings = await openSettingsAndRead(normalPort);
    assert.match(settings, /Desativado/);
  } finally {
    normal.kill();
    await wait(500);
  }

  const preferenceAppData = path.join(smokeRoot, 'preference-appdata');
  await fs.mkdir(preferenceAppData, { recursive: true });
  const preferenceFile = path.join(preferenceAppData, 'field-diagnostics.json');
  await fs.writeFile(preferenceFile, JSON.stringify({ enabled: true }), 'utf8');
  const preferencePort = 22_004;
  const preferenceLaunch = startPackagedJump({
    debugPort: preferencePort,
    appDataDirectory: preferenceAppData,
    signalPort: 23_004,
  });
  try {
    await waitForReady(preferencePort);
    const preferenceConfig = await readConfig(preferencePort);
    assert.equal(preferenceConfig.enabled, true);
    assert.equal(preferenceConfig.activationSource, 'preference');
    const preferenceSettings = await openSettingsAndRead(preferencePort);
    assert.match(preferenceSettings, /Ativado/);
  } finally {
    preferenceLaunch.kill();
    await wait(500);
  }

  await fs.writeFile(preferenceFile, JSON.stringify({ enabled: false }), 'utf8');
  const disabledPreferencePort = 22_005;
  const disabledPreferenceLaunch = startPackagedJump({
    debugPort: disabledPreferencePort,
    appDataDirectory: preferenceAppData,
    signalPort: 23_005,
  });
  try {
    await waitForReady(disabledPreferencePort);
    const disabledPreferenceConfig = await readConfig(disabledPreferencePort);
    assert.equal(disabledPreferenceConfig.enabled, false);
    assert.equal(disabledPreferenceConfig.activationSource, 'off');
    const disabledPreferenceSettings = await openSettingsAndRead(disabledPreferencePort);
    assert.match(disabledPreferenceSettings, /Desativado/);
  } finally {
    disabledPreferenceLaunch.kill();
    await wait(500);
  }

  const roomId = `packaged-field-smoke-${Date.now()}`;
  const senderPort = 22_002;
  const receiverPort = 22_003;
  const senderSignalPort = 23_002;
  const receiverSignalPort = 23_003;
  const sender = startPackagedJump({
    debugPort: senderPort,
    fieldMode: true,
    appDataDirectory: normalAppData,
    roomId,
    signalPort: senderSignalPort,
  });
  let receiver;
  try {
    await waitForReady(senderPort);
    receiver = startPackagedJump({
      debugPort: receiverPort,
      fieldMode: true,
      appDataDirectory: fieldAppData,
      roomId,
      signalOrigin: `http://127.0.0.1:${senderSignalPort}`,
      signalPort: receiverSignalPort,
    });
    await waitForReady(receiverPort);
    const receiverUrl = new URL(await evaluate(receiverPort, 'location.href'));
    assert.equal(receiverUrl.searchParams.has('streamTelemetry'), false, 'receiver não deve usar ?streamTelemetry');
    const receiverVideoFramesAvailable = await instrumentReceiverVideoFrames(receiverPort);
    const config = await readConfig(receiverPort);
    assert.equal(config.enabled, true);
    assert.equal(config.activationSource, 'cli');
    assert.equal(config.appVersion, '1.0.27');
    assert.match(config.appCommit || '', /^[0-9a-f]{7,64}$/i);
    const settings = await openSettingsAndRead(receiverPort);
    assert.match(settings, /Ativado/);
    assert.match(settings, /Abrir pasta de diagnóstico/);
    await click(receiverPort, 'button[aria-label="Fechar configurações"]');

    await waitFor(() => Promise.all([senderPort, receiverPort].map((debugPort) => evaluate(
      debugPort,
      "document.querySelector('.signal-badge.is-connected')?.textContent.includes('conectados')",
    ))).then((values) => values.every(Boolean)), 'clientes empacotados sinalizados');
    await click(senderPort, 'button[aria-label="Abrir chamada"]');
    await click(senderPort, '.join-call-button');
    await click(receiverPort, 'button[aria-label="Abrir chamada"]');
    await click(receiverPort, '.join-call-button');
    await waitFor(() => Promise.all([senderPort, receiverPort].map((debugPort) => evaluate(
      debugPort,
      "Boolean(document.querySelector('.leave-button'))",
    ))).then((values) => values.every(Boolean)), 'clientes empacotados dentro da chamada');
    await waitFor(() => evaluate(receiverPort, "document.querySelector('.field-diagnostics-indicator')?.textContent === 'FIELD DIAGNOSTICS ON'"), 'indicador Field Diagnostics no receiver');

    await click(senderPort, 'button[aria-label="Compartilhar tela"]');
    await waitFor(() => evaluate(senderPort, "document.querySelectorAll('.screen-share-source').length > 0"), 'fontes de captura empacotadas');
    await click(senderPort, '.screen-share-source');
    await click(senderPort, '.screen-share-actions .dialog-primary');
    await waitFor(() => evaluate(senderPort, "Boolean(document.querySelector('button[aria-label=\"Parar compartilhamento\"]'))"), 'compartilhamento empacotado ativo');
    await waitFor(() => evaluate(receiverPort, "Boolean(document.querySelector('.voice-member-mic.is-sharing'))"), 'runId do sender no receiver empacotado');
    await waitFor(() => evaluate(receiverPort, "document.querySelectorAll('.call-stream-card video').length > 0"), 'vídeo remoto empacotado recebido');
    await waitFor(() => evaluate(receiverPort, "document.readyState === 'complete' && Boolean(document.querySelector('.leave-button')) && document.querySelectorAll('.call-stream-card video').length > 0"), 'renderer empacotado do receiver vivo');
    await wait(3_500);

    const receiverRenderFrameCallbackRegistrations = receiverVideoFramesAvailable
      ? await evaluate(receiverPort, 'globalThis.__jumpRenderFrameCallbackRegistrations || 0')
      : 0;
    if (receiverVideoFramesAvailable && receiverRenderFrameCallbackRegistrations < 1) {
      const receiverState = await evaluate(receiverPort, `(async () => ({
        url: location.href,
        diagnostics: await globalThis.jumpDesktop?.getStreamDiagnosticsConfig?.(),
        videos: [...document.querySelectorAll('.call-stream-card video')].map((video) => ({
          readyState: video.readyState,
          paused: video.paused,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          hasStream: Boolean(video.srcObject),
        })),
        remoteStreams: [...(globalThis.__jumpPeerMesh?.remoteStreamsRef.current || [])].map(([peerId, bundle]) => ({
          peerId,
          hasVideo: Boolean(bundle.videoStream),
          videoTracks: bundle.videoStream?.getVideoTracks?.().length || 0,
          hasDiagnostics: Boolean(bundle.screenShareDiagnosticsSession),
        })),
      }))()`);
      throw new Error(`receiver não registrou requestVideoFrameCallback: ${JSON.stringify(receiverState)}`);
    }
    await click(senderPort, 'button[aria-label="Parar compartilhamento"]');
    await waitFor(async () => (await readArtifacts(fieldAppData)).length >= 1, 'artefato do receiver empacotado', 20_000);
    const receiverArtifacts = (await readArtifacts(fieldAppData)).filter((artifact) => artifact.role === 'receiver');
    assert.ok(receiverArtifacts.length >= 1, 'o receiver empacotado deve gravar um artefato');
    const receiverRenderWindowCount = receiverArtifacts.reduce((count, artifact) => count + (artifact.render?.windows?.length || 0), 0);
    if (receiverVideoFramesAvailable) assert.ok(receiverRenderWindowCount > 0, 'o artefato do receiver deve conter render diagnostics');
    await waitFor(() => evaluate(receiverPort, "document.readyState === 'complete' && Boolean(document.querySelector('.leave-button'))"), 'receiver vivo após render diagnostics');

    const opened = await evaluate(receiverPort, 'globalThis.jumpDesktop.openStreamDiagnosticsDirectory()');
    assert.equal(opened?.opened, true, opened?.error || 'a pasta de diagnóstico não abriu');
    process.stdout.write(`${JSON.stringify({
      receiverVideoFramesAvailable,
      receiverRenderFrameCallbackRegistrations,
      receiverRenderWindowCount,
      receiverArtifacts: receiverArtifacts.length,
    }, null, 2)}\n`);
  } finally {
    sender.kill();
    await stopWorkspaceJumpProcesses();
  }
}

run()
  .then(() => process.stdout.write('OK: smoke empacotado normal, Field Mode, indicador, pasta e artefato validados.\n'))
  .catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopWorkspaceJumpProcesses();
    if (smokeRoot) await fs.rm(smokeRoot, { recursive: true, force: true }).catch(() => {});
  });

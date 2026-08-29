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

function startPackagedJump({ debugPort, fieldMode = false, appDataDirectory }) {
  const args = [
    `--remote-debugging-port=${debugPort}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ];
  if (fieldMode) args.push('--jump-stream-diagnostics');
  const environment = {
    ...process.env,
    APPDATA: appDataDirectory,
    LOCALAPPDATA: appDataDirectory,
    PORT: String(20_000 + Math.floor(Math.random() * 1_000)),
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

async function run() {
  assert.equal(await fs.stat(executable).then(() => true).catch(() => false), true, 'Execute npm run desktop:dir antes do smoke empacotado.');
  smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jump-field-packaged-smoke-'));
  const normalAppData = path.join(smokeRoot, 'normal-appdata');
  const fieldAppData = path.join(smokeRoot, 'field-appdata');
  await fs.mkdir(normalAppData, { recursive: true });
  await fs.mkdir(fieldAppData, { recursive: true });

  const normalPort = 22_001;
  const normal = startPackagedJump({ debugPort: normalPort, appDataDirectory: normalAppData });
  try {
    await waitForReady(normalPort);
    const config = await readConfig(normalPort);
    assert.equal(config.enabled, false);
    assert.equal(config.activationSource, 'off');
    assert.equal(config.appVersion, '1.0.24');
    assert.match(config.appCommit || '', /^[0-9a-f]{7,64}$/i);
    assert.equal((await fs.readdir(config.outputDirectory).catch(() => [])).length, 0, 'o modo normal não cria artefatos');
    const settings = await openSettingsAndRead(normalPort);
    assert.match(settings, /Desativado/);
  } finally {
    normal.kill();
    await wait(500);
  }

  const fieldPort = 22_002;
  startPackagedJump({ debugPort: fieldPort, fieldMode: true, appDataDirectory: fieldAppData });
  try {
    await waitForReady(fieldPort);
    let config = await readConfig(fieldPort);
    assert.equal(config.enabled, true);
    assert.equal(config.activationSource, 'cli');
    assert.equal(config.appVersion, '1.0.24');
    assert.match(config.appCommit || '', /^[0-9a-f]{7,64}$/i);
    const settings = await openSettingsAndRead(fieldPort);
    assert.match(settings, /Ativado/);
    assert.match(settings, /Abrir pasta de diagnóstico/);
    await evaluate(fieldPort, `document.querySelector('button[aria-label="Fechar configurações"]')?.click()`);

    const callPanelOpened = await evaluate(fieldPort, `(() => {
      const button = document.querySelector('button[aria-label="Abrir chamada"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(callPanelOpened, true);
    await waitFor(() => evaluate(fieldPort, "Boolean(document.querySelector('.join-call-button'))"), 'o controle para entrar na chamada');
    const joined = await evaluate(fieldPort, `(() => {
      const button = document.querySelector('.join-call-button');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(joined, true);
    await waitFor(() => evaluate(fieldPort, "Boolean(document.querySelector('.leave-button'))"), 'a entrada na chamada');
    await waitFor(() => evaluate(fieldPort, "document.querySelector('.field-diagnostics-indicator')?.textContent === 'FIELD DIAGNOSTICS ON'"), 'o indicador FIELD DIAGNOSTICS ON');

    const written = await evaluate(fieldPort, `globalThis.jumpDesktop.writeScreenShareDiagnosticsArtifact({
      schemaVersion: 1,
      runId: 'packaged-field-smoke',
      role: 'sender',
      participantId: 'smoke',
      samples: []
    })`);
    assert.equal(written?.written, true);
    assert.equal(await fs.stat(written.path).then(() => true).catch(() => false), true, 'o pacote deve gravar um artefato local');
    const opened = await evaluate(fieldPort, 'globalThis.jumpDesktop.openStreamDiagnosticsDirectory()');
    assert.equal(opened?.opened, true, opened?.error || 'a pasta de diagnóstico não abriu');

    // Relaunch enable/disable is covered deterministically with a fake Electron
    // app in field-run-diagnostics.test.cjs. This packaged smoke keeps focus on
    // the installed user path: OFF by default, CLI field mode, visible marker,
    // local artifact, and operating-system folder open.
  } finally {
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

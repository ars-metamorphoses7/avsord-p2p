const { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen, session } = require('electron');
const { execFile, execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { pathToFileURL } = require('node:url');
const { compareRgba } = require('./helpers/image-quality.cjs');

const projectRoot = path.resolve(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixtures', 'motion-source.html');
const sourceTitle = `JUMP_BENCH_MOTION_SOURCE_${process.pid}`;
const port = 20_000 + Math.floor(Math.random() * 10_000);
const room = `stream-benchmark-${Date.now()}-${process.pid}`;
const windows = [];
let signalingProcess = null;
let externalSourceProcess = null;
let externalSourceProfile = '';
let externalSourceExecutable = '';
let externalSourceVersion = '';
const benchmarkUserData = path.join(os.tmpdir(), `jump-stream-benchmark-electron-${process.pid}`);
const benchmarkServerData = path.join(os.tmpdir(), `jump-stream-benchmark-server-${process.pid}`);

function removeBenchmarkTempDirectory(targetPath, expectedPrefix) {
  if (!targetPath) return false;
  const resolved = path.resolve(targetPath);
  const resolvedTemp = path.resolve(os.tmpdir());
  const insideTempRoot = path.dirname(resolved) === resolvedTemp;
  const expectedName = path.basename(resolved).startsWith(expectedPrefix);
  if (!insideTempRoot || !expectedName) return false;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function scheduleBenchmarkTempCleanup(targets) {
  const validatedTargets = targets.filter(({ targetPath, expectedPrefix }) => {
    if (!targetPath) return false;
    const resolved = path.resolve(targetPath);
    return path.dirname(resolved) === path.resolve(os.tmpdir())
      && path.basename(resolved).startsWith(expectedPrefix);
  }).map(({ targetPath, expectedPrefix }) => ({
    targetPath: path.resolve(targetPath),
    expectedPrefix,
  }));
  if (!validatedTargets.length) return;
  const cleanupScript = String.raw`
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const targets = JSON.parse(process.argv[1] || '[]');
    setTimeout(() => {
      const tempRoot = path.resolve(os.tmpdir());
      for (const item of targets) {
        const resolved = path.resolve(item.targetPath || '');
        if (path.dirname(resolved) !== tempRoot) continue;
        if (!path.basename(resolved).startsWith(item.expectedPrefix || '__invalid__')) continue;
        try { fs.rmSync(resolved, { recursive: true, force: true }); } catch {}
      }
    }, 1500);
  `;
  try {
    const helper = spawn(process.execPath, ['-e', cleanupScript, JSON.stringify(validatedTargets)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    helper.unref();
  } catch { /* Temp cleanup must never hide a benchmark result. */ }
}

function integerEnv(name, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(parsed)));
}

function numberEnv(name, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function booleanEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'on', 'yes'].includes(String(raw).trim().toLowerCase());
}

const requestedProfiles = String(process.env.JUMP_BENCH_PROFILES || 'performance,quality')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const profiles = [...new Set(requestedProfiles)].filter((profile) => ['performance', 'quality'].includes(profile));
if (!profiles.length) throw new Error('JUMP_BENCH_PROFILES precisa conter performance e/ou quality.');
const captureType = String(process.env.JUMP_BENCH_CAPTURE_TYPE || 'window').trim().toLowerCase();
if (!['window', 'screen'].includes(captureType)) {
  throw new Error('JUMP_BENCH_CAPTURE_TYPE precisa ser window ou screen.');
}
const disableFeatures = String(process.env.JUMP_BENCH_DISABLE_FEATURES || '').trim();
const nvidiaSmiEnabled = !['0', 'false', 'off', 'no'].includes(
  String(process.env.JUMP_BENCH_NVIDIA_SMI || '1').trim().toLowerCase(),
);
const networkEmulation = {
  packetLossPercent: numberEnv('JUMP_BENCH_PACKET_LOSS_PERCENT', 0, 0, 100),
  packetQueueLength: integerEnv('JUMP_BENCH_PACKET_QUEUE_LENGTH', 0, 0, 100_000),
  packetReordering: booleanEnv('JUMP_BENCH_PACKET_REORDERING'),
  latencyMs: numberEnv('JUMP_BENCH_NETWORK_LATENCY_MS', 0, 0, 60_000),
  downloadKbps: numberEnv('JUMP_BENCH_DOWNLOAD_KBPS', 0, 0, 100_000_000),
  uploadKbps: numberEnv('JUMP_BENCH_UPLOAD_KBPS', 0, 0, 100_000_000),
};
networkEmulation.enabled = networkEmulation.packetLossPercent > 0
  || networkEmulation.packetQueueLength > 0
  || networkEmulation.packetReordering
  || networkEmulation.latencyMs > 0
  || networkEmulation.downloadKbps > 0
  || networkEmulation.uploadKbps > 0;

const config = {
  warmupMs: integerEnv('JUMP_BENCH_WARMUP_MS', 15_000, 0, 300_000),
  durationMs: integerEnv('JUMP_BENCH_DURATION_MS', 60_000, 500, 3_600_000),
  repeats: integerEnv('JUMP_BENCH_REPEATS', 5, 1, 100),
  sampleMs: integerEnv('JUMP_BENCH_SAMPLE_MS', 250, 100, 5_000),
  resourceSampleMs: integerEnv('JUMP_BENCH_RESOURCE_SAMPLE_MS', 1_000, 250, 30_000),
  sourceFps: integerEnv('JUMP_BENCH_SOURCE_FPS', 60, 1, 240),
  sourceWidth: integerEnv('JUMP_BENCH_SOURCE_WIDTH', 1920, 640, 3840),
  sourceHeight: integerEnv('JUMP_BENCH_SOURCE_HEIGHT', 1080, 360, 2160),
  sourceSeed: integerEnv('JUMP_BENCH_SOURCE_SEED', 0x4a554d50, 0, 0xffffffff),
  gpuLoad: integerEnv('JUMP_BENCH_GPU_LOAD', 0, 0, 128),
  qualitySamples: integerEnv('JUMP_BENCH_QUALITY_SAMPLES', 2, 0, 10),
  qualityWidth: integerEnv('JUMP_BENCH_QUALITY_WIDTH', 1920, 320, 3840),
  qualityHeight: integerEnv('JUMP_BENCH_QUALITY_HEIGHT', 1080, 180, 2160),
  qualitySettleMs: integerEnv('JUMP_BENCH_QUALITY_SETTLE_MS', 750, 100, 5_000),
  externalSource: ['1', 'ffplay', 'chrome'].includes(String(process.env.JUMP_BENCH_EXTERNAL_SOURCE || '').toLowerCase()),
  externalSourceMode: String(process.env.JUMP_BENCH_EXTERNAL_SOURCE || '').toLowerCase() === 'chrome' ? 'chrome' : 'ffplay',
  captureType,
  disableFeatures,
  nvidiaSmiEnabled,
  networkEmulation,
  profiles,
  outputPath: process.env.JUMP_BENCH_OUTPUT ? path.resolve(projectRoot, process.env.JUMP_BENCH_OUTPUT) : '',
  pretty: process.env.JUMP_BENCH_PRETTY === '1',
  stdout: process.env.JUMP_BENCH_STDOUT === '1',
};

const networkEmulationState = {
  requested: networkEmulation.enabled,
  active: false,
  target: null,
  mode: null,
  ruleIds: [],
  fallbackReason: null,
  error: null,
};
const attachedDebuggers = new Set();

app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
if (config.disableFeatures) app.commandLine.appendSwitch('disable-features', config.disableFeatures);
fs.mkdirSync(benchmarkUserData, { recursive: true });
app.setPath('userData', benchmarkUserData);

const nvidiaSmiState = {
  enabled: config.nvidiaSmiEnabled,
  detected: false,
  available: false,
  path: '',
  successfulSamples: 0,
  failedSamples: 0,
  lastError: null,
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function progress(message) {
  process.stderr.write(`[stream-benchmark] ${message}\n`);
}

async function waitFor(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error(`Timeout esperando ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return '';
  }
}

function sha256File(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
}

function detectNvidiaSmi() {
  if (!nvidiaSmiState.enabled || nvidiaSmiState.detected) return nvidiaSmiState;
  nvidiaSmiState.detected = true;
  try {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const executable = process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi';
    nvidiaSmiState.path = execFileSync(locator, [executable], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2_000,
    }).split(/\r?\n/).map((value) => value.trim()).find(Boolean) || '';
  } catch {
    nvidiaSmiState.path = '';
  }
  nvidiaSmiState.available = Boolean(nvidiaSmiState.path);
  if (!nvidiaSmiState.available) nvidiaSmiState.lastError = 'nvidia-smi não encontrado';
  return nvidiaSmiState;
}

function execFileText(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

const NVIDIA_QUERY_FIELDS = [
  'index',
  'name',
  'uuid',
  'pstate',
  'utilization.gpu',
  'utilization.encoder',
  'utilization.decoder',
  'memory.used',
  'memory.total',
  'power.draw',
  'temperature.gpu',
  'clocks.current.graphics',
  'clocks.current.memory',
];

const NVIDIA_NUMERIC_FIELDS = new Set([
  'index',
  'utilization.gpu',
  'utilization.encoder',
  'utilization.decoder',
  'memory.used',
  'memory.total',
  'power.draw',
  'temperature.gpu',
  'clocks.current.graphics',
  'clocks.current.memory',
]);

async function sampleNvidiaSmi() {
  detectNvidiaSmi();
  if (!nvidiaSmiState.available || nvidiaSmiState.failedSamples >= 3) return null;
  try {
    const stdout = await execFileText(nvidiaSmiState.path, [
      `--query-gpu=${NVIDIA_QUERY_FIELDS.join(',')}`,
      '--format=csv,noheader,nounits',
    ], { timeout: 3_000, maxBuffer: 1024 * 1024 });
    const gpus = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const values = line.split(',').map((value) => value.trim());
      return Object.fromEntries(NVIDIA_QUERY_FIELDS.map((field, index) => {
        if (!NVIDIA_NUMERIC_FIELDS.has(field)) return [field, values[index] || null];
        return [field, finiteOrNull(values[index])];
      }));
    });
    if (!gpus.length) throw new Error('nvidia-smi não retornou GPUs');
    nvidiaSmiState.available = true;
    nvidiaSmiState.successfulSamples += 1;
    nvidiaSmiState.lastError = null;
    return { gpus };
  } catch (error) {
    nvidiaSmiState.failedSamples += 1;
    nvidiaSmiState.lastError = String(error.stderr || error.message || error).trim();
    return null;
  }
}

async function startServer() {
  signalingProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOST: '127.0.0.1',
      PORT: String(port),
      JUMP_DATA_DIR: benchmarkServerData,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let serverError = '';
  signalingProcess.stderr.on('data', (chunk) => { serverError += chunk.toString(); });
  await waitFor(async () => {
    if (signalingProcess.exitCode !== null) {
      throw new Error(serverError || `servidor encerrou com ${signalingProcess.exitCode}`);
    }
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      return false;
    }
  }, 'servidor de sinalização');
}

async function stopServer() {
  const child = signalingProcess;
  signalingProcess = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, wait(3_000)]);
}

function setupIpc() {
  ipcMain.handle('window:state', () => ({ maximized: false }));
  ipcMain.handle('update:state', () => ({ status: 'benchmark', revision: 0 }));
  ipcMain.handle('room-session:remember', () => ({ ok: true }));
  ipcMain.handle('room-session:forget', () => ({ ok: true }));
  ipcMain.handle('room-session:list', () => []);
  ipcMain.handle('media:capabilities', () => {
    const features = app.getGPUFeatureStatus();
    return {
      hardwareAcceleration: app.isHardwareAccelerationEnabled(),
      hardwareVideoEncoding: String(features.video_encode || '').startsWith('enabled'),
      videoEncode: features.video_encode || 'unknown',
    };
  });
  ipcMain.handle('desktop:audio-start', () => ({ ok: false, message: 'Áudio desativado no benchmark.' }));
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
      audioSupported: false,
    }));
  });
}

async function createMotionSource() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const targetBounds = config.captureType === 'screen' ? primaryDisplay.bounds : primaryDisplay.workArea;
  const sourceWindow = new BrowserWindow({
    title: sourceTitle,
    show: false,
    frame: false,
    useContentSize: true,
    width: config.captureType === 'screen' ? targetBounds.width : config.sourceWidth,
    height: config.captureType === 'screen' ? targetBounds.height : config.sourceHeight,
    x: targetBounds.x,
    y: targetBounds.y,
    alwaysOnTop: config.captureType === 'screen',
    skipTaskbar: config.captureType === 'screen',
    backgroundColor: '#020504',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  windows.push(sourceWindow);
  await sourceWindow.loadFile(fixturePath, {
    query: {
      fps: String(config.sourceFps),
      seed: String(config.sourceSeed),
      gpuLoad: String(config.gpuLoad),
      title: sourceTitle,
    },
  });
  await waitFor(
    () => sourceWindow.webContents.executeJavaScript('Boolean(globalThis.__motionBenchmark?.snapshot)') ,
    'fixture de movimento',
  );
  sourceWindow.showInactive();
  if (config.captureType === 'screen') sourceWindow.moveTop();
  return sourceWindow;
}

async function createExternalMotionSource() {
  let sourceError = '';
  if (config.externalSourceMode === 'chrome') {
    const chromeCandidates = [
      path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    const chromePath = chromeCandidates.find((candidate) => candidate && fs.existsSync(candidate));
    if (!chromePath) throw new Error('Google Chrome não encontrado para a fonte WGC externa.');
    externalSourceExecutable = chromePath;
    try {
      externalSourceVersion = execFileSync(chromePath, ['--version'], {
        encoding: 'utf8', windowsHide: true, timeout: 3_000,
      }).trim();
    } catch { externalSourceVersion = ''; }
    externalSourceProfile = path.join(os.tmpdir(), `jump-stream-benchmark-chrome-${process.pid}`);
    fs.mkdirSync(externalSourceProfile, { recursive: true });
    const fixtureUrl = new URL(pathToFileURL(fixturePath));
    fixtureUrl.searchParams.set('fps', String(config.sourceFps));
    fixtureUrl.searchParams.set('seed', String(config.sourceSeed));
    fixtureUrl.searchParams.set('gpuLoad', String(config.gpuLoad));
    fixtureUrl.searchParams.set('title', sourceTitle);
    const chromeArgs = [
      `--user-data-dir=${externalSourceProfile}`,
      '--no-first-run',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      `--app=${fixtureUrl.href}`,
      `--window-size=${config.sourceWidth},${config.sourceHeight}`,
      '--window-position=0,0',
    ];
    if (config.captureType === 'screen') chromeArgs.push('--start-fullscreen');
    externalSourceProcess = spawn(chromePath, chromeArgs, {
      cwd: projectRoot,
      stdio: 'ignore',
      windowsHide: false,
    });
  } else {
    let ffplayPath = '';
    try {
      ffplayPath = execFileSync('where.exe', ['ffplay.exe'], {
        encoding: 'utf8',
        windowsHide: true,
      }).split(/\r?\n/).find(Boolean) || '';
    } catch { /* Report a focused error below. */ }
    if (!ffplayPath) throw new Error('ffplay.exe não encontrado para a fonte WGC externa.');
    externalSourceExecutable = ffplayPath;
    try {
      externalSourceVersion = execFileSync(ffplayPath, ['-version'], {
        encoding: 'utf8', windowsHide: true, timeout: 3_000,
      }).split(/\r?\n/)[0].trim();
    } catch { externalSourceVersion = ''; }
    const ffplayArgs = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-f', 'lavfi',
      '-i', `testsrc2=size=${config.sourceWidth}x${config.sourceHeight}:rate=${config.sourceFps}`,
      '-window_title', sourceTitle,
      '-noborder',
      '-an',
    ];
    if (config.captureType === 'screen') ffplayArgs.push('-fs');
    externalSourceProcess = spawn(ffplayPath, ffplayArgs, {
      cwd: projectRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: false,
    });
    externalSourceProcess.stderr.on('data', (chunk) => { sourceError += chunk.toString(); });
  }
  const fixture = {
    external: true,
    epochMs: performance.now(),
    drawnFrames: 0,
    skippedSlots: 0,
    snapshot() {
      const nowMs = performance.now();
      const frameId = Math.max(0, Math.floor(((nowMs - this.epochMs) * config.sourceFps) / 1000));
      return {
        targetFps: config.sourceFps,
        seed: config.sourceSeed,
        epochMs: this.epochMs,
        nowMs,
        frameId,
        drawnFrames: null,
        clockFrameId: frameId,
        skippedSlots: null,
        lastDrawMs: nowMs,
        width: null,
        height: null,
        declaredWidth: config.sourceWidth,
        declaredHeight: config.sourceHeight,
        external: true,
        frameCountEstimated: true,
      };
    },
    reset() {
      this.epochMs = performance.now();
      return this.snapshot();
    },
  };
  await waitFor(async () => {
    if (externalSourceProcess.exitCode !== null) {
      throw new Error(sourceError || `fonte externa encerrou com ${externalSourceProcess.exitCode}`);
    }
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    return sources.some((source) => source.name === sourceTitle || source.name.includes(sourceTitle));
  }, 'janela de movimento externa', 20_000);
  return fixture;
}

async function createParticipant(role, index) {
  const primaryDisplay = screen.getPrimaryDisplay();
  const alternateDisplay = config.captureType === 'screen' && role === 'receiver'
    ? screen.getAllDisplays().find((display) => display.id !== primaryDisplay.id)
    : null;
  const workArea = (alternateDisplay || primaryDisplay).workArea;
  const isolatedOffscreenReceiver = role === 'receiver'
    && config.captureType === 'screen' && !alternateDisplay;
  const receiverVisible = role === 'receiver';
  const participant = new BrowserWindow({
    title: `JUMP Benchmark ${role}`,
    show: false,
    width: Math.min(1180, workArea.width),
    height: Math.min(820, workArea.height),
    x: isolatedOffscreenReceiver
      ? primaryDisplay.bounds.x + primaryDisplay.bounds.width + 128
      : workArea.x + Math.max(0, workArea.width - Math.min(1180, workArea.width)),
    y: workArea.y,
    backgroundColor: '#030604',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      partition: `jump-stream-benchmark-${process.pid}-${index}`,
      preload: path.join(projectRoot, 'electron', 'preload.cjs'),
    },
  });
  participant.webContents.session.setPermissionCheckHandler(() => true);
  participant.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(true));
  windows.push(participant);
  await participant.loadURL(`http://127.0.0.1:${port}/?room=${encodeURIComponent(room)}&meshDebug=1`);
  if (receiverVisible) {
    participant.showInactive();
    if (isolatedOffscreenReceiver) {
      const bounds = participant.getBounds();
      const overlapsDisplay = screen.getAllDisplays().some((display) => (
        bounds.x < display.bounds.x + display.bounds.width
        && bounds.x + bounds.width > display.bounds.x
        && bounds.y < display.bounds.y + display.bounds.height
        && bounds.y + bounds.height > display.bounds.y
      ));
      if (overlapsDisplay) throw new Error('Receiver offscreen intersectou um display capturado.');
    }
  }
  return participant;
}

function networkThroughputBytesPerSecond(kbps) {
  return kbps > 0 ? (kbps * 1_000) / 8 : -1;
}

function networkConditionParameters() {
  return {
    latency: networkEmulation.latencyMs,
    downloadThroughput: networkThroughputBytesPerSecond(networkEmulation.downloadKbps),
    uploadThroughput: networkThroughputBytesPerSecond(networkEmulation.uploadKbps),
    packetLoss: networkEmulation.packetLossPercent,
    packetQueueLength: networkEmulation.packetQueueLength,
    packetReordering: networkEmulation.packetReordering,
  };
}

async function applyNetworkEmulation(participant, target) {
  if (!networkEmulation.enabled) return;
  const devtools = participant.webContents.debugger;
  try {
    if (!devtools.isAttached()) devtools.attach('1.3');
    attachedDebuggers.add(devtools);
    await devtools.sendCommand('Network.enable');
    const conditions = networkConditionParameters();
    try {
      const result = await devtools.sendCommand('Network.emulateNetworkConditionsByRule', {
        offline: false,
        emulateOfflineServiceWorker: false,
        matchedNetworkConditions: [{
          urlPattern: '',
          offline: false,
          ...conditions,
        }],
      });
      networkEmulationState.mode = 'Network.emulateNetworkConditionsByRule';
      networkEmulationState.ruleIds = result?.ruleIds || [];
    } catch (error) {
      networkEmulationState.fallbackReason = String(error?.message || error);
      await devtools.sendCommand('Network.emulateNetworkConditions', {
        offline: false,
        ...conditions,
      });
      networkEmulationState.mode = 'Network.emulateNetworkConditions';
    }
    networkEmulationState.active = true;
    networkEmulationState.target = target;
    progress(`emulação de rede ativa em ${target}: perda ${networkEmulation.packetLossPercent}%, latência ${networkEmulation.latencyMs} ms, fila ${networkEmulation.packetQueueLength || 'ilimitada'}, upload ${networkEmulation.uploadKbps || 'ilimitado'} kbps`);
  } catch (error) {
    networkEmulationState.error = String(error?.message || error);
    throw new Error(`Falha ao ativar emulação WebRTC no benchmark: ${networkEmulationState.error}`);
  }
}

async function releaseNetworkEmulation() {
  for (const devtools of attachedDebuggers) {
    if (!devtools.isAttached()) continue;
    try {
      await devtools.sendCommand('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
        packetLoss: 0,
        packetQueueLength: 0,
        packetReordering: false,
      });
    } catch { /* Detaching also clears target-scoped emulation. */ }
    try { devtools.detach(); } catch { /* Target may already be gone. */ }
  }
  attachedDebuggers.clear();
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

const INSTALL_STATS_SAMPLER = String.raw`(() => {
  if (globalThis.__jumpBenchmarkSample) return true;
  const pick = (report, fields) => {
    if (!report) return null;
    const result = {};
    for (const field of fields) {
      const value = report[field];
      if (value !== undefined) result[field] = value;
    }
    return result;
  };
  const kindOf = (report) => report?.kind || report?.mediaType || '';
  const largest = (reports, field) => [...reports].sort((left, right) => Number(right?.[field] || 0) - Number(left?.[field] || 0))[0] || null;
  const sourceFields = ['id', 'timestamp', 'trackIdentifier', 'kind', 'width', 'height', 'frames', 'framesPerSecond'];
  const outboundFields = [
    'id', 'timestamp', 'ssrc', 'kind', 'mid', 'active', 'codecId', 'mediaSourceId', 'remoteId', 'transportId',
    'bytesSent', 'headerBytesSent', 'packetsSent', 'retransmittedBytesSent', 'retransmittedPacketsSent',
    'framesEncoded', 'framesSent', 'hugeFramesSent', 'keyFramesEncoded', 'framesPerSecond', 'frameWidth', 'frameHeight',
    'qpSum', 'totalEncodeTime', 'totalEncodedBytesTarget', 'totalPacketSendDelay', 'targetBitrate',
    'qualityLimitationReason', 'qualityLimitationDurations', 'qualityLimitationResolutionChanges',
    'nackCount', 'firCount', 'pliCount', 'encoderImplementation', 'powerEfficientEncoder', 'scalabilityMode',
  ];
  const inboundFields = [
    'id', 'timestamp', 'ssrc', 'kind', 'mid', 'codecId', 'remoteId', 'transportId',
    'bytesReceived', 'headerBytesReceived', 'packetsReceived', 'packetsLost', 'packetsDiscarded', 'jitter',
    'framesReceived', 'framesDecoded', 'framesRendered', 'framesDropped', 'keyFramesDecoded', 'framesPerSecond',
    'frameWidth', 'frameHeight', 'qpSum', 'totalDecodeTime', 'totalProcessingDelay',
    'totalInterFrameDelay', 'totalSquaredInterFrameDelay', 'freezeCount', 'totalFreezesDuration',
    'pauseCount', 'totalPausesDuration', 'jitterBufferDelay', 'jitterBufferTargetDelay',
    'jitterBufferMinimumDelay', 'jitterBufferEmittedCount', 'estimatedPlayoutTimestamp',
    'nackCount', 'firCount', 'pliCount', 'decoderImplementation', 'powerEfficientDecoder',
    'framesAssembledFromMultiplePackets', 'totalAssemblyTime', 'retransmittedBytesReceived',
  ];
  const remoteInboundFields = [
    'id', 'timestamp', 'ssrc', 'kind', 'codecId', 'localId', 'transportId', 'packetsLost', 'jitter',
    'roundTripTime', 'totalRoundTripTime', 'roundTripTimeMeasurements', 'fractionLost',
  ];
  const remoteOutboundFields = [
    'id', 'timestamp', 'ssrc', 'kind', 'codecId', 'localId', 'transportId', 'bytesSent', 'packetsSent',
    'remoteTimestamp', 'reportsSent', 'roundTripTime', 'totalRoundTripTime',
  ];
  const pairFields = [
    'id', 'timestamp', 'state', 'nominated', 'writable', 'bytesSent', 'bytesReceived',
    'currentRoundTripTime', 'totalRoundTripTime', 'responsesReceived', 'availableOutgoingBitrate',
    'availableIncomingBitrate', 'requestsReceived', 'requestsSent', 'localCandidateId', 'remoteCandidateId',
    'packetsDiscardedOnSend', 'bytesDiscardedOnSend',
  ];
  const candidateFields = ['id', 'timestamp', 'candidateType', 'protocol', 'networkType', 'address', 'port', 'priority', 'url', 'relayProtocol'];
  const codecFields = ['id', 'timestamp', 'payloadType', 'mimeType', 'clockRate', 'channels', 'sdpFmtpLine'];
  const transportFields = ['id', 'timestamp', 'bytesSent', 'bytesReceived', 'packetsSent', 'packetsReceived', 'selectedCandidatePairId', 'dtlsState', 'iceRole'];

  globalThis.__jumpBenchmarkSample = async (role) => {
    const peers = [...(globalThis.__jumpPeerMesh?.peerConnectionsRef.current || [])];
    if (!peers.length) return null;
    let selected = null;
    for (const [peerId, slot] of peers) {
      const reports = await slot.pc.getStats();
      const values = [...reports.values()];
      const outbound = largest(values.filter((report) => report.type === 'outbound-rtp' && kindOf(report) === 'video' && !report.isRemote), 'bytesSent');
      const inbound = largest(values.filter((report) => report.type === 'inbound-rtp' && kindOf(report) === 'video' && !report.isRemote), 'bytesReceived');
      const score = role === 'sender' ? Number(outbound?.bytesSent || 0) : Number(inbound?.bytesReceived || 0);
      if (!selected || score > selected.score) selected = { peerId, slot, reports, values, outbound, inbound, score };
    }
    if (!selected) return null;
    const { peerId, slot, reports, values, outbound, inbound } = selected;
    const source = outbound?.mediaSourceId ? reports.get(outbound.mediaSourceId) : largest(values.filter((report) => report.type === 'media-source' && kindOf(report) === 'video'), 'frames');
    const remoteInbound = outbound?.remoteId ? reports.get(outbound.remoteId) : largest(values.filter((report) => report.type === 'remote-inbound-rtp' && kindOf(report) === 'video'), 'reportsReceived');
    const remoteOutbound = inbound?.remoteId ? reports.get(inbound.remoteId) : largest(values.filter((report) => report.type === 'remote-outbound-rtp' && kindOf(report) === 'video'), 'reportsSent');
    const mediaReport = role === 'sender' ? outbound : inbound;
    const codec = mediaReport?.codecId ? reports.get(mediaReport.codecId) : null;
    const transport = mediaReport?.transportId ? reports.get(mediaReport.transportId) : values.find((report) => report.type === 'transport');
    const pair = transport?.selectedCandidatePairId
      ? reports.get(transport.selectedCandidatePairId)
      : values.find((report) => report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded');
    const localCandidate = pair?.localCandidateId ? reports.get(pair.localCandidateId) : null;
    const remoteCandidate = pair?.remoteCandidateId ? reports.get(pair.remoteCandidateId) : null;
    const senderTrack = slot.videoSender?.track || null;
    const receiverTrack = slot.videoTransceiver?.receiver?.track
      || slot.pc.getReceivers().find((receiver) => receiver.track?.kind === 'video')?.track
      || null;
    const track = role === 'sender' ? senderTrack : receiverTrack;
    let senderParameters = null;
    if (role === 'sender' && slot.videoSender?.getParameters) {
      const parameters = slot.videoSender.getParameters();
      senderParameters = {
        degradationPreference: parameters.degradationPreference,
        transactionId: parameters.transactionId,
        encodings: (parameters.encodings || []).map((encoding) => ({
          active: encoding.active,
          maxBitrate: encoding.maxBitrate,
          minBitrate: encoding.minBitrate,
          maxFramerate: encoding.maxFramerate,
          scaleResolutionDownBy: encoding.scaleResolutionDownBy,
          priority: encoding.priority,
          networkPriority: encoding.networkPriority,
          scalabilityMode: encoding.scalabilityMode,
        })),
      };
    }
    return {
      collectedAt: performance.timeOrigin + performance.now(),
      role,
      peerId,
      connectionState: slot.pc.connectionState,
      iceConnectionState: slot.pc.iceConnectionState,
      signalingState: slot.pc.signalingState,
      track: track ? {
        id: track.id,
        label: track.label,
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState,
        settings: { ...track.getSettings?.() },
        constraints: { ...track.getConstraints?.() },
      } : null,
      senderParameters,
      adaptation: slot.videoAdaptation ? { ...slot.videoAdaptation } : null,
      jitterBufferTarget: slot.videoTransceiver?.receiver && 'jitterBufferTarget' in slot.videoTransceiver.receiver
        ? slot.videoTransceiver.receiver.jitterBufferTarget
        : null,
      reports: {
        source: pick(source, sourceFields),
        outbound: pick(outbound, outboundFields),
        remoteInbound: pick(remoteInbound, remoteInboundFields),
        inbound: pick(inbound, inboundFields),
        remoteOutbound: pick(remoteOutbound, remoteOutboundFields),
        codec: pick(codec, codecFields),
        transport: pick(transport, transportFields),
        candidatePair: pick(pair, pairFields),
        localCandidate: pick(localCandidate, candidateFields),
        remoteCandidate: pick(remoteCandidate, candidateFields),
      },
    };
  };
  return true;
})()`;

const INSTALL_RENDER_RECORDER = String.raw`(() => {
  globalThis.__jumpBenchmarkRender?.stop?.();
  const finite = (value) => value === null || value === undefined || value === ''
    ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
  const state = { active: false, callbackId: 0, samples: [], video: null };
  const findVideo = () => document.querySelector('.call-stream-card:not(.is-self) video') || document.querySelector('.call-stream-card video');
  const onFrame = (now, metadata) => {
    if (!state.active) return;
    const video = state.video;
    state.samples.push({
      callbackNow: finite(now),
      absoluteCallbackTime: finite(performance.timeOrigin + now),
      expectedDisplayTime: finite(metadata.expectedDisplayTime),
      presentationTime: finite(metadata.presentationTime),
      captureTime: finite(metadata.captureTime),
      receiveTime: finite(metadata.receiveTime),
      mediaTime: finite(metadata.mediaTime),
      processingDuration: finite(metadata.processingDuration),
      presentedFrames: finite(metadata.presentedFrames),
      rtpTimestamp: finite(metadata.rtpTimestamp),
      width: finite(metadata.width),
      height: finite(metadata.height),
      videoWidth: finite(video?.videoWidth),
      videoHeight: finite(video?.videoHeight),
      currentTime: finite(video?.currentTime),
      readyState: finite(video?.readyState),
    });
    state.callbackId = video.requestVideoFrameCallback(onFrame);
  };
  const stop = () => {
    state.active = false;
    if (state.callbackId && state.video?.cancelVideoFrameCallback) state.video.cancelVideoFrameCallback(state.callbackId);
    state.callbackId = 0;
    return state.samples;
  };
  const start = () => {
    stop();
    state.samples = [];
    state.video = findVideo();
    if (!state.video?.requestVideoFrameCallback) return false;
    state.active = true;
    state.callbackId = state.video.requestVideoFrameCallback(onFrame);
    return true;
  };
  globalThis.__jumpBenchmarkRender = {
    start,
    stop,
    snapshot: () => state.samples,
  };
  return Boolean(findVideo()?.requestVideoFrameCallback);
})()`;

async function installCollectors(sender, receiver) {
  await Promise.all([
    sender.webContents.executeJavaScript(INSTALL_STATS_SAMPLER),
    receiver.webContents.executeJavaScript(INSTALL_STATS_SAMPLER),
  ]);
}

async function sampleStats(window, role) {
  return window.webContents.executeJavaScript(`globalThis.__jumpBenchmarkSample(${JSON.stringify(role)})`);
}

async function fixtureSnapshot(fixture) {
  if (fixture.external) return fixture.snapshot();
  return fixture.webContents.executeJavaScript('globalThis.__motionBenchmark.snapshot()');
}

async function fixtureReset(fixture) {
  if (fixture.external) return fixture.reset();
  return fixture.webContents.executeJavaScript('globalThis.__motionBenchmark.reset()');
}

function decodeGrayFrameId(bitmap, width, height, expectedFrameId = null) {
  const bits = 20;
  const cellWidth = Math.max(4, Math.floor(width / bits));
  const cellHeight = Math.max(18, Math.floor(height * 0.045));
  const preferredY = Math.max(0, Math.min(height - 1, Math.floor((height * 0.71) + (cellHeight / 2))));
  const rowStep = Math.max(1, Math.floor(height / 540));
  const rows = [preferredY];
  for (let y = 0; y < height; y += rowStep) if (Math.abs(y - preferredY) > rowStep) rows.push(y);
  let best = { frameId: null, row: null, confidence: -1 };
  for (const y of rows) {
    let gray = 0;
    let confidence = 0;
    for (let bit = 0; bit < bits; bit += 1) {
      const x = Math.max(0, Math.min(width - 1, Math.floor((bit + 0.5) * cellWidth)));
      const offset = ((y * width) + x) * 4;
      // nativeImage bitmaps are BGRA on Windows; the marker is grayscale, so
      // channel order is irrelevant for its threshold.
      const luminance = (bitmap[offset] + bitmap[offset + 1] + bitmap[offset + 2]) / 3;
      confidence += Math.abs(luminance - 128);
      if (luminance >= 128) gray |= (1 << bit);
    }
    let binary = gray >>> 0;
    binary ^= binary >>> 1;
    binary ^= binary >>> 2;
    binary ^= binary >>> 4;
    binary ^= binary >>> 8;
    binary ^= binary >>> 16;
    const decoded = { frameId: binary >>> 0, row: y, confidence: confidence / bits };
    if (expectedFrameId !== null && decoded.frameId === expectedFrameId && decoded.confidence >= 32) return decoded;
    if (decoded.confidence > best.confidence) best = decoded;
  }
  return best;
}

function bitmapFromDataUrl(frame, label) {
  const image = nativeImage.createFromDataURL(frame?.dataUrl || '');
  if (image.isEmpty()) throw new Error(`${label}: PNG vazio`);
  const size = image.getSize();
  if (size.width !== frame.width || size.height !== frame.height) {
    throw new Error(`${label}: dimensões PNG ${size.width}x${size.height}, esperadas ${frame.width}x${frame.height}`);
  }
  return image.toBitmap();
}

async function captureReceiverFrame(receiver, width, height) {
  return receiver.webContents.executeJavaScript(`(() => {
    const video = document.querySelector('.call-stream-card:not(.is-self) video')
      || document.querySelector('.call-stream-card video');
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = ${JSON.stringify(width)};
    canvas.height = ${JSON.stringify(height)};
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return {
      dataUrl: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      totalVideoFrames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
    };
  })()`);
}

async function captureDesktopReference(captureSource, width, height) {
  const sources = await desktopCapturer.getSources({
    types: [captureSource.type],
    thumbnailSize: { width, height },
  });
  const source = sources.find((candidate) => candidate.id === captureSource.id);
  if (!source || source.thumbnail?.isEmpty?.()) throw new Error('thumbnail da fonte de referência ausente');
  const image = source.thumbnail.getSize().width === width && source.thumbnail.getSize().height === height
    ? source.thumbnail
    : source.thumbnail.resize({ width, height, quality: 'best' });
  return { dataUrl: image.toDataURL(), width, height };
}

async function measureVisualQuality(fixture, receiver, captureSource) {
  if (config.qualitySamples <= 0) return { available: false, valid: false, reason: 'disabled' };
  if (fixture.external) {
    return { available: false, valid: false, reason: 'external-source-reference-unavailable' };
  }
  const samples = [];
  const errors = [];
  try {
    for (let index = 0; index < config.qualitySamples; index += 1) {
      const frameId = 4_242 + (index * 137);
      await fixture.webContents.executeJavaScript(`globalThis.__motionBenchmark.freeze(${JSON.stringify(frameId)})`);
      await wait(100);
      const referenceFrame = await captureDesktopReference(
        captureSource,
        config.qualityWidth,
        config.qualityHeight,
      );
      const referenceBitmap = bitmapFromDataUrl(referenceFrame, 'referência');
      const decodedReference = decodeGrayFrameId(
        referenceBitmap,
        config.qualityWidth,
        config.qualityHeight,
        frameId,
      );
      if (decodedReference.frameId !== frameId) {
        errors.push(`reference-alignment:${frameId}->${decodedReference.frameId ?? 'none'}@${decodedReference.row ?? 'none'}`);
        continue;
      }
      const deadline = Date.now() + Math.max(3_000, config.qualitySettleMs * 4);
      let candidateFrame = null;
      let candidateBitmap = null;
      let decodedFrame = null;
      await wait(config.qualitySettleMs);
      while (Date.now() < deadline) {
        candidateFrame = await captureReceiverFrame(receiver, config.qualityWidth, config.qualityHeight);
        if (candidateFrame) {
          candidateBitmap = bitmapFromDataUrl(candidateFrame, 'receptor');
          decodedFrame = decodeGrayFrameId(candidateBitmap, config.qualityWidth, config.qualityHeight, frameId);
          if (decodedFrame.frameId === frameId) break;
        }
        await wait(150);
      }
      if (!candidateBitmap || decodedFrame?.frameId !== frameId) {
        errors.push(`frame-alignment:${frameId}->${decodedFrame?.frameId ?? 'none'}@${decodedFrame?.row ?? 'none'}`);
        continue;
      }
      const comparison = compareRgba(referenceBitmap, candidateBitmap, {
        width: config.qualityWidth,
        height: config.qualityHeight,
        blockSize: 16,
      });
      const blockSsim = comparison.blocks.map((block) => block.ssim);
      samples.push({
        frameId,
        decodedFrameId: decodedFrame.frameId,
        decodedMarkerRow: decodedFrame.row,
        decodedMarkerConfidence: decodedFrame.confidence,
        receiverFrameWidth: candidateFrame.videoWidth,
        receiverFrameHeight: candidateFrame.videoHeight,
        global: comparison.global,
        blockAverage: comparison.blockAverage,
        blockSsim: {
          min: blockSsim.length ? Math.min(...blockSsim) : null,
          p05: quantile(blockSsim, 0.05),
          p50: quantile(blockSsim, 0.50),
          p95: quantile(blockSsim, 0.95),
        },
      });
    }
  } finally {
    await fixtureReset(fixture).catch(() => {});
  }
  const ssimValues = samples.map((sample) => sample.global.ssim);
  const psnrValues = samples.map((sample) => sample.global.psnrDb).filter(Number.isFinite);
  return {
    available: samples.length > 0,
    valid: samples.length === config.qualitySamples && errors.length === 0,
    reason: errors.length ? 'frame-alignment-failed' : null,
    width: config.qualityWidth,
    height: config.qualityHeight,
    requestedSamples: config.qualitySamples,
    samplesMeasured: samples.length,
    alignedBy: '20-bit-gray-frame-id',
    reference: 'desktopCapturer-thumbnail-before-webrtc-encode',
    pixelFormat: 'nativeImage-bgra-alpha-ignored',
    ssim: distribution(ssimValues),
    psnrDb: distribution(psnrValues),
    errors,
    samples,
  };
}

function rendererPid(window) {
  if (!window?.webContents || window.webContents.isDestroyed()) return null;
  try { return window.webContents.getOSProcessId(); } catch { return null; }
}

function knownProcessRoles({ fixture, sender, receiver }) {
  const roles = new Map([[process.pid, 'main']]);
  const fixturePid = fixture?.external ? externalSourceProcess?.pid : rendererPid(fixture);
  if (fixturePid) roles.set(fixturePid, fixture?.external ? 'fixture-external' : 'fixture-renderer');
  const senderPid = rendererPid(sender);
  const receiverPid = rendererPid(receiver);
  if (senderPid) roles.set(senderPid, 'sender-renderer');
  if (receiverPid) roles.set(receiverPid, 'receiver-renderer');
  if (signalingProcess?.pid) roles.set(signalingProcess.pid, 'signaling-server');
  return roles;
}

function normalizeAppMetric(metric, knownRoles) {
  const pid = finiteOrNull(metric.pid);
  const type = String(metric.type || 'unknown');
  const loweredType = type.toLowerCase();
  let role = knownRoles.get(pid) || null;
  if (!role && loweredType.includes('gpu')) role = 'gpu-process';
  if (!role && loweredType.includes('utility')) role = 'utility-process';
  if (!role) role = `electron-${loweredType.replace(/\s+/g, '-')}`;
  return {
    pid,
    role,
    type,
    name: metric.name || null,
    serviceName: metric.serviceName || null,
    creationTime: finiteOrNull(metric.creationTime),
    sandboxed: metric.sandboxed ?? null,
    integrityLevel: metric.integrityLevel || null,
    cpu: {
      percentCPUUsage: finiteOrNull(metric.cpu?.percentCPUUsage),
      idleWakeupsPerSecond: finiteOrNull(metric.cpu?.idleWakeupsPerSecond),
    },
    memoryKiB: {
      workingSet: finiteOrNull(metric.memory?.workingSetSize),
      peakWorkingSet: finiteOrNull(metric.memory?.peakWorkingSetSize),
      private: finiteOrNull(metric.memory?.privateBytes),
      shared: finiteOrNull(metric.memory?.sharedBytes),
    },
  };
}

async function sampleResources(context, includeNvidia = true) {
  const knownRoles = knownProcessRoles(context);
  let electronProcesses = [];
  try {
    electronProcesses = app.getAppMetrics().map((metric) => normalizeAppMetric(metric, knownRoles));
  } catch { /* Keep WebRTC benchmark independent from resource APIs. */ }

  let cpu = null;
  try {
    const usage = process.getCPUUsage?.();
    if (usage) {
      cpu = {
        percentCPUUsage: finiteOrNull(usage.percentCPUUsage),
        idleWakeupsPerSecond: finiteOrNull(usage.idleWakeupsPerSecond),
      };
    }
  } catch { /* Optional Electron main-process metric. */ }

  let systemMemoryKiB = null;
  try {
    const memory = process.getSystemMemoryInfo?.();
    if (memory) {
      systemMemoryKiB = Object.fromEntries(
        Object.entries(memory).map(([key, value]) => [key, finiteOrNull(value)]),
      );
    }
  } catch { /* Optional Electron system metric. */ }

  let nodeMemoryBytes = null;
  try {
    nodeMemoryBytes = Object.fromEntries(
      Object.entries(process.memoryUsage()).map(([key, value]) => [key, finiteOrNull(value)]),
    );
  } catch { /* Optional Node fallback metric. */ }

  const memoryPromise = typeof process.getProcessMemoryInfo === 'function'
    ? process.getProcessMemoryInfo().catch(() => null)
    : Promise.resolve(null);
  const nvidiaPromise = includeNvidia ? sampleNvidiaSmi() : Promise.resolve(null);
  const [processMemory, nvidia] = await Promise.all([memoryPromise, nvidiaPromise]);
  const processMemoryKiB = processMemory
    ? Object.fromEntries(Object.entries(processMemory).map(([key, value]) => [key, finiteOrNull(value)]))
    : null;

  return {
    collectedAt: performance.now(),
    wallTime: new Date().toISOString(),
    electronProcesses,
    mainProcess: {
      pid: process.pid,
      cpu,
      memoryKiB: processMemoryKiB,
      nodeMemoryBytes,
    },
    systemMemoryKiB,
    nvidia,
  };
}

async function ensureFixtureSource() {
  const sources = await desktopCapturer.getSources({
    types: [config.captureType],
    thumbnailSize: { width: 0, height: 0 },
  });
  let source = null;
  let selectionValidation = 'exact-window-title';
  if (config.captureType === 'screen') {
    const primaryDisplayId = String(screen.getPrimaryDisplay().id);
    source = sources.find((candidate) => String(candidate.display_id || '') === primaryDisplayId) || null;
    selectionValidation = 'display-id';
    if (!source && sources.length === 1 && screen.getAllDisplays().length === 1) {
      // Some Windows builds omit display_id. This fallback is unambiguous only
      // when both Electron and the OS expose exactly one screen.
      [source] = sources;
      selectionValidation = 'single-display-unambiguous';
    }
  } else {
    source = sources.find((candidate) => candidate.name === sourceTitle || candidate.name.includes(sourceTitle));
  }
  if (!source) {
    throw new Error(`Fonte ${config.captureType} do benchmark ausente. Fontes: ${sources.map((item) => `${item.id}:${item.name}`).join(', ')}`);
  }
  return {
    id: source.id,
    name: source.name,
    type: source.id.startsWith('window:') ? 'window' : 'screen',
    displayId: source.display_id || '',
    selectionValidation,
  };
}

async function joinCall(window) {
  await click(window, 'button[aria-label="Abrir chamada"]');
  await click(window, '.join-call-button');
  await waitFor(() => count(window, '.leave-button').then((value) => value === 1), 'entrada na chamada');
}

async function startShare(sender, receiver, profile, captureSource) {
  const sourceName = captureSource.name;
  const sourceKind = captureSource.type === 'screen' ? 'tela inteira' : 'janela';
  await click(sender, 'button[aria-label="Compartilhar tela"]');
  await waitFor(() => sender.webContents.executeJavaScript(`(() => [...document.querySelectorAll('.screen-share-source')].some((card) => (
    card.querySelector('strong')?.textContent.trim() === ${JSON.stringify(sourceName)}
      && card.querySelector('small')?.textContent.trim() === ${JSON.stringify(sourceKind)}
  )))()`), `fonte descoberta ${captureSource.id} no seletor`);
  const configured = await sender.webContents.executeJavaScript(`(() => {
    const profileName = ${JSON.stringify(profile === 'performance' ? 'desempenho' : 'qualidade')};
    const profileButton = [...document.querySelectorAll('.screen-share-quality button')]
      .find((button) => button.textContent.toLowerCase().includes(profileName));
    const sourceCard = [...document.querySelectorAll('.screen-share-source')]
      .find((card) => (
        card.querySelector('strong')?.textContent.trim() === ${JSON.stringify(sourceName)}
          && card.querySelector('small')?.textContent.trim() === ${JSON.stringify(sourceKind)}
      ));
    if (!profileButton || !sourceCard) return false;
    profileButton.click();
    sourceCard.click();
    return true;
  })()`);
  if (!configured) throw new Error(`Não foi possível selecionar fonte/perfil ${profile}.`);
  await click(sender, '.screen-share-actions .dialog-primary');
  await waitFor(() => count(sender, 'button[aria-label="Parar compartilhamento"]').then(Boolean), 'compartilhamento local ativo');
  await waitFor(() => count(receiver, '.call-stream-card:not(.is-self) video').then(Boolean), 'vídeo remoto renderizado', 30_000);
  await receiver.webContents.executeJavaScript(INSTALL_RENDER_RECORDER);
  await waitFor(async () => {
    const [senderSample, receiverSample] = await Promise.all([
      sampleStats(sender, 'sender'),
      sampleStats(receiver, 'receiver'),
    ]);
    return Number(senderSample?.reports?.outbound?.framesEncoded) > 0
      && Number(receiverSample?.reports?.inbound?.framesDecoded) > 0;
  }, 'RTP de vídeo mensurável', 30_000);
}

async function stopShare(sender, receiver) {
  const renderSamples = await receiver.webContents.executeJavaScript('globalThis.__jumpBenchmarkRender?.stop?.() || []').catch(() => []);
  if (await count(sender, 'button[aria-label="Parar compartilhamento"]')) {
    await click(sender, 'button[aria-label="Parar compartilhamento"]');
  }
  await waitFor(() => count(sender, 'button[aria-label="Parar compartilhamento"]').then((value) => value === 0), 'fim do compartilhamento');
  await wait(500);
  return renderSamples;
}

function quantile(values, percentile) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (index - lower));
}

function median(values) {
  return quantile(values, 0.5);
}

function distribution(values) {
  const finiteValues = values.map(finiteOrNull).filter((value) => value !== null);
  const mean = finiteValues.length
    ? finiteValues.reduce((total, value) => total + value, 0) / finiteValues.length
    : null;
  const standardDeviation = mean === null ? null : Math.sqrt(
    finiteValues.reduce((total, value) => total + ((value - mean) ** 2), 0) / finiteValues.length,
  );
  return {
    count: finiteValues.length,
    mean,
    standardDeviation,
    coefficientOfVariation: mean && standardDeviation !== null ? standardDeviation / Math.abs(mean) : null,
    min: finiteValues.length ? Math.min(...finiteValues) : null,
    p05: quantile(finiteValues, 0.05),
    p50: quantile(finiteValues, 0.5),
    p95: quantile(finiteValues, 0.95),
    max: finiteValues.length ? Math.max(...finiteValues) : null,
  };
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function delta(first, last, field) {
  const left = finiteOrNull(first?.[field]);
  const right = finiteOrNull(last?.[field]);
  if (left === null || right === null || right < left) return null;
  return right - left;
}

function divide(numerator, denominator, multiplier = 1) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return (numerator * multiplier) / denominator;
}

function series(samples, reportName, field) {
  return samples.map((sample) => finiteOrNull(sample?.reports?.[reportName]?.[field])).filter((value) => value !== null);
}

function intervalCounterSeries(samples, reportName, field, multiplier = 1) {
  const values = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const elapsedSeconds = divide(current.collectedAt - previous.collectedAt, 1000);
    const counterDelta = delta(previous?.reports?.[reportName], current?.reports?.[reportName], field);
    const rate = divide(counterDelta, elapsedSeconds, multiplier);
    if (rate !== null) values.push(rate);
  }
  return values;
}

function intervalAverageSeries(samples, reportName, totalField, countField, multiplier = 1) {
  const values = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previousReport = samples[index - 1]?.reports?.[reportName];
    const currentReport = samples[index]?.reports?.[reportName];
    const totalDelta = delta(previousReport, currentReport, totalField);
    const countDelta = delta(previousReport, currentReport, countField);
    const average = divide(totalDelta, countDelta, multiplier);
    if (average !== null) values.push(average);
  }
  return values;
}

function intervalLossRatioSeries(samples, reportName, lostField, receivedField) {
  const values = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previousReport = samples[index - 1]?.reports?.[reportName];
    const currentReport = samples[index]?.reports?.[reportName];
    const lost = delta(previousReport, currentReport, lostField);
    const received = delta(previousReport, currentReport, receivedField);
    if (lost === null || received === null || lost + received <= 0) continue;
    values.push(lost / (lost + received));
  }
  return values;
}

function summarizeResources(resourceSamples) {
  const processGroups = new Map();
  const globalSeries = {
    processCount: [],
    cpuPercentSum: [],
    workingSetMiBSum: [],
    privateMemoryMiBSum: [],
    systemFreeMemoryMiB: [],
  };
  const mainSeries = {
    cpuPercent: [],
    idleWakeupsPerSecond: [],
    residentSetMiB: [],
    privateMemoryMiB: [],
    sharedMemoryMiB: [],
    rssMiB: [],
    heapUsedMiB: [],
  };
  const nvidiaSeries = {
    gpuUtilizationPercentMax: [],
    encoderUtilizationPercentMax: [],
    decoderUtilizationPercentMax: [],
    memoryUsedMiBSum: [],
    powerDrawWattsSum: [],
    temperatureCelsiusMax: [],
    graphicsClockMHzMax: [],
    memoryClockMHzMax: [],
  };
  const gpuGroups = new Map();

  const numeric = (value) => finiteOrNull(value);
  const sum = (values) => {
    const finiteValues = values.map(numeric).filter((value) => value !== null);
    return finiteValues.length ? finiteValues.reduce((total, value) => total + value, 0) : null;
  };
  const max = (values) => {
    const finiteValues = values.map(numeric).filter((value) => value !== null);
    return finiteValues.length ? Math.max(...finiteValues) : null;
  };
  const push = (target, value) => {
    const finite = numeric(value);
    if (finite !== null) target.push(finite);
  };

  for (const sample of resourceSamples) {
    const metrics = sample.electronProcesses || [];
    push(globalSeries.processCount, metrics.length);
    push(globalSeries.cpuPercentSum, sum(metrics.map((metric) => metric.cpu?.percentCPUUsage)));
    push(globalSeries.workingSetMiBSum, sum(metrics.map((metric) => divide(metric.memoryKiB?.workingSet, 1024))));
    push(globalSeries.privateMemoryMiBSum, sum(metrics.map((metric) => divide(metric.memoryKiB?.private, 1024))));
    push(globalSeries.systemFreeMemoryMiB, divide(sample.systemMemoryKiB?.free, 1024));

    push(mainSeries.cpuPercent, sample.mainProcess?.cpu?.percentCPUUsage);
    push(mainSeries.idleWakeupsPerSecond, sample.mainProcess?.cpu?.idleWakeupsPerSecond);
    push(mainSeries.residentSetMiB, divide(sample.mainProcess?.memoryKiB?.residentSet, 1024));
    push(mainSeries.privateMemoryMiB, divide(sample.mainProcess?.memoryKiB?.private, 1024));
    push(mainSeries.sharedMemoryMiB, divide(sample.mainProcess?.memoryKiB?.shared, 1024));
    push(mainSeries.rssMiB, divide(sample.mainProcess?.nodeMemoryBytes?.rss, 1024 * 1024));
    push(mainSeries.heapUsedMiB, divide(sample.mainProcess?.nodeMemoryBytes?.heapUsed, 1024 * 1024));

    for (const metric of metrics) {
      const key = String(metric.pid ?? `${metric.role}:${metric.type}`);
      if (!processGroups.has(key)) {
        processGroups.set(key, {
          pid: metric.pid,
          role: metric.role,
          type: metric.type,
          name: metric.name,
          serviceName: metric.serviceName,
          cpuPercent: [],
          idleWakeupsPerSecond: [],
          workingSetMiB: [],
          peakWorkingSetMiB: [],
          privateMemoryMiB: [],
          sharedMemoryMiB: [],
        });
      }
      const group = processGroups.get(key);
      push(group.cpuPercent, metric.cpu?.percentCPUUsage);
      push(group.idleWakeupsPerSecond, metric.cpu?.idleWakeupsPerSecond);
      push(group.workingSetMiB, divide(metric.memoryKiB?.workingSet, 1024));
      push(group.peakWorkingSetMiB, divide(metric.memoryKiB?.peakWorkingSet, 1024));
      push(group.privateMemoryMiB, divide(metric.memoryKiB?.private, 1024));
      push(group.sharedMemoryMiB, divide(metric.memoryKiB?.shared, 1024));
    }

    const gpus = sample.nvidia?.gpus || [];
    push(nvidiaSeries.gpuUtilizationPercentMax, max(gpus.map((gpu) => gpu['utilization.gpu'])));
    push(nvidiaSeries.encoderUtilizationPercentMax, max(gpus.map((gpu) => gpu['utilization.encoder'])));
    push(nvidiaSeries.decoderUtilizationPercentMax, max(gpus.map((gpu) => gpu['utilization.decoder'])));
    push(nvidiaSeries.memoryUsedMiBSum, sum(gpus.map((gpu) => gpu['memory.used'])));
    push(nvidiaSeries.powerDrawWattsSum, sum(gpus.map((gpu) => gpu['power.draw'])));
    push(nvidiaSeries.temperatureCelsiusMax, max(gpus.map((gpu) => gpu['temperature.gpu'])));
    push(nvidiaSeries.graphicsClockMHzMax, max(gpus.map((gpu) => gpu['clocks.current.graphics'])));
    push(nvidiaSeries.memoryClockMHzMax, max(gpus.map((gpu) => gpu['clocks.current.memory'])));
    for (const gpu of gpus) {
      const key = gpu.uuid || String(gpu.index);
      if (!gpuGroups.has(key)) {
        gpuGroups.set(key, {
          index: gpu.index,
          uuid: gpu.uuid,
          name: gpu.name,
          gpuUtilizationPercent: [],
          encoderUtilizationPercent: [],
          decoderUtilizationPercent: [],
          memoryUsedMiB: [],
          powerDrawWatts: [],
          temperatureCelsius: [],
        });
      }
      const group = gpuGroups.get(key);
      push(group.gpuUtilizationPercent, gpu['utilization.gpu']);
      push(group.encoderUtilizationPercent, gpu['utilization.encoder']);
      push(group.decoderUtilizationPercent, gpu['utilization.decoder']);
      push(group.memoryUsedMiB, gpu['memory.used']);
      push(group.powerDrawWatts, gpu['power.draw']);
      push(group.temperatureCelsius, gpu['temperature.gpu']);
    }
  }

  const summarizeGroup = (group, metadataKeys) => Object.fromEntries([
    ...metadataKeys.map((key) => [key, group[key]]),
    ...Object.entries(group)
      .filter(([key, values]) => !metadataKeys.includes(key) && Array.isArray(values))
      .map(([key, values]) => [key, distribution(values)]),
  ]);
  const byProcess = [...processGroups.values()]
    .map((group) => summarizeGroup(group, ['pid', 'role', 'type', 'name', 'serviceName']))
    .sort((left, right) => String(left.role).localeCompare(String(right.role)) || Number(left.pid) - Number(right.pid));
  const byGpu = [...gpuGroups.values()]
    .map((group) => summarizeGroup(group, ['index', 'uuid', 'name']))
    .sort((left, right) => Number(left.index) - Number(right.index));

  const electronProcessTree = Object.fromEntries(
    Object.entries(globalSeries).map(([key, values]) => [key, distribution(values)]),
  );
  return {
    sampleCount: resourceSamples.length,
    scope: {
      electronProcessTree: 'app.getAppMetrics; excludes external Chrome/ffplay and signaling Node process',
      nvidia: 'whole NVIDIA device; includes unrelated processes and the external source',
    },
    electronProcessTree,
    // Backward-compatible alias for schema v1 reports. It is not system-global.
    global: electronProcessTree,
    mainProcess: Object.fromEntries(Object.entries(mainSeries).map(([key, values]) => [key, distribution(values)])),
    byProcess,
    nvidia: {
      available: byGpu.length > 0,
      ...Object.fromEntries(Object.entries(nvidiaSeries).map(([key, values]) => [key, distribution(values)])),
      byGpu,
    },
  };
}

function summarizeRun(senderSamples, receiverSamples, renderSamples, sourceStart, sourceEnd, resourceSamples = []) {
  const firstSender = senderSamples[0];
  const lastSender = senderSamples.at(-1);
  const firstReceiver = receiverSamples[0];
  const lastReceiver = receiverSamples.at(-1);
  const senderSeconds = divide((lastSender?.collectedAt || 0) - (firstSender?.collectedAt || 0), 1000);
  const receiverSeconds = divide((lastReceiver?.collectedAt || 0) - (firstReceiver?.collectedAt || 0), 1000);
  const sourceSeconds = divide((sourceEnd?.nowMs || 0) - (sourceStart?.nowMs || 0), 1000);
  const sourceFrames = delta(firstSender?.reports?.source, lastSender?.reports?.source, 'frames');
  const encodedFrames = delta(firstSender?.reports?.outbound, lastSender?.reports?.outbound, 'framesEncoded');
  const sentFrames = delta(firstSender?.reports?.outbound, lastSender?.reports?.outbound, 'framesSent');
  const sentBytes = delta(firstSender?.reports?.outbound, lastSender?.reports?.outbound, 'bytesSent');
  const retransmittedBytes = delta(firstSender?.reports?.outbound, lastSender?.reports?.outbound, 'retransmittedBytesSent') || 0;
  const sentPackets = delta(firstSender?.reports?.outbound, lastSender?.reports?.outbound, 'packetsSent');
  const retransmittedPackets = delta(firstSender?.reports?.outbound, lastSender?.reports?.outbound, 'retransmittedPacketsSent');
  const encodeTime = delta(firstSender?.reports?.outbound, lastSender?.reports?.outbound, 'totalEncodeTime');
  const senderQp = delta(firstSender?.reports?.outbound, lastSender?.reports?.outbound, 'qpSum');
  const receivedFrames = delta(firstReceiver?.reports?.inbound, lastReceiver?.reports?.inbound, 'framesReceived');
  const decodedFrames = delta(firstReceiver?.reports?.inbound, lastReceiver?.reports?.inbound, 'framesDecoded');
  const renderedFrames = delta(firstReceiver?.reports?.inbound, lastReceiver?.reports?.inbound, 'framesRendered');
  const droppedFrames = delta(firstReceiver?.reports?.inbound, lastReceiver?.reports?.inbound, 'framesDropped');
  const receivedBytes = delta(firstReceiver?.reports?.inbound, lastReceiver?.reports?.inbound, 'bytesReceived');
  const receivedPackets = delta(firstReceiver?.reports?.inbound, lastReceiver?.reports?.inbound, 'packetsReceived');
  const lostPackets = delta(firstReceiver?.reports?.inbound, lastReceiver?.reports?.inbound, 'packetsLost');
  const decodeTime = delta(firstReceiver?.reports?.inbound, lastReceiver?.reports?.inbound, 'totalDecodeTime');
  const processingTime = delta(firstReceiver?.reports?.inbound, lastReceiver?.reports?.inbound, 'totalProcessingDelay');
  const jitterDelay = delta(firstReceiver?.reports?.inbound, lastReceiver?.reports?.inbound, 'jitterBufferDelay');
  const jitterTargetDelay = delta(firstReceiver?.reports?.inbound, lastReceiver?.reports?.inbound, 'jitterBufferTargetDelay');
  const jitterMinimumDelay = delta(firstReceiver?.reports?.inbound, lastReceiver?.reports?.inbound, 'jitterBufferMinimumDelay');
  const jitterEmitted = delta(firstReceiver?.reports?.inbound, lastReceiver?.reports?.inbound, 'jitterBufferEmittedCount');
  const validRender = renderSamples.filter((sample) => Number.isFinite(sample.expectedDisplayTime));
  const intervals = validRender.slice(1).map((sample, index) => sample.expectedDisplayTime - validRender[index].expectedDisplayTime).filter((value) => value > 0);
  const captureToCompositor = validRender
    .filter((sample) => Number.isFinite(sample.captureTime))
    .map((sample) => sample.expectedDisplayTime - sample.captureTime)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const networkLatency = validRender
    .filter((sample) => Number.isFinite(sample.captureTime) && Number.isFinite(sample.receiveTime))
    .map((sample) => sample.receiveTime - sample.captureTime)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const postReceiveLatency = validRender
    .filter((sample) => Number.isFinite(sample.receiveTime))
    .map((sample) => sample.expectedDisplayTime - sample.receiveTime)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const callbackLateness = validRender.map((sample) => sample.callbackNow - sample.expectedDisplayTime).filter(Number.isFinite);
  const processingDuration = validRender.map((sample) => sample.processingDuration * 1000).filter((value) => Number.isFinite(value) && value >= 0);
  const firstRendered = validRender[0];
  const lastRendered = validRender.at(-1);
  const renderSeconds = divide((lastRendered?.expectedDisplayTime || 0) - (firstRendered?.expectedDisplayTime || 0), 1000);
  const presentedFrames = firstRendered && lastRendered
    ? Math.max(0, Number(lastRendered.presentedFrames || 0) - Number(firstRendered.presentedFrames || 0))
    : null;
  let missedCallbacks = 0;
  for (let index = 1; index < validRender.length; index += 1) {
    missedCallbacks += Math.max(0, Number(validRender[index].presentedFrames || 0) - Number(validRender[index - 1].presentedFrames || 0) - 1);
  }
  const frameCountEstimated = Boolean(sourceStart?.frameCountEstimated || sourceEnd?.frameCountEstimated);
  const actualFixtureFrames = frameCountEstimated ? null : Math.max(
    0,
    Number(sourceEnd?.drawnFrames || 0) - Number(sourceStart?.drawnFrames || 0),
  );
  const fixtureClockFrames = frameCountEstimated ? Math.max(
    0,
    Number(sourceEnd?.clockFrameId || 0) - Number(sourceStart?.clockFrameId || 0),
  ) : null;

  return {
    elapsedSeconds: senderSeconds,
    source: {
      fixtureFps: divide(actualFixtureFrames, sourceSeconds),
      fixtureFrames: actualFixtureFrames,
      fixtureClockFps: divide(fixtureClockFrames, sourceSeconds),
      fixtureClockFrames,
      frameCountEstimated,
      skippedSlots: frameCountEstimated ? null : Math.max(
        0,
        Number(sourceEnd?.skippedSlots || 0) - Number(sourceStart?.skippedSlots || 0),
      ),
      captureFps: divide(sourceFrames, senderSeconds),
      reportedFpsMedian: median(series(senderSamples, 'source', 'framesPerSecond')),
      capturedFrames: sourceFrames,
      width: finiteOrNull(lastSender?.reports?.source?.width),
      height: finiteOrNull(lastSender?.reports?.source?.height),
    },
    sender: {
      encodeFps: divide(encodedFrames, senderSeconds),
      sendFps: divide(sentFrames, senderSeconds),
      bitrateBps: divide(Math.max(0, (sentBytes || 0) - retransmittedBytes), senderSeconds, 8),
      retransmittedBitrateBps: divide(retransmittedBytes, senderSeconds, 8),
      packetsSent: sentPackets,
      retransmittedPacketsSent: retransmittedPackets,
      retransmissionRatio: divide(retransmittedPackets, sentPackets),
      averageEncodeTimeMs: divide(encodeTime, encodedFrames, 1000),
      averagePacketSendDelayMs: divide(
        delta(firstSender?.reports?.outbound, lastSender?.reports?.outbound, 'totalPacketSendDelay'),
        sentPackets,
        1000,
      ),
      averageQp: divide(senderQp, encodedFrames),
      framesEncoded: encodedFrames,
      framesSent: sentFrames,
      frameWidth: finiteOrNull(lastSender?.reports?.outbound?.frameWidth),
      frameHeight: finiteOrNull(lastSender?.reports?.outbound?.frameHeight),
      targetBitrate: finiteOrNull(lastSender?.reports?.outbound?.targetBitrate),
      availableOutgoingBitrateMedian: median(series(senderSamples, 'candidatePair', 'availableOutgoingBitrate')),
      roundTripTimeMsMedian: divide(median(series(senderSamples, 'candidatePair', 'currentRoundTripTime')), 1, 1000),
      qualityLimitationReason: lastSender?.reports?.outbound?.qualityLimitationReason || null,
      encoderImplementation: lastSender?.reports?.outbound?.encoderImplementation || null,
      powerEfficientEncoder: lastSender?.reports?.outbound?.powerEfficientEncoder ?? null,
      codec: lastSender?.reports?.codec || null,
      adaptation: lastSender?.adaptation || null,
      settings: lastSender?.track?.settings || null,
      parameters: lastSender?.senderParameters || null,
    },
    receiver: {
      receiveFps: divide(receivedFrames, receiverSeconds),
      decodeFps: divide(decodedFrames, receiverSeconds),
      statsRenderFps: divide(renderedFrames, receiverSeconds),
      bitrateBps: divide(receivedBytes, receiverSeconds, 8),
      averageDecodeTimeMs: divide(decodeTime, decodedFrames, 1000),
      averageProcessingTimeMs: divide(processingTime, decodedFrames, 1000),
      averageJitterBufferMs: divide(jitterDelay, jitterEmitted, 1000),
      averageJitterBufferTargetMs: divide(jitterTargetDelay, jitterEmitted, 1000),
      averageJitterBufferMinimumMs: divide(jitterMinimumDelay, jitterEmitted, 1000),
      framesReceived: receivedFrames,
      framesDecoded: decodedFrames,
      framesRendered: renderedFrames,
      framesDropped: droppedFrames,
      frameWidth: finiteOrNull(lastReceiver?.reports?.inbound?.frameWidth),
      frameHeight: finiteOrNull(lastReceiver?.reports?.inbound?.frameHeight),
      packetsLost: delta(firstReceiver?.reports?.inbound, lastReceiver?.reports?.inbound, 'packetsLost'),
      packetsReceived: receivedPackets,
      packetLossRatio: lostPackets === null || receivedPackets === null
        ? null : divide(lostPackets, lostPackets + receivedPackets),
      freezeCount: delta(firstReceiver?.reports?.inbound, lastReceiver?.reports?.inbound, 'freezeCount'),
      totalFreezesDuration: delta(firstReceiver?.reports?.inbound, lastReceiver?.reports?.inbound, 'totalFreezesDuration'),
      decoderImplementation: lastReceiver?.reports?.inbound?.decoderImplementation || null,
      powerEfficientDecoder: lastReceiver?.reports?.inbound?.powerEfficientDecoder ?? null,
      jitterBufferTarget: lastReceiver?.jitterBufferTarget ?? null,
      codec: lastReceiver?.reports?.codec || null,
      settings: lastReceiver?.track?.settings || null,
    },
    render: {
      callbackSamples: validRender.length,
      presentedFrames,
      presentedFps: divide(presentedFrames, renderSeconds),
      callbackFps: divide(Math.max(0, validRender.length - 1), renderSeconds),
      missedCallbacks,
      intervalMs: {
        p50: quantile(intervals, 0.5),
        p95: quantile(intervals, 0.95),
        p99: quantile(intervals, 0.99),
        max: intervals.length ? Math.max(...intervals) : null,
      },
      captureToCompositorMs: {
        p50: quantile(captureToCompositor, 0.5),
        p95: quantile(captureToCompositor, 0.95),
        p99: quantile(captureToCompositor, 0.99),
      },
      networkMs: { p50: quantile(networkLatency, 0.5), p95: quantile(networkLatency, 0.95) },
      postReceiveMs: { p50: quantile(postReceiveLatency, 0.5), p95: quantile(postReceiveLatency, 0.95) },
      processingDurationMs: { p50: quantile(processingDuration, 0.5), p95: quantile(processingDuration, 0.95) },
      callbackLatenessMs: { p50: quantile(callbackLateness, 0.5), p95: quantile(callbackLateness, 0.95) },
      width: finiteOrNull(lastRendered?.width),
      height: finiteOrNull(lastRendered?.height),
    },
    retention: {
      encodedPerCaptured: divide(encodedFrames, sourceFrames),
      decodedPerEncoded: divide(decodedFrames, encodedFrames),
      presentedPerCaptured: divide(presentedFrames, sourceFrames),
    },
    transport: {
      sendBitrateBps: distribution(intervalCounterSeries(senderSamples, 'outbound', 'bytesSent', 8)),
      retransmitBitrateBps: distribution(intervalCounterSeries(senderSamples, 'outbound', 'retransmittedBytesSent', 8)),
      sendFps: distribution(intervalCounterSeries(senderSamples, 'outbound', 'framesSent')),
      receiveBitrateBps: distribution(intervalCounterSeries(receiverSamples, 'inbound', 'bytesReceived', 8)),
      receiveFps: distribution(intervalCounterSeries(receiverSamples, 'inbound', 'framesReceived')),
      packetSendDelayMs: distribution(intervalAverageSeries(senderSamples, 'outbound', 'totalPacketSendDelay', 'packetsSent', 1000)),
      packetLossRatio: distribution(intervalLossRatioSeries(receiverSamples, 'inbound', 'packetsLost', 'packetsReceived')),
      availableOutgoingBitrate: distribution(series(senderSamples, 'candidatePair', 'availableOutgoingBitrate')),
      roundTripTimeMs: distribution(series(senderSamples, 'candidatePair', 'currentRoundTripTime').map((value) => value * 1000)),
      packetsDiscardedOnSend: delta(firstSender?.reports?.candidatePair, lastSender?.reports?.candidatePair, 'packetsDiscardedOnSend'),
      bytesDiscardedOnSend: delta(firstSender?.reports?.candidatePair, lastSender?.reports?.candidatePair, 'bytesDiscardedOnSend'),
    },
    resources: summarizeResources(resourceSamples),
  };
}

async function measureRun(fixture, sender, receiver, captureSource) {
  progress(`aquecendo por ${config.warmupMs} ms`);
  await wait(config.warmupMs);
  const resourceContext = { fixture, sender, receiver };
  await sampleResources(resourceContext, false);
  await fixtureReset(fixture);
  const renderStarted = await receiver.webContents.executeJavaScript('globalThis.__jumpBenchmarkRender?.start?.() || false');
  if (!renderStarted) throw new Error('requestVideoFrameCallback indisponível no vídeo remoto.');
  const sourceStart = await fixtureSnapshot(fixture);
  const senderSamples = [];
  const receiverSamples = [];
  const resourceSamples = [];
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let nextSampleAt = started;
  let nextResourceAt = started + Math.min(config.resourceSampleMs, config.durationMs);
  do {
    const delay = nextSampleAt - performance.now();
    if (delay > 0) await wait(delay);
    const sampleStarted = performance.now();
    const collectResources = sampleStarted >= nextResourceAt;
    const [senderSample, receiverSample, resourceSample] = await Promise.all([
      sampleStats(sender, 'sender'),
      sampleStats(receiver, 'receiver'),
      collectResources ? sampleResources(resourceContext) : Promise.resolve(null),
    ]);
    if (senderSample) senderSamples.push({ benchmarkElapsedMs: sampleStarted - started, ...senderSample });
    if (receiverSample) receiverSamples.push({ benchmarkElapsedMs: sampleStarted - started, ...receiverSample });
    if (resourceSample) resourceSamples.push({ benchmarkElapsedMs: sampleStarted - started, ...resourceSample });
    nextSampleAt += config.sampleMs;
    if (collectResources) {
      do { nextResourceAt += config.resourceSampleMs; } while (nextResourceAt <= sampleStarted);
    }
  } while (performance.now() - started < config.durationMs);
  const sourceEnd = await fixtureSnapshot(fixture);
  const renderSamples = await receiver.webContents.executeJavaScript('globalThis.__jumpBenchmarkRender?.stop?.() || []');
  if (senderSamples.length < 2 || receiverSamples.length < 2) throw new Error('A rodada não produziu amostras suficientes.');
  progress(config.qualitySamples > 0 && !fixture.external
    ? `medindo qualidade visual em ${config.qualitySamples} quadro(s) alinhado(s)`
    : 'qualidade visual indisponível para esta fonte');
  const visualQuality = await measureVisualQuality(fixture, receiver, captureSource);
  const summary = summarizeRun(senderSamples, receiverSamples, renderSamples, sourceStart, sourceEnd, resourceSamples);
  summary.visualQuality = visualQuality;
  return {
    startedAt,
    endedAt: new Date().toISOString(),
    sourceStart,
    sourceEnd,
    senderSamples,
    receiverSamples,
    renderSamples,
    resourceSamples,
    summary,
  };
}

function valueAt(object, pathExpression) {
  return pathExpression.split('.').reduce((value, key) => value?.[key], object);
}

const PROFILE_EXPECTATIONS = {
  performance: { maxWidth: 1280, maxHeight: 720, targetFps: 60 },
  quality: { maxWidth: 1920, maxHeight: 1080, targetFps: 30 },
};

function evaluateRunValidity(profile, summary, sourceEnd) {
  const expected = PROFILE_EXPECTATIONS[profile];
  const reasons = [];
  const warnings = [];
  const width = finiteOrNull(summary?.sender?.frameWidth);
  const height = finiteOrNull(summary?.sender?.frameHeight);
  const codec = summary?.sender?.codec?.mimeType || 'unknown-codec';
  const encoder = summary?.sender?.encoderImplementation || 'unknown-encoder';
  const requirePositive = (pathExpression) => {
    const value = finiteOrNull(valueAt(summary, pathExpression));
    if (value === null || value <= 0) reasons.push(`missing-or-zero:${pathExpression}`);
  };
  for (const metric of ['source.captureFps', 'sender.encodeFps', 'receiver.decodeFps', 'render.presentedFps']) {
    requirePositive(metric);
  }
  if (!expected) reasons.push('unknown-profile');
  if (width === null || height === null) {
    reasons.push('missing-encoded-resolution');
  } else if (expected && (width > expected.maxWidth + 2 || height > expected.maxHeight + 2)) {
    reasons.push(`resolution-exceeds-profile:${width}x${height}`);
  }
  if (/h264/i.test(codec) && width !== null && height !== null && (width % 2 || height % 2)) {
    reasons.push(`odd-h264-resolution:${width}x${height}`);
  }
  if (summary?.receiver?.frameWidth !== width || summary?.receiver?.frameHeight !== height) {
    reasons.push('sender-receiver-resolution-mismatch');
  }
  const fixtureFps = finiteOrNull(summary?.source?.fixtureFps);
  if (!summary?.source?.frameCountEstimated && fixtureFps !== null
      && fixtureFps < config.sourceFps * 0.90) reasons.push('fixture-cadence-unstable');
  if (summary?.source?.frameCountEstimated) warnings.push('external-source-frame-count-unobserved');
  if (config.gpuLoad > 0 && !sourceEnd?.external && sourceEnd?.gpuLoadActive !== true) {
    reasons.push(`gpu-load-inactive:${sourceEnd?.gpuLoadError || 'unknown'}`);
  }
  if ((finiteOrNull(summary?.receiver?.packetsLost) || 0) > 3) warnings.push('receiver-packet-loss');
  if ((finiteOrNull(summary?.receiver?.packetLossRatio) || 0) > 0.01) warnings.push('receiver-packet-loss-ratio');
  if ((finiteOrNull(summary?.sender?.retransmissionRatio) || 0) > 0.05) warnings.push('sender-retransmission-ratio');
  if ((finiteOrNull(summary?.transport?.sendBitrateBps?.coefficientOfVariation) || 0) > 0.25) warnings.push('sender-bitrate-oscillation');
  if ((finiteOrNull(summary?.transport?.packetSendDelayMs?.p95) || 0) > 20) warnings.push('sender-pacer-delay');
  if ((finiteOrNull(summary?.transport?.packetsDiscardedOnSend) || 0) > 0) warnings.push('sender-packets-discarded');
  if ((finiteOrNull(summary?.receiver?.freezeCount) || 0) > 0) warnings.push('receiver-freeze-observed');
  if (!summary?.visualQuality?.available) warnings.push(`visual-quality-unavailable:${summary?.visualQuality?.reason || 'unknown'}`);
  else if (!summary.visualQuality.valid) warnings.push(`visual-quality-invalid:${summary.visualQuality.reason || 'unknown'}`);
  const adaptationScale = finiteOrNull(summary?.sender?.parameters?.encodings?.[0]?.scaleResolutionDownBy)
    ?? finiteOrNull(summary?.sender?.adaptation?.scale)
    ?? 1;
  const stratum = {
    codec,
    encoder,
    resolution: width === null || height === null ? 'unknown' : `${width}x${height}`,
    adaptationScale,
  };
  return {
    validForPerformance: reasons.length === 0,
    // Pixel fidelity is populated only by the deterministic quality phase;
    // external Chrome/ffplay cadence alone cannot claim visual quality.
    validForVisualQuality: reasons.length === 0 && summary?.visualQuality?.valid === true,
    reasons,
    warnings,
    stratum,
    stratumKey: JSON.stringify(stratum),
  };
}

function aggregateRuns(runs) {
  const metrics = [
    'source.captureFps',
    'sender.encodeFps',
    'sender.bitrateBps',
    'sender.retransmissionRatio',
    'receiver.packetLossRatio',
    'transport.sendBitrateBps.coefficientOfVariation',
    'transport.packetSendDelayMs.p95',
    'transport.packetLossRatio.p95',
    'sender.averageEncodeTimeMs',
    'receiver.decodeFps',
    'receiver.averageJitterBufferMs',
    'render.presentedFps',
    'render.intervalMs.p95',
    'render.captureToCompositorMs.p95',
    'visualQuality.ssim.p50',
    'visualQuality.psnrDb.p50',
    'resources.global.cpuPercentSum.mean',
    'resources.global.cpuPercentSum.p95',
    'resources.global.privateMemoryMiBSum.p95',
    'resources.mainProcess.cpuPercent.mean',
    'resources.nvidia.gpuUtilizationPercentMax.mean',
    'resources.nvidia.encoderUtilizationPercentMax.mean',
    'resources.nvidia.decoderUtilizationPercentMax.mean',
    'resources.nvidia.memoryUsedMiBSum.p95',
  ];
  const byProfile = {};
  for (const profile of config.profiles) {
    const profileRuns = runs.filter((run) => run.profile === profile);
    const validRuns = profileRuns.filter((run) => run.validity?.validForPerformance);
    const strata = new Map();
    for (const run of validRuns) {
      const key = run.validity.stratumKey;
      if (!strata.has(key)) strata.set(key, []);
      strata.get(key).push(run);
    }
    const orderedStrata = [...strata.entries()].sort((left, right) => right[1].length - left[1].length);
    const selectedRuns = orderedStrata[0]?.[1] || [];
    byProfile[profile] = {
      runs: profileRuns.length,
      validRuns: validRuns.length,
      excludedRuns: profileRuns.length - validRuns.length,
      comparable: orderedStrata.length <= 1,
      selectedStratum: selectedRuns[0]?.validity?.stratum || null,
      strata: orderedStrata.map(([key, entries]) => ({
        key,
        runs: entries.length,
        stratum: entries[0].validity.stratum,
      })),
      median: {},
    };
    for (const metric of metrics) {
      const metricRuns = metric.startsWith('visualQuality.')
        ? selectedRuns.filter((run) => run.validity?.validForVisualQuality)
        : selectedRuns;
      const values = metricRuns.map((run) => finiteOrNull(valueAt(run.summary, metric))).filter((value) => value !== null);
      byProfile[profile].median[metric] = median(values);
    }
  }
  const performanceFps = byProfile.performance?.median?.['render.presentedFps'];
  const qualityFps = byProfile.quality?.median?.['render.presentedFps'];
  return {
    byProfile,
    differential: byProfile.performance?.comparable !== false
      && byProfile.quality?.comparable !== false
      && Number.isFinite(performanceFps) && Number.isFinite(qualityFps)
      ? {
        presentedFpsAbsolute: performanceFps - qualityFps,
        presentedFpsRatio: qualityFps > 0 ? performanceFps / qualityFps : null,
      }
      : null,
  };
}

async function environmentManifest(fixtureSource) {
  let gpuInfo = null;
  try { gpuInfo = await app.getGPUInfo('basic'); } catch { /* Optional diagnostic. */ }
  return {
    generatedAt: new Date().toISOString(),
    git: {
      commit: gitOutput(['rev-parse', 'HEAD']),
      status: gitOutput(['status', '--short']),
      sourceSha256: Object.fromEntries([
        'electron/main.cjs',
        'src/hooks/useScreenShare.js',
        'src/media/screenShareProfiles.js',
        'src/media/screenShareTelemetry.js',
        'src/webrtc/usePeerMesh.js',
        'tests/screen-share-benchmark.e2e.cjs',
        'tests/fixtures/motion-source.html',
      ].map((relativePath) => [relativePath, sha256File(relativePath)])),
    },
    runtime: process.versions,
    chromiumSwitches: {
      disableFeatures: app.commandLine.getSwitchValue('disable-features') || '',
      enableFeatures: app.commandLine.getSwitchValue('enable-features') || '',
      argv: [...process.argv],
    },
    platform: {
      platform: process.platform,
      arch: process.arch,
      osType: os.type(),
      osRelease: os.release(),
      osVersion: os.version(),
      cpu: os.cpus()[0]?.model || '',
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    electronGpu: {
      hardwareAcceleration: app.isHardwareAccelerationEnabled(),
      featureStatus: app.getGPUFeatureStatus(),
      info: gpuInfo,
    },
    resourceTelemetry: {
      appGetAppMetrics: typeof app.getAppMetrics === 'function',
      processGetCPUUsage: typeof process.getCPUUsage === 'function',
      processGetProcessMemoryInfo: typeof process.getProcessMemoryInfo === 'function',
      processGetSystemMemoryInfo: typeof process.getSystemMemoryInfo === 'function',
      nvidiaSmi: { ...nvidiaSmiState },
    },
    externalSource: config.externalSource ? {
      mode: config.externalSourceMode,
      executable: externalSourceExecutable,
      version: externalSourceVersion,
      frameCadenceObserved: false,
    } : null,
    captureBackend: {
      wgcScreenCapturerDisabled: (app.commandLine.getSwitchValue('disable-features') || '')
        .split(',').map((value) => value.trim()).includes('AllowWgcScreenCapturer'),
      confirmedByTrace: false,
      note: 'The switch expresses preference; Chromium may use an internal fallback unless a trace confirms the capturer.',
    },
    isolation: {
      receiver: config.captureType === 'screen' && screen.getAllDisplays().length === 1
        ? 'visible-offscreen-outside-all-displays'
        : 'visible-on-noncaptured-or-window-safe-display',
      loopbackSameMachine: true,
    },
    networkEmulation: { ...networkEmulationState },
    displays: screen.getAllDisplays().map((display) => ({
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      displayFrequency: display.displayFrequency,
      colorDepth: display.colorDepth,
    })),
    fixtureSource,
  };
}

async function runBenchmark() {
  if (!fs.existsSync(path.join(projectRoot, 'dist', 'index.html'))) {
    throw new Error('dist/index.html ausente; execute npm run build antes do benchmark.');
  }
  await app.whenReady();
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(true));
  setupIpc();
  await startServer();
  const fixture = config.externalSource ? await createExternalMotionSource() : await createMotionSource();
  const fixtureSource = await ensureFixtureSource();
  const sender = await createParticipant('sender', 0);
  const receiver = await createParticipant('receiver', 1);
  await waitFor(() => Promise.all([sender, receiver].map((window) => count(window, '.signal-badge.is-connected'))).then((values) => values.every(Boolean)), 'dois clientes sinalizados');
  await Promise.all([joinCall(sender), joinCall(receiver)]);
  await waitFor(() => Promise.all([sender, receiver].map((window) => window.webContents.executeJavaScript('globalThis.__jumpPeerMesh?.peerConnectionsRef.current.size === 1'))).then((values) => values.every(Boolean)), 'peer connection loopback');
  await installCollectors(sender, receiver);
  await applyNetworkEmulation(sender, 'sender-renderer');
  receiver.showInactive();
  if (config.captureType === 'screen' && !fixture.external) {
    fixture.showInactive();
    fixture.moveTop();
  }

  const runs = [];
  for (let repeat = 0; repeat < config.repeats; repeat += 1) {
    const order = repeat % 2 === 0 ? [...config.profiles] : [...config.profiles].reverse();
    for (let orderIndex = 0; orderIndex < order.length; orderIndex += 1) {
      const profile = order[orderIndex];
      const runId = `${String(repeat + 1).padStart(2, '0')}-${profile}`;
      progress(`iniciando ${runId}`);
      await fixtureReset(fixture);
      await startShare(sender, receiver, profile, fixtureSource);
      let measured = null;
      try {
        measured = await measureRun(fixture, sender, receiver, fixtureSource);
      } finally {
        await stopShare(sender, receiver);
      }
      const validity = evaluateRunValidity(profile, measured.summary, measured.sourceEnd);
      runs.push({
        runId,
        repeat: repeat + 1,
        orderIndex,
        profile,
        captureSource: fixtureSource,
        validity,
        ...measured,
      });
      const cpuMean = finiteOrNull(measured.summary.resources.global.cpuPercentSum.mean);
      const gpuMean = finiteOrNull(measured.summary.resources.nvidia.gpuUtilizationPercentMax.mean);
      const ssim = finiteOrNull(measured.summary.visualQuality?.ssim?.p50);
      const lossPercent = (finiteOrNull(measured.summary.receiver.packetLossRatio) || 0) * 100;
      const bitrateCv = finiteOrNull(measured.summary.transport.sendBitrateBps.coefficientOfVariation);
      progress(`${runId}: apresentado ${finiteOrNull(measured.summary.render.presentedFps)?.toFixed(2) ?? 'n/a'} FPS, encode ${finiteOrNull(measured.summary.sender.encodeFps)?.toFixed(2) ?? 'n/a'} FPS, perda ${lossPercent.toFixed(2)}%, bitrate CV ${bitrateCv?.toFixed(3) ?? 'n/a'}, SSIM ${ssim?.toFixed(4) ?? 'n/a'}, CPU ${cpuMean?.toFixed(1) ?? 'n/a'}%, GPU ${gpuMean?.toFixed(1) ?? 'n/a'}%, validade ${validity.validForPerformance ? 'ok' : validity.reasons.join(',')}`);
    }
  }

  return {
    schemaVersion: 4,
    benchmark: 'jump-screen-share-loopback',
    config,
    environment: await environmentManifest(fixtureSource),
    runs,
    aggregate: aggregateRuns(runs),
  };
}

async function cleanup() {
  const deferredTempTargets = [
    { targetPath: benchmarkServerData, expectedPrefix: 'jump-stream-benchmark-server-' },
    { targetPath: benchmarkUserData, expectedPrefix: 'jump-stream-benchmark-electron-' },
    { targetPath: externalSourceProfile, expectedPrefix: 'jump-stream-benchmark-chrome-' },
  ];
  await releaseNetworkEmulation();
  for (const window of windows.splice(0)) {
    if (!window.isDestroyed()) window.destroy();
  }
  if (externalSourceProcess && externalSourceProcess.exitCode === null) {
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill.exe', ['/pid', String(externalSourceProcess.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch { /* Process may have already exited. */ }
    } else {
      externalSourceProcess.kill('SIGKILL');
    }
  }
  externalSourceProcess?.stderr?.destroy?.();
  externalSourceProcess?.unref?.();
  externalSourceProcess = null;
  if (externalSourceProfile) {
    removeBenchmarkTempDirectory(externalSourceProfile, 'jump-stream-benchmark-chrome-');
  }
  externalSourceProfile = '';
  await stopServer();
  removeBenchmarkTempDirectory(benchmarkServerData, 'jump-stream-benchmark-server-');
  removeBenchmarkTempDirectory(benchmarkUserData, 'jump-stream-benchmark-electron-');
  // Chromium can hold LevelDB/cache files until the Electron process exits.
  // A hidden Node-mode helper retries exact, validated PID-scoped paths after
  // shutdown instead of accumulating hundreds of benchmark profiles.
  scheduleBenchmarkTempCleanup(deferredTempTargets);
}

function emitReport(report) {
  const spacing = config.pretty ? 2 : 0;
  const json = `${JSON.stringify(report, null, spacing)}\n`;
  if (config.outputPath) {
    fs.mkdirSync(path.dirname(config.outputPath), { recursive: true });
    fs.writeFileSync(config.outputPath, json);
    progress(`relatório salvo em ${config.outputPath}`);
  }
  if (!config.outputPath || config.stdout) fs.writeSync(1, json);
}

(async () => {
  let exitCode = 0;
  try {
    const report = await runBenchmark();
    emitReport(report);
  } catch (error) {
    exitCode = 1;
    process.stderr.write(`${error.stack || error.message || error}\n`);
  } finally {
    await cleanup();
    app.exit(exitCode);
  }
})();

process.once('exit', () => {
  // Electron can keep cache files open until app.exit(). Retry synchronously
  // after shutdown; exact PID-scoped paths are validated above.
  removeBenchmarkTempDirectory(benchmarkServerData, 'jump-stream-benchmark-server-');
  removeBenchmarkTempDirectory(benchmarkUserData, 'jump-stream-benchmark-electron-');
  removeBenchmarkTempDirectory(externalSourceProfile, 'jump-stream-benchmark-chrome-');
});

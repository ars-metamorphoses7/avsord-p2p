// Real-process stream probe. Unlike the old benchmark (sender, receivers and the
// synthetic source inside one Electron process, vsync-capped at 60 FPS), this
// runs every role as its own process, like a real call:
//   - "game": separate Electron app, fullscreen, uncapped GPU-bound renderer
//     that reports its own FPS (tests/fixtures/game-load)
//   - sender: the real JUMP app (electron .), real main process, priority boost,
//     capture flags, driven over the Chrome DevTools Protocol
//   - viewers: real JUMP apps. They keep the GPU (with --disable-gpu Chromium
//     has no H.264 decoder, negotiation falls back to software VP8 and the run
//     no longer resembles a Windows call); their hardware decode runs on the
//     same GPU, so the numbers are slightly pessimistic for the sender
// Each phase reports game FPS next to sender capture/encode and viewer
// smoothness (freezes, frame-interval jitter), from RTCStats counter deltas.
//
//   npm run build && npm run probe:game
//   PROBE_PHASES=idle,share  PROBE_VIEWERS=2  PROBE_MEASURE_MS=15000
//   PROBE_SOURCE=screen|window  GAME_LOAD=250  PROBE_SENDER_ENV="KEY=value;..."
//   PROBE_SENDER_ARGS="--enable-features=..."
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const electron = require('electron');
const viewers = Math.max(1, Math.min(4, Number(process.env.PROBE_VIEWERS) || 2));
const warmupMs = Number(process.env.PROBE_WARMUP_MS) || 6_000;
const measureMs = Number(process.env.PROBE_MEASURE_MS) || 15_000;
const phases = String(process.env.PROBE_PHASES || 'idle,share,share-noprio,share-1viewer').split(',').map((v) => v.trim()).filter(Boolean);
const sourceKind = process.env.PROBE_SOURCE === 'window' ? 'window' : 'screen';
const gameLoad = Number(process.env.GAME_LOAD) || 250;
const senderEnv = Object.fromEntries(String(process.env.PROBE_SENDER_ENV || '').split(';').filter((pair) => pair.includes('='))
  .map((pair) => [pair.slice(0, pair.indexOf('=')).trim(), pair.slice(pair.indexOf('=') + 1).trim()]));
const senderArgs = String(process.env.PROBE_SENDER_ARGS || '').split(' ').filter(Boolean);
const outputPath = process.env.PROBE_OUTPUT || path.join(os.tmpdir(), `jump-game-probe-${Date.now()}.json`);
const basePort = 18_700 + Math.floor(Math.random() * 200);
const children = [];
const tempDirs = [];
let shuttingDown = false;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => process.stderr.write(`[probe] ${message}\n`);

function launch(file, args, env, label) {
  const child = spawn(file, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  child.label = label;
  child.output = '';
  children.push(child);
  // Drain both pipes: an unread pipe fills up and blocks the child process.
  const keep = (chunk) => {
    child.output = (child.output + chunk).slice(-4000);
    for (const line of String(chunk).split('\n')) if (/\[(stream-priority|native-capture)\]/.test(line)) log(`${label}: ${line.trim()}`);
  };
  if (label !== 'game') child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('exit', (code) => { if (!shuttingDown) log(`${label} saiu (código ${code}): ${child.output.slice(-600)}`); });
  return child;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* already gone */ }
}

async function cdp(port, urlPrefix) {
  const deadline = Date.now() + 60_000;
  let target;
  while (!target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((entry) => entry.type === 'page' && entry.url.startsWith(urlPrefix));
    } catch { /* not listening yet */ }
    if (!target) {
      if (Date.now() > deadline) throw new Error(`DevTools ${port} sem página ${urlPrefix}`);
      await wait(400);
    }
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const entry = message.id && pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    nextId += 1;
    pending.set(nextId, { resolve, reject });
    socket.send(JSON.stringify({ id: nextId, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  return { send, evaluate, close: () => socket.close() };
}

async function until(page, expression, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { if (await page.evaluate(expression)) return; } catch { /* page navigating */ }
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await wait(300);
  }
}

const click = (page, selector) => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.click(); return Boolean(el); })()`);
const clickText = (page, selector, text) => page.evaluate(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.toLowerCase().includes(${JSON.stringify(text)}));
  el?.click(); return Boolean(el);
})()`);

const SNAPSHOT = `globalThis.__probeSnap = async () => {
  const pick = (stat, keys) => Object.fromEntries(keys.filter((key) => stat[key] !== undefined).map((key) => [key, stat[key]]));
  const OUT = ['framesEncoded', 'totalEncodeTime', 'qpSum', 'bytesSent', 'frameWidth', 'frameHeight', 'qualityLimitationDurations', 'encoderImplementation', 'powerEfficientEncoder', 'nackCount', 'pliCount', 'retransmittedBytesSent', 'targetBitrate', 'hugeFramesSent', 'keyFramesEncoded'];
  const IN = ['framesDecoded', 'framesDropped', 'totalDecodeTime', 'freezeCount', 'totalFreezesDuration', 'totalInterFrameDelay', 'totalSquaredInterFrameDelay', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'packetsLost', 'packetsReceived', 'frameWidth', 'frameHeight', 'nackCount', 'pliCount', 'keyFramesDecoded', 'decoderImplementation', 'bytesReceived', 'pauseCount', 'totalPausesDuration'];
  const peers = [];
  const collect = async (label, statsSource) => {
    const reports = await statsSource.getStats();
    const entry = { label, outbound: [], inbound: [], source: null, pair: null };
    let selectedPair = '';
    const codecs = {};
    reports.forEach((stat) => {
      if (stat.type === 'transport' && stat.selectedCandidatePairId) selectedPair = stat.selectedCandidatePairId;
      if (stat.type === 'codec') codecs[stat.id] = stat.mimeType.replace('video/', '') + ((/profile-level-id=(\\w+)/.exec(stat.sdpFmtpLine || '') || [])[1] ? '/' + /profile-level-id=(\\w+)/.exec(stat.sdpFmtpLine)[1] : '');
    });
    reports.forEach((stat) => {
      if (stat.type === 'outbound-rtp' && stat.kind === 'video') entry.outbound.push({ ...pick(stat, OUT), codec: codecs[stat.codecId] || '' });
      else if (stat.type === 'inbound-rtp' && stat.kind === 'video') entry.inbound.push(pick(stat, IN));
      else if (stat.type === 'media-source' && stat.kind === 'video') entry.source = pick(stat, ['frames', 'width', 'height']);
      else if (stat.type === 'candidate-pair' && (stat.id === selectedPair || (!selectedPair && stat.nominated && stat.state === 'succeeded'))) entry.pair = pick(stat, ['availableOutgoingBitrate', 'currentRoundTripTime']);
    });
    peers.push(entry);
  };
  for (const [peerId, slot] of globalThis.__jumpPeerMesh?.peerConnectionsRef.current || []) {
    if (slot?.pc && slot.pc.connectionState !== 'closed') await collect('mesh:' + peerId, slot.pc).catch(() => {});
  }
  const sfu = globalThis.__jumpScreenSfu;
  if (sfu?.producerRef?.current) await collect('sfu:producer', sfu.producerRef.current).catch(() => {});
  for (const [id, entry] of sfu?.consumersRef?.current || []) if (entry?.consumer) await collect('sfu:' + id, entry.consumer).catch(() => {});
  return { t: performance.now(), peers };
}; true`;

function delta(first, last, key) {
  const a = Number(first?.[key]);
  const b = Number(last?.[key]);
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
}

function senderSummary(first, last) {
  const seconds = (last.t - first.t) / 1000;
  const rows = [];
  for (const peer of last.peers) {
    const before = first.peers.find((entry) => entry.label === peer.label);
    peer.outbound.forEach((out, index) => {
      const prev = before?.outbound[index];
      const frames = delta(prev, out, 'framesEncoded');
      if (!prev || !frames) return;
      const limits = Object.entries(out.qualityLimitationDurations || {}).map(([reason, value]) => [reason, value - (prev.qualityLimitationDurations?.[reason] || 0)])
        .filter(([reason]) => reason !== 'none').sort((a, b) => b[1] - a[1]);
      rows.push({
        peer: peer.label,
        captureFps: peer.source && before?.source ? delta(before.source, peer.source, 'frames') / seconds : null,
        encodeFps: frames / seconds,
        encodeMs: delta(prev, out, 'totalEncodeTime') / frames * 1000,
        qp: delta(prev, out, 'qpSum') / frames,
        mbps: delta(prev, out, 'bytesSent') * 8 / seconds / 1e6,
        size: `${out.frameWidth}x${out.frameHeight}`,
        limitedSeconds: limits[0] && limits[0][1] > 0.5 ? `${limits[0][0]}:${limits[0][1].toFixed(1)}s` : '',
        estimateMbps: peer.pair?.availableOutgoingBitrate ? peer.pair.availableOutgoingBitrate / 1e6 : null,
        encoder: `+${out.codec || ''} ${out.encoderImplementation || ''}`,
        pli: delta(prev, out, 'pliCount'),
        nack: delta(prev, out, 'nackCount'),
      });
    });
  }
  return rows;
}

function receiverSummary(first, last) {
  const seconds = (last.t - first.t) / 1000;
  const rows = [];
  for (const peer of last.peers) {
    const before = first.peers.find((entry) => entry.label === peer.label);
    peer.inbound.forEach((inbound, index) => {
      const prev = before?.inbound[index];
      const frames = delta(prev, inbound, 'framesDecoded');
      if (!prev || !frames) return;
      const mean = delta(prev, inbound, 'totalInterFrameDelay') / frames;
      const meanSquare = delta(prev, inbound, 'totalSquaredInterFrameDelay') / frames;
      const emitted = delta(prev, inbound, 'jitterBufferEmittedCount');
      rows.push({
        peer: peer.label,
        fps: frames / seconds,
        dropped: delta(prev, inbound, 'framesDropped'),
        freezes: delta(prev, inbound, 'freezeCount'),
        freezeMs: delta(prev, inbound, 'totalFreezesDuration') * 1000,
        intervalMs: mean * 1000,
        jitterMs: Math.sqrt(Math.max(0, meanSquare - mean * mean)) * 1000,
        decodeMs: delta(prev, inbound, 'totalDecodeTime') / frames * 1000,
        bufferMs: emitted ? delta(prev, inbound, 'jitterBufferDelay') / emitted * 1000 : null,
        lost: delta(prev, inbound, 'packetsLost'),
        size: `${inbound.frameWidth}x${inbound.frameHeight}`,
        keyframes: delta(prev, inbound, 'keyFramesDecoded'),
      });
    });
  }
  return rows;
}

function startGpuSampler() {
  const samples = [];
  let child;
  try {
    child = spawn('nvidia-smi', ['--query-gpu=utilization.gpu,utilization.encoder,utilization.decoder', '--format=csv,noheader,nounits', '-lms', '500'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    child.on('error', () => {});
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const [gpu, enc, dec] = line.split(',').map(Number);
        if (Number.isFinite(gpu)) samples.push({ t: Date.now(), gpu, enc, dec });
      }
    });
    children.push(child);
  } catch { /* no NVIDIA tools */ }
  return samples;
}

const average = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const fixed = (value, digits = 1) => (value === null || value === undefined || !Number.isFinite(value) ? '-' : value.toFixed(digits));

async function main() {
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('Rode npm run build antes do probe.');
  const gameLines = [];
  const game = launch(electron, [path.join(root, 'tests', 'fixtures', 'game-load', 'main.cjs')], { GAME_LOAD: String(gameLoad) }, 'game');
  let gameBuffer = '';
  game.stdout.on('data', (chunk) => {
    gameBuffer += chunk;
    const lines = gameBuffer.split(/\r?\n/);
    gameBuffer = lines.pop();
    for (const line of lines) if (line.startsWith('GAME ')) gameLines.push(JSON.parse(line.slice(5)));
  });
  const gpuSamples = startGpuSampler();

  const instances = [];
  for (let index = 0; index <= viewers; index += 1) {
    const role = index === 0 ? 'sender' : `viewer${index}`;
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), `jump-probe-${role}-`));
    tempDirs.push(userData);
    const port = basePort + index;
    const debugPort = basePort + 100 + index;
    const args = ['.', `--remote-debugging-port=${debugPort}`, '--mute-audio'];
    if (index > 0) args.push('--use-fake-device-for-media-stream');
    else args.push(...senderArgs);
    const env = { PORT: String(port), JUMP_USER_DATA_DIR: userData, ...(index === 0 ? senderEnv : {}) };
    launch(electron, args, env, role);
    instances.push({ role, port, debugPort });
  }
  const senderOrigin = `http://127.0.0.1:${instances[0].port}`;
  for (const instance of instances) {
    log(`conectando ao ${instance.role}`);
    instance.page = await cdp(instance.debugPort, `http://127.0.0.1:${instance.port}/`);
    // Navigating before the app's own loadURL settles aborts it, and main.cjs
    // quits on that failure.
    await until(instance.page, 'document.readyState === "complete" && Boolean(document.querySelector(\'button[aria-label="Abrir chamada"]\'))', `${instance.role} inicial`, 60_000);
    await instance.page.send('Page.navigate', { url: `http://127.0.0.1:${instance.port}/?room=probe&signal=${encodeURIComponent(senderOrigin)}&meshDebug=1` });
  }
  for (const instance of instances) {
    await until(instance.page, 'Boolean(document.querySelector(\'button[aria-label="Abrir chamada"]\')) && Boolean(globalThis.__jumpPeerMesh)', `${instance.role} carregado`);
    log(`${instance.role} carregado; entrando na chamada`);
    await instance.page.evaluate(SNAPSHOT);
    await click(instance.page, 'button[aria-label="Abrir chamada"]');
    await until(instance.page, 'Boolean(document.querySelector(".join-call-button, .leave-button"))', `${instance.role} painel`);
    await click(instance.page, '.join-call-button');
    await until(instance.page, 'Boolean(document.querySelector(".leave-button"))', `${instance.role} na chamada`);
  }
  const [sender, ...viewerInstances] = instances;
  await until(sender.page, `[...globalThis.__jumpPeerMesh.peerConnectionsRef.current.values()].filter((slot) => slot.pc.connectionState === 'connected').length >= ${viewers}`, 'mesh conectado', 45_000);
  log(`${viewers} viewers conectados; sender ${senderOrigin}`);

  const sharing = () => sender.page.evaluate('Boolean(document.querySelector(\'button[aria-label="Parar compartilhamento"]\'))');
  const startShare = async () => {
    if (await sharing()) return;
    await click(sender.page, 'button[aria-label="Compartilhar tela"]');
    await until(sender.page, 'document.querySelectorAll(".screen-share-source").length > 0', 'seletor de fontes');
    const picked = await sender.page.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.screen-share-source')];
      const card = ${sourceKind === 'window'
        ? `cards.find((node) => node.querySelector('strong')?.textContent.includes('JUMP game load'))`
        : `cards.find((node) => node.querySelector('small')?.textContent.trim() === 'tela inteira')`};
      card?.click(); return Boolean(card);
    })()`);
    if (!picked) throw new Error(`fonte ${sourceKind} não encontrada no seletor`);
    await click(sender.page, '.screen-share-actions .dialog-primary');
    await until(sender.page, 'Boolean(document.querySelector(\'button[aria-label="Parar compartilhamento"]\'))', 'compartilhamento ativo');
  };
  const stopShare = async () => {
    if (await sharing()) await click(sender.page, 'button[aria-label="Parar compartilhamento"]');
  };
  const setWatching = async (viewer, watching) => {
    if (watching) await clickText(viewer.page, '.call-stream-card button', 'assistir transmissão');
    else await clickText(viewer.page, '.call-stream-watch-toggle', 'parar de assistir');
  };

  const results = [];
  for (const phase of phases) {
    if (phase === 'idle') await stopShare();
    else await startShare();
    if (phase !== 'idle') for (const viewer of viewerInstances) await setWatching(viewer, true);
    if (phase === 'share-1viewer') for (const viewer of viewerInstances.slice(1)) await setWatching(viewer, false);
    if (phase === 'share-noprio') await sender.page.evaluate('globalThis.jumpDesktop?.setStreamPriority?.(false)');
    log(`fase ${phase}: aquecendo ${warmupMs / 1000}s, medindo ${measureMs / 1000}s`);
    await wait(warmupMs);
    const startedAt = Date.now();
    const first = await Promise.all(instances.map((instance) => instance.page.evaluate('globalThis.__probeSnap()')));
    const timeline = [];
    if (process.env.PROBE_TIMELINE && phase !== 'idle') {
      // PROBE_TIMELINE=1 samples every 2 s; a value >= 100 is the step in ms.
      const step = Number(process.env.PROBE_TIMELINE) >= 100 ? Number(process.env.PROBE_TIMELINE) : 2_000;
      const firstOutbound = (snap) => snap.peers.find((peer) => peer.outbound.some((entry) => entry.framesEncoded))?.outbound[0];
      let previous = first[0];
      for (let elapsed = 0; elapsed < measureMs; elapsed += step) {
        await wait(step);
        const current = await sender.page.evaluate('globalThis.__probeSnap()');
        const row = senderSummary(previous, current)[0];
        const out = firstOutbound(current);
        const keyframes = (out?.keyFramesEncoded ?? 0) - (firstOutbound(previous)?.keyFramesEncoded ?? 0);
        if (row) timeline.push(`+${((current.t - first[0].t) / 1000).toFixed(1)}s ${fixed(row.mbps)}Mb/s alvo ${fixed((out?.targetBitrate || 0) / 1e6)} est ${fixed(row.estimateMbps)} QP ${fixed(row.qp)} ${fixed(row.encodeFps)}fps${keyframes ? ` KEY${keyframes}` : ''}`);
        previous = current;
      }
    } else await wait(measureMs);
    const last = await Promise.all(instances.map((instance) => instance.page.evaluate('globalThis.__probeSnap()')));
    const endedAt = Date.now();
    if (phase === 'share-noprio') await sender.page.evaluate('globalThis.jumpDesktop?.setStreamPriority?.(true)');
    const gameWindow = gameLines.filter((line) => line.t > startedAt + 1000 && line.t <= endedAt);
    const gpuWindow = gpuSamples.filter((sample) => sample.t >= startedAt && sample.t <= endedAt);
    results.push({
      phase,
      game: {
        fps: gameWindow.reduce((sum, line) => sum + line.frames, 0) / Math.max(1, gameWindow.length),
        p99Ms: average(gameWindow.map((line) => line.p99Ms).filter(Number.isFinite)),
        worstMs: Math.max(0, ...gameWindow.map((line) => line.maxMs).filter(Number.isFinite)),
      },
      gpu: gpuWindow.length ? { gpu: average(gpuWindow.map((s) => s.gpu)), enc: average(gpuWindow.map((s) => s.enc)), dec: average(gpuWindow.map((s) => s.dec)) } : null,
      sender: senderSummary(first[0], last[0]),
      viewers: viewerInstances.map((viewer, index) => ({ viewer: viewer.role, rows: receiverSummary(first[index + 1], last[index + 1]) })),
      timeline,
    });
  }

  fs.writeFileSync(outputPath, JSON.stringify({ config: { viewers, sourceKind, gameLoad, senderEnv, senderArgs, warmupMs, measureMs }, results }, null, 2));
  const baseline = results.find((result) => result.phase === 'idle')?.game.fps;
  console.log(`\nJUMP game-impact probe · ${viewers} viewers · fonte ${sourceKind} · GAME_LOAD ${gameLoad}${Object.keys(senderEnv).length ? ` · ${JSON.stringify(senderEnv)}` : ''}${senderArgs.length ? ` · ${senderArgs.join(' ')}` : ''}`);
  for (const result of results) {
    const loss = baseline && result.phase !== 'idle' ? ` (${fixed((result.game.fps / baseline - 1) * 100, 0)}%)` : '';
    const gpu = result.gpu ? ` · GPU ${fixed(result.gpu.gpu, 0)}% NVENC ${fixed(result.gpu.enc, 0)}%` : '';
    console.log(`\n[${result.phase}] jogo ${fixed(result.game.fps, 0)} fps${loss} · p99 ${fixed(result.game.p99Ms)} ms · pior ${fixed(result.game.worstMs)} ms${gpu}`);
    for (const row of result.sender) {
      console.log(`  envio ${row.peer}: captura ${fixed(row.captureFps)} · encode ${fixed(row.encodeFps)} fps ${fixed(row.encodeMs)} ms · ${row.size} · ${fixed(row.mbps)} Mb/s (est ${fixed(row.estimateMbps)}) · QP ${fixed(row.qp)} ${row.limitedSeconds} · pli ${row.pli} nack ${row.nack} · ${row.encoder}`);
    }
    if (result.timeline.length) console.log(`  linha do tempo (sender, 1º viewer): ${result.timeline.join(' | ')}`);
    for (const viewer of result.viewers) {
      for (const row of viewer.rows) {
        console.log(`  ${viewer.viewer}: ${fixed(row.fps)} fps · intervalo ${fixed(row.intervalMs)}±${fixed(row.jitterMs)} ms · freezes ${row.freezes} (${fixed(row.freezeMs, 0)} ms) · decode ${fixed(row.decodeMs)} ms · buffer ${fixed(row.bufferMs, 0)} ms · perdidos ${row.lost} · ${row.size} · keyframes ${row.keyframes}`);
      }
    }
  }
  console.log(`\nJSON: ${outputPath}`);
}

main().catch((error) => {
  console.error(`[probe] falhou: ${error.stack || error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  shuttingDown = true;
  for (const child of children) killTree(child);
  await wait(1_000);
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

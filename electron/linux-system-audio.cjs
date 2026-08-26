const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const STARTUP_GRACE_MS = 120;

async function defaultMonitorSource() {
  try {
    const { stdout } = await execFileAsync('pactl', ['get-default-sink'], {
      timeout: 2_000,
      maxBuffer: 16 * 1024,
    });
    const sink = String(stdout || '').trim();
    if (sink) return `${sink}.monitor`;
  } catch {
    // The PulseAudio compatibility client may not be installed even when
    // PipeWire is available. Both backends below can still try their default.
  }
  return '@DEFAULT_MONITOR@';
}

function linuxAudioCommands(monitor = '@DEFAULT_MONITOR@') {
  return [
    {
      command: 'parec',
      args: [
        '--raw',
        '--format=s16le',
        `--rate=${SAMPLE_RATE}`,
        `--channels=${CHANNELS}`,
        `--device=${monitor}`,
        '--latency-msec=40',
        '--client-name=JUMP',
        '--stream-name=JUMP desktop audio',
      ],
    },
    {
      command: 'pw-record',
      args: [
        '--format=s16',
        `--rate=${SAMPLE_RATE}`,
        `--channels=${CHANNELS}`,
        '--media-category=Capture',
        `--target=${monitor}`,
        '-',
      ],
    },
  ];
}

function captureError(command, code, signal, stderr) {
  const details = String(stderr || '').trim();
  const reason = details || (signal ? `sinal ${signal}` : `código ${code}`);
  return new Error(`${command} não conseguiu capturar o áudio (${reason}).`);
}

function spawnLinuxAudioCapture(command, args, onChunk) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    let settled = false;
    let stopped = false;
    let startupTimer = null;

    const cleanupStartupTimer = () => {
      if (startupTimer) clearTimeout(startupTimer);
      startupTimer = null;
    };

    const fail = (error) => {
      cleanupStartupTimer();
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* Process may already have exited. */ }
      reject(error);
    };

    child.once('error', (error) => {
      fail(error);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
    });
    child.stdout?.on('data', (chunk) => {
      if (!stopped) onChunk(chunk);
    });
    child.once('close', (code, signal) => {
      if (!settled) fail(captureError(command, code, signal, stderr));
    });
    child.once('spawn', () => {
      startupTimer = setTimeout(() => {
        startupTimer = null;
        if (child.exitCode !== null || child.signalCode) {
          fail(captureError(command, child.exitCode, child.signalCode, stderr));
          return;
        }
        settled = true;
        resolve({
          stop() {
            if (stopped) return;
            stopped = true;
            cleanupStartupTimer();
            try { child.kill('SIGTERM'); } catch { /* Process may already have exited. */ }
          },
        });
      }, STARTUP_GRACE_MS);
    });
  });
}

async function startLinuxSystemAudio(onChunk) {
  const monitor = await defaultMonitorSource();
  let lastError = null;
  for (const { command, args } of linuxAudioCommands(monitor)) {
    try {
      return await spawnLinuxAudioCapture(command, args, onChunk);
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError?.message ? ` ${lastError.message}` : '';
  throw new Error(`Não foi possível capturar o áudio do sistema no Linux. Instale/ative PulseAudio ou PipeWire.${detail}`);
}

module.exports = { defaultMonitorSource, linuxAudioCommands, startLinuxSystemAudio };

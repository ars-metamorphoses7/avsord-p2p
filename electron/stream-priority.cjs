const os = require('node:os');
const { execFile } = require('node:child_process');

// While the user streams a heavy game, the game saturates the GPU and every
// CPU core. Windows then schedules JUMP's capture (browser process), the
// compositor/encoder (GPU process) and the WebRTC pipeline (renderer) behind
// it, and the stream collapses to a few frames per second even though the
// network and the hardware encoder are idle. OBS solves the same problem by
// raising its GPU scheduling class; do the same for the duration of a share.
// D3DKMT_SCHEDULINGPRIORITYCLASS: NORMAL = 2, HIGH = 4 (REALTIME needs admin).
const GPU_PRIORITY_NORMAL = 2;
const GPU_PRIORITY_HIGH = 4;
const BOOSTED_PROCESS_TYPES = new Set(['Browser', 'GPU', 'Tab']);
const BOOSTED_SERVICES = /video_capture|audio/i;

const GPU_PRIORITY_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Jump -Name Gpu -MemberDefinition '[DllImport("gdi32.dll")] public static extern int D3DKMTSetProcessSchedulingPriorityClass(IntPtr process, int priority);'
foreach ($id in $env:JUMP_STREAM_PIDS.Split(',')) {
  try {
    $process = [System.Diagnostics.Process]::GetProcessById([int]$id)
    $status = [Jump.Gpu]::D3DKMTSetProcessSchedulingPriorityClass($process.Handle, [int]$env:JUMP_STREAM_GPU_CLASS)
    Write-Output "$id=$status"
  } catch { Write-Output "$id=error" }
}`;

function streamProcessIds(metrics = []) {
  return metrics
    .filter((entry) => BOOSTED_PROCESS_TYPES.has(entry.type)
      || (entry.type === 'Utility' && BOOSTED_SERVICES.test(String(entry.serviceName || ''))))
    .map((entry) => entry.pid)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function setGpuPriority(pids, priorityClass) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', GPU_PRIORITY_SCRIPT], {
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, JUMP_STREAM_PIDS: pids.join(','), JUMP_STREAM_GPU_CLASS: String(priorityClass) },
    }, (error, stdout) => resolve(error ? `error: ${error.message}` : String(stdout).trim().replace(/\s+/g, ' ')));
  });
}

function createStreamPriority({ getAppMetrics, platform = process.platform, setPriority = os.setPriority, applyGpuPriority = setGpuPriority } = {}) {
  let active = false;
  let pending = Promise.resolve();
  const apply = async (nextActive) => {
    if (platform !== 'win32' || nextActive === active) return { applied: false, active };
    active = nextActive;
    const pids = streamProcessIds(getAppMetrics());
    const cpuPriority = nextActive ? os.constants.priority.PRIORITY_ABOVE_NORMAL : os.constants.priority.PRIORITY_NORMAL;
    for (const pid of pids) {
      try { setPriority(pid, cpuPriority); } catch { /* sandboxed or exited process */ }
    }
    const gpu = await applyGpuPriority(pids, nextActive ? GPU_PRIORITY_HIGH : GPU_PRIORITY_NORMAL);
    console.info(`[stream-priority] ${nextActive ? 'boost' : 'restore'} ${pids.join(',')} gpu: ${gpu}`);
    return { applied: true, active, pids, gpu };
  };
  return {
    set(nextActive) {
      pending = pending.then(() => apply(Boolean(nextActive)), () => apply(Boolean(nextActive)));
      return pending;
    },
    get active() { return active; },
  };
}

function setupStreamPriority({ app, ipcMain }) {
  const priority = createStreamPriority({ getAppMetrics: () => app.getAppMetrics() });
  ipcMain.handle('stream:priority', (_event, active) => priority.set(active));
  return priority;
}

module.exports = { createStreamPriority, setupStreamPriority, streamProcessIds };

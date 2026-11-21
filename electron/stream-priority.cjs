const os = require('node:os');
const { execFile } = require('node:child_process');

// While the user streams or watches over a heavy game, the game saturates the
// GPU and every CPU core. Windows 11 also applies EcoQoS (Power Throttling) to
// occluded background apps and schedules JUMP behind DX12 games, collapsing the
// stream to ~12 FPS even when the network and NVENC have headroom. Raise CPU
// priority, request REALTIME GPU scheduling (with HIGH/ABOVE_NORMAL fallback),
// and disable Windows Power Throttling for the duration of an active stream.
// D3DKMT_SCHEDULINGPRIORITYCLASS: NORMAL = 2, ABOVE_NORMAL = 3, HIGH = 4, REALTIME = 5.
const GPU_PRIORITY_NORMAL = 2;
const GPU_PRIORITY_HIGH = 4;
const GPU_PRIORITY_REALTIME = 5;
const BOOSTED_PROCESS_TYPES = new Set(['Browser', 'GPU', 'Tab']);
const HIGH_CPU_PROCESS_TYPES = new Set(['GPU']);
const BOOSTED_SERVICES = /video_capture|audio/i;

const GPU_PRIORITY_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Jump -Name Gpu -MemberDefinition '
[StructLayout(LayoutKind.Sequential)]
public struct PROCESS_POWER_THROTTLING_STATE {
  public uint Version;
  public uint ControlMask;
  public uint StateMask;
}
[DllImport("gdi32.dll")] public static extern int D3DKMTSetProcessSchedulingPriorityClass(IntPtr process, int priority);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetProcessInformation(IntPtr process, int infoClass, ref PROCESS_POWER_THROTTLING_STATE info, uint size);
'
$targetClass = [int]$env:JUMP_STREAM_GPU_CLASS
$disableThrottle = ($env:JUMP_STREAM_BOOST -eq '1')
$throttle = New-Object Jump.Gpu+PROCESS_POWER_THROTTLING_STATE
$throttle.Version = 1
$throttle.ControlMask = if ($disableThrottle) { 5 } else { 0 }
$throttle.StateMask = 0
foreach ($id in $env:JUMP_STREAM_PIDS.Split(',')) {
  if (-not $id) { continue }
  try {
    $process = [System.Diagnostics.Process]::GetProcessById([int]$id)
    $handle = $process.Handle
    $applied = $targetClass
    $status = [Jump.Gpu]::D3DKMTSetProcessSchedulingPriorityClass($handle, $targetClass)
    if ($status -ne 0 -and $targetClass -gt 4) {
      $applied = 4
      $status = [Jump.Gpu]::D3DKMTSetProcessSchedulingPriorityClass($handle, 4)
    }
    if ($status -ne 0 -and $targetClass -gt 3) {
      $applied = 3
      $status = [Jump.Gpu]::D3DKMTSetProcessSchedulingPriorityClass($handle, 3)
    }
    $eco = [Jump.Gpu]::SetProcessInformation($handle, 4, [ref]$throttle, 12)
    Write-Output "$id=c$($applied):$status,eco:$eco"
  } catch { Write-Output "$id=error" }
}`;

function streamProcessIds(metrics = []) {
  return metrics
    .filter((entry) => BOOSTED_PROCESS_TYPES.has(entry.type)
      || (entry.type === 'Utility' && BOOSTED_SERVICES.test(String(entry.serviceName || ''))))
    .map((entry) => entry.pid)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function highCpuProcessIds(metrics = [], extraPids = []) {
  const fromMetrics = metrics
    .filter((entry) => HIGH_CPU_PROCESS_TYPES.has(entry.type))
    .map((entry) => entry.pid)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  return new Set([...fromMetrics, ...extraPids]);
}

function setGpuPriority(pids, priorityClass, boost = priorityClass > GPU_PRIORITY_NORMAL) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', GPU_PRIORITY_SCRIPT], {
      windowsHide: true,
      timeout: 15_000,
      env: {
        ...process.env,
        JUMP_STREAM_PIDS: pids.join(','),
        JUMP_STREAM_GPU_CLASS: String(priorityClass),
        JUMP_STREAM_BOOST: boost ? '1' : '0',
      },
    }, (error, stdout) => resolve(error ? `error: ${error.message}` : String(stdout).trim().replace(/\s+/g, ' ')));
  });
}

function createStreamPriority({
  getAppMetrics,
  getExtraPids = () => [],
  platform = process.platform,
  setPriority = os.setPriority,
  applyGpuPriority = setGpuPriority,
} = {}) {
  let active = false;
  let pending = Promise.resolve();
  const apply = async (nextActive, force = false) => {
    if (platform !== 'win32' || (!force && nextActive === active)) return { applied: false, active };
    active = nextActive;
    const metrics = getAppMetrics() || [];
    const extraPids = (getExtraPids() || []).filter((pid) => Number.isInteger(pid) && pid > 0);
    const pids = [...new Set([...streamProcessIds(metrics), ...extraPids])];
    const highCpuPids = highCpuProcessIds(metrics, extraPids);
    for (const pid of pids) {
      const cpuPriority = nextActive
        ? (highCpuPids.has(pid) ? os.constants.priority.PRIORITY_HIGH : os.constants.priority.PRIORITY_ABOVE_NORMAL)
        : os.constants.priority.PRIORITY_NORMAL;
      try { setPriority(pid, cpuPriority); } catch { /* sandboxed or exited process */ }
    }
    const gpu = await applyGpuPriority(pids, nextActive ? GPU_PRIORITY_REALTIME : GPU_PRIORITY_NORMAL, nextActive);
    console.info(`[stream-priority] ${nextActive ? 'boost' : 'restore'} ${pids.join(',')} gpu: ${gpu}`);
    return { applied: true, active, pids, gpu };
  };
  return {
    set(nextActive) {
      pending = pending.then(() => apply(Boolean(nextActive)), () => apply(Boolean(nextActive)));
      return pending;
    },
    refresh() {
      pending = pending.then(() => (active ? apply(true, true) : { applied: false, active }));
      return pending;
    },
    get active() { return active; },
  };
}

function setupStreamPriority({ app, ipcMain, getExtraPids = () => [] }) {
  const priority = createStreamPriority({ getAppMetrics: () => app.getAppMetrics(), getExtraPids });
  ipcMain.handle('stream:priority', (_event, active) => priority.set(active));
  return priority;
}

module.exports = {
  GPU_PRIORITY_HIGH,
  GPU_PRIORITY_NORMAL,
  GPU_PRIORITY_REALTIME,
  createStreamPriority,
  setupStreamPriority,
  streamProcessIds,
};

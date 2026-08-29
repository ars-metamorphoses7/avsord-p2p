const fs = require('node:fs/promises');

const STREAM_DIAGNOSTICS_SWITCH = '--jump-stream-diagnostics';

function isEnvironmentDiagnosticsEnabled(environment = process.env) {
  return String(environment?.JUMP_STREAM_DIAGNOSTICS || '').trim() === '1';
}

function hasDiagnosticsSwitch(argv = process.argv) {
  return Array.isArray(argv) && argv.includes(STREAM_DIAGNOSTICS_SWITCH);
}

function resolveStreamDiagnosticsActivation({ environment = process.env, argv = process.argv } = {}) {
  if (isEnvironmentDiagnosticsEnabled(environment)) {
    return {
      enabled: true,
      activationSource: 'environment',
      forcedByEnvironment: true,
    };
  }
  if (hasDiagnosticsSwitch(argv)) {
    return {
      enabled: true,
      activationSource: 'cli',
      forcedByEnvironment: false,
    };
  }
  return {
    enabled: false,
    activationSource: 'off',
    forcedByEnvironment: false,
  };
}

// The production preload already consumes this environment value. Normalizing
// the CLI switch into it before a BrowserWindow exists keeps one diagnostics
// implementation for renderer and main instead of a parallel CLI-only path.
function normalizeDiagnosticsEnvironment(activation, environment = process.env) {
  if (activation?.enabled) environment.JUMP_STREAM_DIAGNOSTICS = '1';
  return activation;
}

function isDeepLinkArgument(argument) {
  return typeof argument === 'string' && argument.startsWith('jump://');
}

function fieldDiagnosticsRelaunchArguments(argv = process.argv, enabled) {
  const currentArguments = Array.isArray(argv) ? argv.slice(1) : [];
  const preserved = currentArguments.filter((argument) => (
    argument !== STREAM_DIAGNOSTICS_SWITCH && !isDeepLinkArgument(argument)
  ));
  if (enabled) preserved.push(STREAM_DIAGNOSTICS_SWITCH);
  return preserved;
}

function requestFieldDiagnosticsRelaunch({ app, action, activation, argv = process.argv } = {}) {
  if (!['enable', 'disable'].includes(action)) throw new Error('Ação de diagnóstico inválida.');
  if (!app?.relaunch || !app?.quit) throw new Error('Relaunch do aplicativo indisponível.');
  if (action === 'disable' && activation?.forcedByEnvironment) {
    return {
      relaunchRequested: false,
      reason: 'environment-forced',
      activationSource: 'environment',
    };
  }
  const args = fieldDiagnosticsRelaunchArguments(argv, action === 'enable');
  app.relaunch({ args });
  app.quit();
  return {
    relaunchRequested: true,
    action,
    args,
    activationSource: action === 'enable' ? 'cli' : 'off',
  };
}

function normalizeBuildCommit(value) {
  const normalized = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$/.test(normalized) ? normalized : null;
}

function normalizeBuildVersion(value) {
  const normalized = String(value || '').trim();
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : null;
}

function normalizeBuildMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const version = normalizeBuildVersion(value.version);
  const commit = normalizeBuildCommit(value.commit);
  if (!version && !commit) return null;
  return {
    version,
    commit,
    builtAt: typeof value.builtAt === 'string' && value.builtAt.trim() ? value.builtAt.trim() : null,
  };
}

async function readBuildMetadata(filePath, readFile = fs.readFile) {
  try {
    return normalizeBuildMetadata(JSON.parse(await readFile(filePath, 'utf8')));
  } catch {
    return null;
  }
}

function resolveDiagnosticsBuildInfo({ appVersion = null, commitOverride = null, buildMetadata = null } = {}) {
  const metadata = normalizeBuildMetadata(buildMetadata);
  return {
    appVersion: metadata?.version || normalizeBuildVersion(appVersion) || null,
    appCommit: normalizeBuildCommit(commitOverride) || metadata?.commit || null,
  };
}

async function openFieldDiagnosticsDirectory({ outputDirectory, mkdir = fs.mkdir, openPath } = {}) {
  if (!outputDirectory || typeof openPath !== 'function') throw new Error('Pasta de diagnóstico indisponível.');
  await mkdir(outputDirectory, { recursive: true });
  const error = await openPath(outputDirectory);
  return {
    opened: !error,
    outputDirectory,
    error: error || null,
  };
}

module.exports = {
  STREAM_DIAGNOSTICS_SWITCH,
  fieldDiagnosticsRelaunchArguments,
  hasDiagnosticsSwitch,
  isEnvironmentDiagnosticsEnabled,
  normalizeBuildCommit,
  normalizeBuildMetadata,
  normalizeDiagnosticsEnvironment,
  openFieldDiagnosticsDirectory,
  readBuildMetadata,
  requestFieldDiagnosticsRelaunch,
  resolveDiagnosticsBuildInfo,
  resolveStreamDiagnosticsActivation,
};

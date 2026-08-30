const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');

const STREAM_DIAGNOSTICS_SWITCH = '--jump-stream-diagnostics';
const FIELD_DIAGNOSTICS_PREFERENCE_FILENAME = 'field-diagnostics.json';

function isEnvironmentDiagnosticsEnabled(environment = process.env) {
  return String(environment?.JUMP_STREAM_DIAGNOSTICS || '').trim() === '1';
}

function hasDiagnosticsSwitch(argv = process.argv) {
  return Array.isArray(argv) && argv.includes(STREAM_DIAGNOSTICS_SWITCH);
}

function normalizeFieldDiagnosticsPreference(value) {
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object' && typeof value.enabled === 'boolean') {
    return value.enabled;
  }
  return null;
}

function fieldDiagnosticsPreferencePath(userDataDirectory) {
  const directory = String(userDataDirectory || '').trim();
  if (!directory) throw new Error('Diretório de dados do JUMP indisponível.');
  return path.join(directory, FIELD_DIAGNOSTICS_PREFERENCE_FILENAME);
}

async function readFieldDiagnosticsPreference(filePath, readFile = fs.readFile) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    const enabled = normalizeFieldDiagnosticsPreference(parsed);
    return enabled === null ? null : { enabled };
  } catch {
    return null;
  }
}

async function writeFieldDiagnosticsPreference(
  filePath,
  enabled,
  { mkdir = fs.mkdir, writeFile = fs.writeFile } = {},
) {
  if (typeof enabled !== 'boolean') throw new TypeError('A preferência de diagnóstico deve ser booleana.');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ enabled }, null, 2)}\n`, 'utf8');
  return { filePath, enabled };
}

function resolveStreamDiagnosticsActivation({
  environment = process.env,
  argv = process.argv,
  persistedPreference = null,
} = {}) {
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
  if (normalizeFieldDiagnosticsPreference(persistedPreference) === true) {
    return {
      enabled: true,
      activationSource: 'preference',
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
// the resolved main-process activation before a BrowserWindow exists keeps one
// diagnostics implementation for renderer and main instead of parallel state.
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

function resolveFieldDiagnosticsRelaunchOptions({
  platform = process.platform,
  environment = process.env,
  argv = process.argv,
} = {}) {
  const options = {
    // The preference is the durable source for UI actions. The legacy switch
    // remains accepted when a developer/test launches the app directly.
    args: fieldDiagnosticsRelaunchArguments(argv, false),
  };
  const appImagePath = String(environment?.APPIMAGE || '').trim();
  if (platform === 'linux' && appImagePath) options.execPath = appImagePath;
  return options;
}

async function resolveValidAppImagePath(
  environment = process.env,
  access = fs.access,
) {
  const candidate = String(environment?.APPIMAGE || '').trim();
  if (!candidate) return '';
  try {
    await access(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return '';
  }
}

async function requestFieldDiagnosticsRelaunch({
  app,
  action,
  activation,
  argv = process.argv,
  platform = process.platform,
  environment = process.env,
  preferencePath,
  writePreference = writeFieldDiagnosticsPreference,
  access = fs.access,
} = {}) {
  if (!['enable', 'disable'].includes(action)) throw new Error('Ação de diagnóstico inválida.');
  if (!app?.relaunch || !app?.quit) throw new Error('Relaunch do aplicativo indisponível.');
  if (action === 'disable' && activation?.forcedByEnvironment) {
    return {
      relaunchRequested: false,
      reason: 'environment-forced',
      activationSource: 'environment',
    };
  }
  if (!preferencePath) throw new Error('Arquivo de preferência de diagnóstico indisponível.');
  const enabled = action === 'enable';
  // Persist first so a later manual launch still reflects the user's choice,
  // even if Electron cannot restart the current process.
  await writePreference(preferencePath, enabled);
  if (!enabled && activation?.forcedByEnvironment !== true) {
    // normalizeDiagnosticsEnvironment may have set this for a CLI or
    // preference activation. Do not let that normalized value force the next
    // process after the user explicitly disables diagnostics.
    delete environment.JUMP_STREAM_DIAGNOSTICS;
  }
  const appImagePath = platform === 'linux'
    ? await resolveValidAppImagePath(environment, access)
    : '';
  const relaunchOptions = resolveFieldDiagnosticsRelaunchOptions({
    platform,
    environment: { ...environment, APPIMAGE: appImagePath },
    argv,
  });
  try {
    app.relaunch(relaunchOptions);
    app.quit();
    return {
      relaunchRequested: true,
      action,
      args: relaunchOptions.args,
      execPath: relaunchOptions.execPath || null,
      activationSource: enabled ? 'preference' : 'off',
    };
  } catch (error) {
    return {
      relaunchRequested: false,
      action,
      reason: 'relaunch-failed',
      preferencePersisted: true,
      error: error?.message || 'Relaunch falhou.',
    };
  }
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
  FIELD_DIAGNOSTICS_PREFERENCE_FILENAME,
  fieldDiagnosticsRelaunchArguments,
  fieldDiagnosticsPreferencePath,
  hasDiagnosticsSwitch,
  isEnvironmentDiagnosticsEnabled,
  normalizeFieldDiagnosticsPreference,
  normalizeBuildCommit,
  normalizeBuildMetadata,
  normalizeDiagnosticsEnvironment,
  openFieldDiagnosticsDirectory,
  readFieldDiagnosticsPreference,
  readBuildMetadata,
  resolveFieldDiagnosticsRelaunchOptions,
  resolveValidAppImagePath,
  requestFieldDiagnosticsRelaunch,
  resolveDiagnosticsBuildInfo,
  resolveStreamDiagnosticsActivation,
  writeFieldDiagnosticsPreference,
};

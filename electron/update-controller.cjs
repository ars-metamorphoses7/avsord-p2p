function errorMessage(error) {
  return error?.message || String(error || 'Falha desconhecida ao atualizar.');
}

function createUpdateController({ autoUpdater, isPackaged, sendState, scheduleInstall = setImmediate }) {
  let revision = 0;
  let state = { status: 'idle', revision };
  let checkPromise = null;
  let downloadPromise = null;

  const publish = (nextState) => {
    state = { ...state, ...nextState, revision: ++revision };
    sendState?.({ ...state });
    return { ...state };
  };

  const fail = (error) => publish({ status: 'error', message: errorMessage(error) });

  autoUpdater.on('checking-for-update', () => publish({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => publish({
    status: 'available',
    version: info?.version || '',
    percent: 0,
  }));
  autoUpdater.on('update-not-available', (info) => publish({
    status: 'not-available',
    version: info?.version || '',
    percent: 0,
  }));
  autoUpdater.on('download-progress', (progress) => publish({
    status: 'downloading',
    percent: Math.max(0, Math.min(100, Math.round(Number(progress?.percent) || 0))),
    transferred: Number(progress?.transferred) || 0,
    total: Number(progress?.total) || 0,
    bytesPerSecond: Number(progress?.bytesPerSecond) || 0,
  }));
  autoUpdater.on('update-downloaded', (info) => publish({
    status: 'downloaded',
    version: info?.version || state.version || '',
    downloadedFile: info?.downloadedFile || '',
    percent: 100,
  }));
  autoUpdater.on('error', fail);

  async function check() {
    if (!isPackaged) {
      return publish({ status: 'dev', message: 'Atualizações só funcionam no aplicativo empacotado.' });
    }
    if (checkPromise) return checkPromise;

    publish({ status: 'checking', message: '' });
    checkPromise = (async () => {
      try {
        await autoUpdater.checkForUpdates();
      } catch (error) {
        if (state.status !== 'error' || state.message !== errorMessage(error)) fail(error);
      }
      return { ...state };
    })().finally(() => {
      checkPromise = null;
    });
    return checkPromise;
  }

  async function download() {
    if (!isPackaged) return publish({ status: 'dev' });
    if (downloadPromise) return downloadPromise;

    publish({ status: 'downloading', percent: 0, transferred: 0, total: 0, bytesPerSecond: 0, message: '' });
    downloadPromise = (async () => {
      try {
        const downloadedFiles = await autoUpdater.downloadUpdate();
        // electron-updater normally emits update-downloaded before resolving.
        // Keep the UI correct even if a provider resolves without that event.
        if (state.status !== 'downloaded') {
          publish({
            status: 'downloaded',
            downloadedFile: downloadedFiles?.[0] || '',
            percent: 100,
          });
        }
      } catch (error) {
        if (state.status !== 'error' || state.message !== errorMessage(error)) fail(error);
      }
      return { ...state };
    })().finally(() => {
      downloadPromise = null;
    });
    return downloadPromise;
  }

  function install() {
    if (!isPackaged) return publish({ status: 'dev' });
    if (state.status !== 'downloaded') {
      return publish({ status: 'error', message: 'A atualização ainda não terminou de baixar.' });
    }

    // BaseUpdater uses this property for a non-silent install. Setting it here
    // makes reopening after the NSIS installer explicit instead of relying on
    // the library default.
    autoUpdater.autoRunAppAfterInstall = true;
    const installingState = publish({ status: 'installing', message: 'Instalando e reabrindo o JUMP…' });
    scheduleInstall(() => autoUpdater.quitAndInstall(false, true));
    return installingState;
  }

  return {
    check,
    download,
    getState: () => ({ ...state }),
    install,
  };
}

module.exports = { createUpdateController };

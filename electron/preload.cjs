const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jumpDesktop', {
  isDesktop: true,
  // electron . (desenvolvimento) define defaultApp; no pacote distribuído ele é falso.
  isPackaged: !process.defaultApp,
  getWindowState: () => ipcRenderer.invoke('window:state'),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  getDesktopSources: () => ipcRenderer.invoke('desktop:sources'),
  onWindowState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.removeListener('window:state', listener);
  },
  getInviteUrl: (roomId) => ipcRenderer.invoke('invite:url', roomId),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },
});

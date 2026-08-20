const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jumpDesktop', {
  isDesktop: true,
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

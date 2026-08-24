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
  getMediaCapabilities: () => ipcRenderer.invoke('media:capabilities'),
  startDesktopAudio: (target) => ipcRenderer.invoke('desktop:audio-start', target),
  stopDesktopAudio: () => ipcRenderer.invoke('desktop:audio-stop'),
  onDesktopAudioData: (callback) => {
    const listener = (_event, chunk) => callback(chunk);
    ipcRenderer.on('desktop:audio-data', listener);
    return () => ipcRenderer.removeListener('desktop:audio-data', listener);
  },
  onWindowState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.removeListener('window:state', listener);
  },
  getInviteUrl: (roomId, signalOrigin = '') => ipcRenderer.invoke('invite:url', roomId, signalOrigin),
  rememberRoomSession: (session) => ipcRenderer.invoke('room-session:remember', session),
  forgetRoomSession: (session) => ipcRenderer.invoke('room-session:forget', session),
  getRecentRoomSessions: () => ipcRenderer.invoke('room-session:list'),
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },
});

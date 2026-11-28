const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localAgent', {
  getUrl: () => ipcRenderer.invoke('get-url'),
  setUrl: (url) => ipcRenderer.invoke('set-url', url),
  setBackground: (color) => ipcRenderer.invoke('set-background', color),
  openSetup: (message) => ipcRenderer.invoke('open-setup', message),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  openReleasePage: () => ipcRenderer.invoke('open-release-page'),
  notify: (payload) => ipcRenderer.invoke('show-notification', payload),
  onNotificationClick: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('notification-click', listener);
    return () => ipcRenderer.removeListener('notification-click', listener);
  },
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },
});

// Lets the web app make its header the window's title bar (drag region, room for the window controls).
const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
window.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.desktop = platform; });

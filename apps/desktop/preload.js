const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localAgent', {
  getUrl: () => ipcRenderer.invoke('get-url'),
  setUrl: (url) => ipcRenderer.invoke('set-url', url),
  setBackground: (color) => ipcRenderer.invoke('set-background', color),
});

// Lets the web app make its header the window's title bar (drag region, room for the window controls).
const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
window.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.desktop = platform; });

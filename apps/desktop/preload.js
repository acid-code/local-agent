const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localAgent', {
  getUrl: () => ipcRenderer.invoke('get-url'),
  setUrl: (url) => ipcRenderer.invoke('set-url', url),
});

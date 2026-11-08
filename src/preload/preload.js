'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorder', {
  send(channel, ...args) {
    ipcRenderer.send(channel, ...args);
  },
  invoke(channel, ...args) {
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, handler) {
    const listener = (_event, ...args) => handler(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});

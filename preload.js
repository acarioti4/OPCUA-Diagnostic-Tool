const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  runProbe: (cfg) => ipcRenderer.send('run-probe', cfg),
  cancelProbe: () => ipcRenderer.send('cancel-probe'),
  onProbeEvent: (cb) => ipcRenderer.on('probe-event', (e, msg) => cb(msg))
});

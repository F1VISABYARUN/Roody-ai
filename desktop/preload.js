const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, value) => ipcRenderer.invoke(name, value);
contextBridge.exposeInMainWorld('roody', {
  state: () => invoke('state'), memory: action => invoke('memory', action),
  saveKey: payload => invoke('save-key', payload), removeKey: () => invoke('remove-key'),
  ask: payload => invoke('ask', payload), voice: () => invoke('voice'),
  sources: () => invoke('sources'), capture: id => invoke('capture', id),
  follow: id => invoke('follow', id), delegate: payload => invoke('delegate', payload),
  expand: open => invoke('expand', open), reminder: minutes => invoke('reminder', minutes),
  quit: () => invoke('quit'),
  on: (name, callback) => {
    if (!['context', 'job', 'reminder', 'context-error'].includes(name)) return;
    const listener = (_, data) => callback(data);
    ipcRenderer.on(name, listener);
    return () => ipcRenderer.removeListener(name, listener);
  }
});

const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['state', 'refresh', 'detail', 'research:get', 'research:open', 'watch:add', 'watch:remove', 'trade', 'order', 'cancel', 'risk', 'settings', 'strategy:buy', 'strategy:settings', 'screener:meta', 'screener:parse', 'screener:status', 'screener:cancel', 'screener:history', 'screener:run', 'screener:open', 'reset', 'backup', 'export', 'folder']);
contextBridge.exposeInMainWorld('guanlan', {
  call: (name, payload) => { if (!allowed.has(name)) return Promise.reject(Error('未知操作')); return ipcRenderer.invoke(name, payload); },
  subscribe: callback => { const listener = (_, s) => callback(s); ipcRenderer.on('state', listener); return () => ipcRenderer.removeListener('state', listener); }
});

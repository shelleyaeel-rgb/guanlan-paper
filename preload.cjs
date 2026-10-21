const { contextBridge, ipcRenderer } = require('electron');
// Read-only operating-metric inspection uses the same restricted IPC bridge.
const allowed = new Set(['state', 'refresh', 'detail', 'research:get', 'research:open', 'watch:add', 'watch:remove', 'trade', 'order', 'cancel', 'risk', 'settings', 'strategy:buy', 'strategy:select', 'strategy:settings', 'screener:meta', 'screener:parse', 'screener:status', 'screener:cancel', 'screener:history', 'screener:run', 'screener:open', 'reset', 'backup', 'export', 'folder']);
for (const name of ['agency:transfer', 'agency:configure', 'agency:mode', 'agency:member', 'agency:members:add', 'agency:reconcile', 'agency:verify', 'agency:run', 'agency:pool:run', 'agency:pool:retry', 'agency:pool:cancel', 'agency:pool:status']) allowed.add(name);
for (const name of ['evidence:list', 'evidence:save', 'evidence:remove', 'evidence:open']) allowed.add(name);
allowed.add('research:inspect');
allowed.add('capital:add');
allowed.add('view:state'); allowed.add('view:refresh');
allowed.add('view:subscribe');
contextBridge.exposeInMainWorld('guanlan', {
  call: (name, payload) => { if (!allowed.has(name)) return Promise.reject(Error('未知操作')); return ipcRenderer.invoke(name, payload); },
  subscribe: callback => { const listener = (_, s) => callback(s); ipcRenderer.on('state', listener); return () => ipcRenderer.removeListener('state', listener); },
  subscribeView: callback => { const listener = (_, packet) => callback(packet); ipcRenderer.on('view:patch', listener); return () => ipcRenderer.removeListener('view:patch', listener); },
  subscribeAgencyPoolProgress: callback => { const listener = (_, progress) => callback(progress); ipcRenderer.on('agency:pool:progress', listener); return () => ipcRenderer.removeListener('agency:pool:progress', listener); }
});

// No production IPC is exposed by the isolated renderer fixture.
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('guanlan', {
  call: () => new Promise(() => {}), subscribe: () => {}, subscribeAgencyPoolProgress: () => {}
});

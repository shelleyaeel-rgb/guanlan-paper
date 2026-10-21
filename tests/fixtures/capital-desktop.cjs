'use strict';
// Faults and logs are restricted to the isolated capital-entry UI harness.
const fs = require('node:fs'), path = require('node:path');
const { app, ipcMain } = require('electron');
const arg = process.argv.find(value => value.startsWith('--test-data-dir='));
if (!arg || !process.env.GUANLAN_TEST_CONTROL || !process.env.GUANLAN_CAPITAL_LOG) throw Error('Capital UI tests require isolated paths');
const accountDirectory = path.resolve(arg.slice('--test-data-dir='.length));
const control = () => JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, listener) => handle(name, async (...args) => {
  const scenario = control();
  if (scenario.blockCapitalView && ['state', 'view:state', 'view:subscribe'].includes(name)) throw Error('隔离测试：状态回复中断');
  if (name !== 'capital:add') return listener(...args);
  fs.appendFileSync(process.env.GUANLAN_CAPITAL_LOG, JSON.stringify(args[1]) + '\n');
  if (scenario.capitalMode === 'before') throw Error('隔离测试：提交回复中断');
  const result = await listener(...args);
  if (scenario.capitalMode === 'after') throw Error('隔离测试：入账回复中断');
  return result;
});
app.on('browser-window-created', (_, window) => {
  const send = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, ...args) => {
    if (control().blockCapitalView && ['state', 'view:patch'].includes(channel)) return;
    send(channel, ...args);
  };
});
const { Store } = require('../../core/store.cjs');
const save = Store.prototype.save;
Store.prototype.save = function(...args) {
  if (control().capitalMode === 'save-failure' && path.resolve(this.file) === path.join(accountDirectory, 'account.json'))
    throw Error('隔离测试：账户写入失败');
  return save.apply(this, args);
};
require('./agency-desktop.cjs');

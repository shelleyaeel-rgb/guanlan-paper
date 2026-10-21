// Real desktop IPC with fixture-only market data and an explicitly isolated account.
const fs = require('node:fs');
const { net, ipcMain } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');
const controlPath = process.env.GUANLAN_TEST_CONTROL;
if (!controlPath || !process.argv.some(arg => arg.startsWith('--test-data-dir='))) throw Error('Screener agency tests require isolated control and account paths');
const control = () => JSON.parse(fs.readFileSync(controlPath, 'utf8'));
net.fetch = async url => {
  if (process.env.GUANLAN_TEST_NETWORK_LOG) fs.appendFileSync(process.env.GUANLAN_TEST_NETWORK_LOG, JSON.stringify({ url: String(url) }) + '\n');
  throw Error('The isolated fixture blocks all unexpected network requests');
};
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, listener) => handle(name, async (event, payload) => {
  if (name === 'agency:members:add' && process.env.GUANLAN_TEST_BATCH_LOG) {
    fs.appendFileSync(process.env.GUANLAN_TEST_BATCH_LOG, JSON.stringify(payload) + '\n');
  }
  return listener(event, payload);
});
require('./strategy-screener-desktop.cjs');
const { Screener } = require('../../core/screener.cjs');
const screenPage = Screener.prototype.page;
Screener.prototype.page = async function(...args) {
  if (control().screenDelay) await delay(control().screenDelay);
  return screenPage.apply(this, args);
};
const { Market } = require('../../core/market.cjs');
const quotes = Market.prototype.quotes;
Market.prototype.quotes = async function(symbols) {
  const scenario = control();
  if (scenario.quoteDelay) await delay(scenario.quoteDelay);
  const result = await quotes.call(this, symbols);
  for (const symbol of scenario.quoteMissing || []) delete result[symbol];
  return result;
};

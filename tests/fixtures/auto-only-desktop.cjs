'use strict';
const fs = require('node:fs');
const { app, ipcMain, session } = require('electron');
if (!process.env.GUANLAN_TEST_CONTROL || !process.env.GUANLAN_TEST_SOURCE_LOG || !process.env.GUANLAN_TEST_NETWORK_LOG
  || !process.argv.some(argument => argument.startsWith('--test-data-dir='))) throw Error('Automatic-only UI fixture requires isolated account and log paths');
const scenario = () => JSON.parse(fs.readFileSync(process.env.GUANLAN_TEST_CONTROL, 'utf8'));
const record = (kind, data = {}) => fs.appendFileSync(process.env.GUANLAN_TEST_SOURCE_LOG, JSON.stringify({ kind, ...data }) + '\n');
const blocked = url => { fs.appendFileSync(process.env.GUANLAN_TEST_NETWORK_LOG, JSON.stringify({ url: String(url) }) + '\n'); throw Error('Isolated UI fixture blocks unexpected network'); };
global.fetch = async url => blocked(url);
for (const name of ['node:http', 'node:https']) { const transport = require(name); transport.request = transport.get = url => blocked(url); }
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
  const external = /^(https?|wss?):/i.test(details.url);
  if (external) fs.appendFileSync(process.env.GUANLAN_TEST_NETWORK_LOG, JSON.stringify({ url: details.url }) + '\n');
  callback({ cancel: external });
}));
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, listener) => handle(name, (event, ...args) => { if (name !== 'state') record('ipc', { name }); return listener(event, ...args); });
require('./agency-capacity-desktop.cjs');
const { Market } = require('../../core/market.cjs');
const originalQuotes = Market.prototype.quotes;
Market.prototype.quotes = async function(symbols) { record('quotes', { symbols }); return originalQuotes.call(this, symbols); };
const { FreeScreenerSource } = require('../../core/screener-sources.cjs');
FreeScreenerSource.prototype.prepareUniverse = async function() {
  return { symbols: scenario().poolSymbols, sourceCount: scenario().poolSymbols.length, excludedCount: 0, source: '隔离证券名单', validatedAt: Date.now(), date: scenario().now.slice(0, 10) };
};
FreeScreenerSource.prototype.loadBreadth = FreeScreenerSource.prototype.load = async function() {
  const rows = Array.from({ length: 1200 }, (_, index) => ({ symbol: `sh${603000 + index}`, name: `隔离广度 ${index}`, price: 10, prevClose: 10, changePct: index < 800 ? 1 : -1, timestamp: Date.now() }));
  return { rows, source: '隔离全市场广度', sourceCount: rows.length, excludedCount: 0, startedAt: Date.now(), fetchedAt: Date.now() };
};

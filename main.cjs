const { app, BrowserWindow, ipcMain, dialog, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Engine, initialState } = require('./core/engine.cjs');
const { Store } = require('./core/store.cjs');
const { Market } = require('./core/market.cjs');
const { analyze } = require('./core/analysis.cjs');
const { symbolOf, session, cnTime } = require('./core/common.cjs');
const testDirArg = process.argv.find(a => a.startsWith('--test-data-dir='));
if (testDirArg && !app.isPackaged) app.setPath('userData', testDirArg.split('=').slice(1).join('='));
if (!app.requestSingleInstanceLock()) app.quit();
let win, store, engine, market, timer, refreshing, fatal = '', quotes = {}, connection = { ok: false, message: '正在连接行情服务', at: null };
const indices = ['sh000001', 'sz399001', 'sz399006'];
function state() { return { account: engine.s, stats: engine.stats(quotes), quotes: { ...engine.s.marks, ...quotes }, connection, session: session(), date: cnTime().date, now: Date.now(), dataPath: app.getPath('userData'), warning: fatal || store.warning }; }
function publish() { if (win && !win.isDestroyed()) win.webContents.send('state', state()); }
function transaction(fn) {
  if (fatal) throw Error(fatal);
  const before = structuredClone(engine.s);
  try { const result = fn(); store.save(engine.s); return result; }
  catch (e) { engine.s = before; throw e; }
}
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const symbols = [...new Set([...engine.s.watchlist, ...engine.s.lots.map(l => l.symbol), ...engine.s.orders.filter(o => o.status === 'pending').map(o => o.symbol), ...indices])];
    try {
      const batch = await market.quotes(symbols); Object.assign(quotes, batch);
      const missing = symbols.filter(s => !batch[s]);
      connection = { ok: true, message: missing.length ? `${missing.length} 只股票暂缺报价` : '行情接口已连接', at: Date.now() };
      try { transaction(() => engine.tick(batch)); } catch (e) { fatal = `账户保存失败，交易已暂停：${e.message}`; }
    } catch (e) { connection = { ok: false, message: `行情连接失败：${e.message}`, at: connection.at }; }
    publish(); return state();
  })().finally(() => { refreshing = null; });
  return refreshing;
}
function startTimer() { clearInterval(timer); timer = setInterval(refresh, engine.s.settings.refreshSeconds * 1000); }
function handler(name, fn) {
  ipcMain.handle(name, async (event, payload) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return { ok: false, error: '无效窗口来源' };
    try { return { ok: true, data: await fn(payload) }; } catch (e) { return { ok: false, error: e.message }; }
  });
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  try { engine = new Engine(store.load() || initialState()); store.save(engine.s); }
  catch (e) { dialog.showErrorBox('观澜 · 账户无法载入', `${e.message}\n数据目录：${app.getPath('userData')}`); app.quit(); return; }
  market = new Market((url, opts) => net.fetch(url, opts));
  win = new BrowserWindow({ width: 1536, height: 980, minWidth: 1120, minHeight: 760, backgroundColor: '#0b1220', title: '观澜 · A股模拟交易', icon: path.join(__dirname, 'assets/icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  handler('state', () => state());
  handler('refresh', refresh);
  handler('detail', async input => {
    const symbol = symbolOf(input.symbol), history = await market.history(symbol, !!input.force);
    let minute = null, minuteError = null;
    try { minute = await market.intraday(symbol); } catch (e) { minuteError = e.message; }
    return { symbol, ...history, minute, minuteError, analysis: analyze(history.bars, quotes[symbol] || engine.s.marks[symbol]) };
  });
  handler('watch:add', async input => {
    const symbol = symbolOf(input);
    if (engine.s.watchlist.length >= 50) throw Error('自选股最多 50 只');
    const found = await market.quotes([symbol]);
    if (!found[symbol]) throw Error('没有找到该股票的有效行情');
    quotes[symbol] = found[symbol]; transaction(() => { if (!engine.s.watchlist.includes(symbol)) engine.s.watchlist.push(symbol); engine.s.marks[symbol] = found[symbol]; }); publish(); return symbol;
  });
  handler('watch:remove', input => { const symbol = symbolOf(input); transaction(() => { engine.s.watchlist = engine.s.watchlist.filter(s => s !== symbol); }); publish(); });
  handler('trade', async input => {
    const symbol = symbolOf(input.symbol);
    const fresh = await market.quotes([symbol]); Object.assign(quotes, fresh);
    const trade = transaction(() => engine.execute({ ...input, symbol }, fresh[symbol], quotes)); publish(); return trade;
  });
  handler('order', input => { const order = transaction(() => engine.place(input)); publish(); return order; });
  handler('cancel', input => { transaction(() => engine.cancel(input)); publish(); });
  handler('risk', input => { transaction(() => engine.setRisk(input.symbol, input)); publish(); });
  handler('settings', input => { transaction(() => engine.configure(input)); startTimer(); publish(); });
  handler('reset', input => {
    if (input.confirm !== '重置') throw Error('请输入“重置”确认');
    const next = initialState(input.capital); store.backup(engine.s); transaction(() => { engine.s = next; }); publish(); return true;
  });
  handler('backup', async () => {
    const selected = await dialog.showSaveDialog(win, { title: '备份模拟账户', defaultPath: `观澜账户备份-${cnTime().date}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (selected.canceled) return false;
    fs.writeFileSync(selected.filePath, JSON.stringify(engine.s, null, 2), 'utf8'); return true;
  });
  handler('export', async () => {
    const selected = await dialog.showSaveDialog(win, { title: '导出成交记录', defaultPath: `观澜成交记录-${cnTime().date}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (selected.canceled) return false;
    const escape = v => '"' + String(v ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"', '""') + '"';
    const rows = [['北京时间', '代码', '名称', '方向', '股数', '成交价', '成交金额', '佣金', '印花税', '过户费', '已实现盈亏', '成交原因']];
    for (const t of engine.s.trades) { const tm = cnTime(new Date(t.time)); rows.push([tm.date + ' ' + tm.time, t.symbol, t.name, t.side === 'buy' ? '买入' : '卖出', t.quantity, t.price, t.gross / 100, t.fees.commission / 100, t.fees.stampTax / 100, t.fees.transferFee / 100, t.pnl == null ? '' : t.pnl / 100, t.reason]); }
    fs.writeFileSync(selected.filePath, '\uFEFF' + rows.map(r => r.map(escape).join(',')).join('\r\n')); return true;
  });
  handler('folder', () => shell.openPath(app.getPath('userData')));
  win.loadFile(path.join(__dirname, 'ui/index.html'));
  win.webContents.once('did-finish-load', () => { refresh(); startTimer(); });
});
app.on('window-all-closed', () => { clearInterval(timer); app.quit(); });

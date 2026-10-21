'use strict';
// This entry point runs in a separate Node/Electron-as-Node process. Native
// canvas, PDF.js and OCR stay out of the application's event loop and heap.
const { CompanyDocumentParser } = require('./company-document-parser.cjs');
let parser, busy = false, activeId = null;
function send(message) {
  if (!process.connected) return;
  try { process.send(message, error => { if (error) process.exit(1); }); }
  catch { process.exit(1); }
}
function memory() { return process.memoryUsage().rss; }
const heartbeat = setInterval(() => send({ type: 'memory', id: activeId, rss: memory() }), 500);
heartbeat.unref();
process.on('disconnect', () => process.exit(0));
process.on('message', async message => {
  if (message?.type === 'init') {
    try { parser = new CompanyDocumentParser(message.options); send({ type: 'ready', rss: memory() }); }
    catch (error) { send({ type: 'fatal', error: { name: error.name, message: error.message } }); }
    return;
  }
  if (message?.type !== 'parse' || !parser || busy) return;
  busy = true; activeId = message.id;
  send({ type: 'started', id: message.id, rss: memory() });
  try {
    const result = await parser.parse(message.input, { ...message.options,
      onProgress: progress => send({ type: 'progress', id: message.id, progress }),
      onPage: page => send({ type: 'page', id: message.id, ...page }) });
    send({ type: 'result', id: message.id, result, rss: memory() });
  } catch (error) {
    send({ type: 'error', id: message.id, error: { name: error.name, message: error.message, code: error.code,
      timings: error.timings, partialResult: error.partialResult }, rss: memory() });
  } finally { busy = false; activeId = null; }
});

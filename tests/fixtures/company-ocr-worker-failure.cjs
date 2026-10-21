// A real worker thread used only for lifecycle failure tests; no OCR output.
const { parentPort } = require('node:worker_threads');
parentPort.on('message', packet => {
  const response = { workerId: packet.workerId, jobId: packet.jobId, action: packet.action };
  parentPort.postMessage({ ...response, status: 'progress', data: { status: 'failure-fixture-started', progress: 0 } });
  if (packet.payload.mode === 'throw') throw Error('isolated bootstrap failure');
  if (packet.payload.mode === 'exit') process.exit(0);
  if (packet.payload.mode === 'reject') parentPort.postMessage({ ...response, status: 'reject', data: 'isolated language rejection' });
  // mode=hang intentionally leaves the pending initialization unanswered.
});

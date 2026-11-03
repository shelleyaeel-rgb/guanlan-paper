'use strict';

// Universe warm-up and live consumers share transport, but each retains its own
// cancellation and progress subscription. An abandoned job cannot own a later one.
function sharedSourceJob(owner, slot, options = {}, run) {
  const { signal, onProgress = () => {}, force = false } = options;
  const abortError = () => signal?.reason instanceof Error ? signal.reason : Error('已取消证券名单准备');
  if (signal?.aborted) return Promise.reject(abortError());
  let job = owner[slot];
  if (!job || job.controller.signal.aborted) {
    job = { controller: new AbortController(), subscribers: new Set(), progress: null, force };
    owner[slot] = job;
    const finish = (error, value) => {
      if (owner[slot] === job) owner[slot] = null;
      for (const subscriber of [...job.subscribers]) subscriber.finish(error, value);
    };
    Promise.resolve().then(() => {
      job.controller.signal.throwIfAborted();
      return run({ ...options, signal: job.controller.signal, force: job.force, onProgress: progress => {
        job.progress = progress;
        for (const subscriber of [...job.subscribers]) subscriber.progress(progress);
      } });
    }).then(value => finish(null, value), finish);
  }
  return new Promise((resolve, reject) => {
    const subscriber = {
      finish(error, value) {
        if (!job.subscribers.delete(subscriber)) return;
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value);
      },
      progress(value) {
        if (!job.subscribers.has(subscriber)) return;
        try { onProgress({ ...value }); }
        catch (error) { subscriber.finish(error); if (!job.subscribers.size) job.controller.abort(); }
      }
    };
    const cancel = () => { subscriber.finish(abortError()); if (!job.subscribers.size) job.controller.abort(); };
    job.subscribers.add(subscriber); signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel(); else if (job.progress) subscriber.progress(job.progress);
  });
}

module.exports = { sharedSourceJob };

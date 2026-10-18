let worker, mountId;
export async function mountLocalData(files) {
  if (!isSecureContext || !('serviceWorker' in navigator)) throw new Error('Open this website using HTTPS (or localhost for development).');
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw new Error('The website needs Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.');
  await navigator.serviceWorker.register('/local-data-sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Reload the website to activate its local data reader.')), 10000);
    navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  window.__azeroth_coop_error = '';
  worker?.terminate();
  worker = new Worker(new URL('./data-worker.js', import.meta.url), { type: 'module' });
  mountId = crypto.randomUUID();
  const shared = new SharedArrayBuffer(12 + 128 * 1024 * 1024), control = new Int32Array(shared, 0, 3);
  let failed = false;
  window.__azeroth_local_read = (name, head) => {
    if (failed) throw new Error('Local data worker stopped; reselect the Data folder.');
    Atomics.store(control, 0, 0);
    worker.postMessage({ type: 'sync-read', name, head, shared });
    // Window threads cannot Atomics.wait. The upstream synchronous loader blocks here just
    // as it did for XHR; actual disk reads/decompression run on an independent worker.
    const deadline = performance.now() + 10000;
    while (!Atomics.load(control, 0)) {
      if (performance.now() > deadline) {
        failed = true; worker.terminate(); window.__azeroth_coop_error = 'Local data read timed out. Leave and reselect your Data folder.';
        throw new Error(window.__azeroth_coop_error);
      }
    }
    return { status: Atomics.load(control, 1), bytes: new Uint8Array(shared, 12, Atomics.load(control, 2)).slice() };
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Data folder could not be read within 60 seconds.')); }, 60000);
    worker.onerror = () => { clearTimeout(timer); failed = true; window.__azeroth_coop_error = 'Local archive reader stopped. Leave and reselect the Data folder.'; reject(new Error(window.__azeroth_coop_error)); };
    worker.onmessage = ({ data }) => { if (data.type === 'read-error') { window.__azeroth_coop_error = data.error; return; } clearTimeout(timer); data.type === 'mounted' ? resolve({ id: mountId, count: data.count }) : reject(new Error(data.error)); };
    worker.postMessage({ type: 'mount', files: [...files], id: mountId });
  });
}

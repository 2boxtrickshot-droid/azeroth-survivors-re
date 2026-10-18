// FileReaderSync is available in this dedicated worker; nothing is uploaded.
import init, { LocalArchive } from './data-pkg/azeroth_data.js';
import { orderArchives } from './data-order.js';
let archives = [], channel;
const files = new Map(), reader = new FileReaderSync();
globalThis.azerothFileSize = name => files.get(name).size;
globalThis.azerothFileRead = (name, offset, length) => new Uint8Array(reader.readAsArrayBuffer(files.get(name).slice(offset, offset + length)));
function read(name, head = false) {
  for (let i = archives.length - 1; i >= 0; i--) {
    const archive = archives[i];
    if (!archive.contains(name)) continue;
    if (archive.deleted(name)) return { status: 404 };
    return { status: 200, bytes: head ? undefined : archive.read(name) };
  }
  return { status: 404 };
}
onmessage = async ({ data }) => {
  if (data.type === 'sync-read') {
    const control = new Int32Array(data.shared, 0, 3), output = new Uint8Array(data.shared, 12);
    try {
      const result = read(data.name, data.head);
      const bytes = result.bytes || new Uint8Array();
      if (bytes.length > output.length) throw new Error('Asset exceeds synchronous read capacity');
      output.set(bytes); Atomics.store(control, 1, result.status); Atomics.store(control, 2, bytes.length);
    } catch (error) { postMessage({ type: 'read-error', error: `Cannot read ${data.name}: ${String(error.message || error)}` }); Atomics.store(control, 1, 500); Atomics.store(control, 2, 0); }
    Atomics.store(control, 0, 1); return;
  }
  if (data.type !== 'mount') return;
  try {
    await init();
    for (const a of archives) a.free();
    archives = []; files.clear(); channel?.close();
    for (const file of orderArchives(data.files)) { files.set(file.name, file); archives.push(new LocalArchive(file.name)); }
    const probe = read('DBFilesClient\\Map.dbc');
    if (probe.status !== 200 || new TextDecoder().decode(probe.bytes.slice(0, 4)) !== 'WDBC') throw new Error('Map.dbc is missing or invalid. Choose a complete WoW 1.12.1 Data folder.');
    channel = new BroadcastChannel(`azeroth-data-${data.id}`);
    channel.onmessage = ({ data: m }) => {
      if (m.type !== 'read') return;
      try { channel.postMessage({ id: m.id, ...read(m.name, m.head) }); }
      catch (error) { postMessage({ type: 'read-error', error: `Cannot read ${m.name}: ${String(error.message || error)}` }); channel.postMessage({ id: m.id, status: 500, error: String(error.message || error) }); }
    };
    postMessage({ type: 'mounted', count: archives.length });
  } catch (error) { postMessage({ type: 'error', error: String(error.message || error) }); }
};

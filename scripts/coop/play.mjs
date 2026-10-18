// Start each player's original 3D client; only --host also starts the party router.
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), data = args.find(a => a !== '--host');
if (!data) {
  console.error('Usage: node scripts/coop/play.mjs /path/to/WoW/Data [--host]');
  process.exit(1);
}
const suffix = process.platform === 'win32' ? '.exe' : '';
const candidates = [`bin/${process.platform}-${process.arch}/wenilla-host${suffix}`, `target/release/wenilla-host${suffix}`, `target/host/release/wenilla-host${suffix}`];
let binary;
for (const candidate of candidates) {
  try { await access(resolve(root, candidate), constants.X_OK); binary = resolve(root, candidate); break; } catch {}
}
if (!binary) { console.error('Build the local data host first: cargo build --release -p wenilla-host'); process.exit(1); }
try { await access(resolve(root, 'web/dist/wenilla_bg.wasm')); await access(resolve(root, 'web/dist/coop/pkg/azeroth_coop_bg.wasm')); }
catch { console.error('Build the clients first: bash scripts/coop-build.sh && bash scripts/web-build.sh'); process.exit(1); }
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
function run(command, argv) {
  const child = spawn(command, argv, { cwd: root, stdio: 'inherit' }); children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 0); });
  return child;
}
run(binary, ['--bind', '127.0.0.1:8090', '--www', resolve(root, 'web/dist'), '--data', resolve(data)]);
let ready = false;
for (let i = 0; i < 100 && !stopping; i++) {
  try { const r = await fetch('http://127.0.0.1:8090/coop/', { method: 'HEAD' }); if (r.ok) { ready = true; break; } } catch {}
  await new Promise(r => setTimeout(r, 100));
}
if (!ready) { console.error('Local 3D client did not start. Check the data path and whether port 8090 is already in use.'); stop(1); }
else if (!stopping) {
  console.log('3D client: http://127.0.0.1:8090/coop/ — keep this terminal open.');
  if (args.includes('--host')) run(process.execPath, [resolve(root, 'scripts/coop/server.mjs')]);
  else console.log('Open your friend’s guest invite, or paste it into Join party.');
}

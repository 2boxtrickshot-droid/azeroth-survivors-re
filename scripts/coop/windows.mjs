// Packaged Windows entry point. Configuration stays beside the game, never in WoW/Data.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = resolve(root, 'benilla-config/coop.json');
const prompt = createInterface({ input: process.stdin, output: process.stdout });
try {
  let settings = {};
  try { settings = JSON.parse(await readFile(config, 'utf8')); } catch {}
  let data = settings.data;
  if (process.argv.includes('--configure') || typeof data !== 'string') {
    data = (await prompt.question('Path to your WoW 1.12.1 Data folder: ')).trim().replace(/^"(.*)"$/, '$1');
  }
  if (!data || !(await stat(data)).isDirectory()) throw new Error('Choose the Data folder inside your WoW 1.12.1 installation.');
  await mkdir(dirname(config), { recursive: true });
  await writeFile(config, JSON.stringify({ data: resolve(data) }, null, 2));
  prompt.close();
  const host = !process.argv.includes('--join');
  const child = spawn(process.execPath, [resolve(root, 'scripts/coop/play.mjs'), data, ...(host ? ['--host'] : [])], {
    cwd: root, stdio: ['inherit', 'pipe', 'inherit'],
  });
  let pending = '', opened = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    pending += chunk;
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) {
      const link = host ? line.match(/HOST ONLY: (http:\/\/127\.0\.0\.1:8090\/coop\/\S+)/)?.[1]
        : line.startsWith('3D client:') ? 'http://127.0.0.1:8090/coop/' : undefined;
      if (!opened && link) {
        opened = true;
        const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', link], { stdio: 'ignore' });
        browser.on('error', () => console.error('Open the printed link in Chrome or Edge.'));
      }
    }
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  process.on('SIGINT', () => child.kill('SIGINT'));
} catch (error) {
  prompt.close();
  console.error(`Cannot launch: ${error.message}\nRun Configure.cmd to correct the saved data path.`);
  process.exitCode = 1;
}

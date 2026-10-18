// Website operator entry point. Players need only their browser and user-owned Data folder.
import { createPartyServer } from './server.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, readFile, stat, rename, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createBrotliCompress, constants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
for (const file of ['wenilla_bg.wasm', 'coop/pkg/azeroth_coop_bg.wasm', 'coop/data-pkg/azeroth_data_bg.wasm', 'local-data-sw.js']) await access(resolve(root, file));
// The compact deployment archive omits redundant compressed siblings. Generate one
// atomically on first start, so browsers receive the full renderer without a 75 MB transfer.
const wasm = resolve(root, 'wenilla_bg.wasm'), compressed = `${wasm}.br`;
try {
  const fresh = await stat(compressed).then(async s => s.mtimeMs >= (await stat(wasm)).mtimeMs).catch(() => false);
  if (!fresh) {
    const temporary = `${compressed}.${process.pid}.tmp`;
    try {
      await pipeline(createReadStream(wasm), createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }), createWriteStream(temporary));
      await rename(temporary, compressed);
    } finally { await rm(temporary, { force: true }); }
  }
} catch (error) { console.warn(`Serving uncompressed renderer (precompression unavailable): ${error.message}`); }
if (!!process.env.COOP_TLS_CERT !== !!process.env.COOP_TLS_KEY) throw new Error('Set both COOP_TLS_CERT and COOP_TLS_KEY for HTTPS.');
const tls = process.env.COOP_TLS_CERT && process.env.COOP_TLS_KEY ? {
  cert: await readFile(process.env.COOP_TLS_CERT), key: await readFile(process.env.COOP_TLS_KEY),
} : undefined;
const publicOrigin = process.env.COOP_ORIGIN;
if (publicOrigin && (new URL(publicOrigin).origin !== publicOrigin || !['http:', 'https:'].includes(new URL(publicOrigin).protocol))) throw new Error('COOP_ORIGIN must be an exact origin, e.g. https://game.example.com');
const app = await createPartyServer({ root, website: true, tls, publicOrigin, siteKey: process.env.COOP_SITE_KEY || '' });
const port = Number(process.env.PORT || process.env.COOP_PORT || 8080);
app.server.listen(port, process.env.COOP_BIND || '127.0.0.1', () => console.log(`Browser game ready: ${publicOrigin || `${tls ? 'https' : 'http'}://127.0.0.1:${port}`}/coop/ — one private party, no hosted game data.`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(); });

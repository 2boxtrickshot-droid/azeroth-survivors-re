// Direct connections to the host PC. No public signaling, accounts, relay vendor or database.
import http from 'node:http';
import https from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const builds = new Set(['protection', 'fury', 'restoration', 'elemental', 'enhancement', 'frost']);
const token = () => randomBytes(24).toString('base64url');
const equal = (a, b) => typeof a === 'string' && /^[A-Za-z0-9_-]{32}$/.test(a) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const text = (s, max) => typeof s === 'string' ? s.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, max) : '';
export function validCommand(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  const keys = Object.keys(c).sort().join(',');
  if (c.kind === 'move') return keys === 'kind,x,y' && [c.x, c.y].every(v => Number.isFinite(v) && Math.abs(v) <= 1);
  if (c.kind === 'ability') return keys === 'kind';
  if (c.kind === 'upgrade') return keys === 'choice,kind' && Number.isInteger(c.choice) && c.choice >= 0 && c.choice < 6;
  if (c.kind === 'talent') return keys === 'choice,kind,tier' && [0, 1].includes(c.tier) && [1, 2].includes(c.choice);
  return false;
}

export async function createPartyServer({ root = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/coop'), tls, clock = Date.now, website = false, publicOrigin, siteKey = '' } = {}) {
  let hostKey = token(), reservedUntil = 0;
  let invite = token(), host = null, nextId = 1, phase = 'lobby', latest = null, lastState = clock();
  const peers = new Map();
  const history = [];
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const handler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'");
    if (website) { res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); }
    if (website) res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'self'");
    if (website && req.url === '/api/browser-config' && req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ localDataRequired: true, hostCodeRequired: !!siteKey })); return; }
    if (website && req.url === '/api/host' && req.method === 'POST') {
      const expected = publicOrigin || `${tls ? 'https' : 'http'}://${req.headers.host}`;
      if (req.headers.origin !== expected || (siteKey && req.headers['x-party-key'] !== siteKey)) { res.writeHead(403).end('Invalid website access code or origin.'); return; }
      if (host || clock() < reservedUntil) { res.writeHead(409).end('A party is already active or being created. Try again after it ends.'); return; }
      hostKey = token(); reservedUntil = clock() + 15000;
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ key: hostKey })); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://local').pathname); } catch { res.writeHead(400).end(); return; }
    if (website && path === '/') { res.writeHead(302, { Location: '/coop/' }).end(); return; }
    if (website && path.endsWith('/')) path += 'index.html';
    if (path === '/health') { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); return; }
    const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(`${resolve(root)}/`) || !types[extname(file)]) { res.writeHead(404).end(); return; }
    try {
      let selected = file, encoding;
      if (website && /\.(wasm|js)$/.test(file)) {
        for (const [ext, value] of [['br', 'br'], ['gz', 'gzip']]) {
          if (!(req.headers['accept-encoding'] || '').split(',').some(v => v.trim() === value)) continue;
          try { await stat(`${file}.${ext}`); selected = `${file}.${ext}`; encoding = value; break; } catch {}
        }
      }
      const info = await stat(selected);
      res.setHeader('Content-Type', types[extname(file)]);
      res.setHeader('Content-Length', info.size);
      if (encoding) { res.setHeader('Content-Encoding', encoding); res.setHeader('Vary', 'Accept-Encoding'); }
      if (req.method === 'HEAD') res.end();
      else { const stream = createReadStream(selected); stream.on('error', () => res.destroy()); stream.pipe(res); }
    } catch { res.writeHead(404).end('Build the arena first: scripts/coop-build.sh'); }
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 192 * 1024,
    perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true } });
  server.on('upgrade', (req, socket, head) => {
    // Browser sockets must originate at this server or the player's local benilla page.
    let origin;
    try { origin = new URL(req.headers.origin); } catch { socket.destroy(); return; }
    const sameOrigin = publicOrigin ? origin.origin === publicOrigin : origin.host === req.headers.host && origin.protocol === (tls ? 'https:' : 'http:');
    const localView = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && ['http:', 'https:'].includes(origin.protocol);
    if (req.url !== '/party' || (!sameOrigin && !localView) || wss.clients.size >= 12) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  const send = (ws, value, snapshot = false) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.terminate(); return; }
    if (snapshot && ws.bufferedAmount > 256 * 1024) return;
    ws.send(typeof value === 'string' ? value : JSON.stringify(value));
  };
  const broadcast = (value, except, snapshot = false) => {
    for (const ws of peers.keys()) if (ws !== except) send(ws, value, snapshot);
  };
  const roster = () => [...peers.values()].map(({ id, name, build, ready }) => ({ id, name, build, ready }));
  const rosterMessage = () => broadcast({ type: 'roster', players: roster() });
  const chat = (id, name, message) => {
    const line = { type: 'chat', id, name, text: message, time: clock() };
    history.push(line);
    if (history.length > 100) history.shift();
    broadcast(line);
  };
  const closeSession = () => {
    host = null; reservedUntil = 0; latest = null; phase = 'lobby'; invite = token(); history.length = 0;
    for (const ws of peers.keys()) { send(ws, { type: 'ended', reason: 'The host left. This run has ended.' }); ws.close(1000, 'Host left'); }
    peers.clear();
  };
  wss.on('connection', ws => {
    ws.isAlive = true;
    let joined = false, count = 0, windowAt = clock(), chatAt = -Infinity;
    const helloTimer = setTimeout(() => { if (!joined) ws.close(1008, 'Join timeout'); }, 5000);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    ws.on('message', (raw, binary) => {
      if (binary) { ws.close(1008, 'JSON required'); return; }
      const now = clock();
      if (now - windowAt >= 1000) { count = 0; windowAt = now; }
      if (++count > (ws === host ? 100 : 45)) { ws.close(1008, 'Message rate exceeded'); return; }
      if (raw.length > (ws === host ? 192 * 1024 : 2048)) { ws.close(1009, 'Message too large'); return; }
      let m;
      try { m = JSON.parse(raw.toString()); } catch { ws.close(1008, 'Malformed JSON'); return; }
      if (!m || typeof m !== 'object' || Array.isArray(m)) { ws.close(1008, 'Invalid message'); return; }
      if (!joined) {
        if (m.type !== 'hello' || m.version !== 1 || !builds.has(m.build) || !text(m.name, 20)) { ws.close(1008, 'Invalid player or version'); return; }
        const isHost = equal(m.key, hostKey) && (!website || clock() < reservedUntil);
        if ((isHost && host) || (!isHost && (!host || !equal(m.key, invite)))) { ws.close(1008, 'Invalid invite or host unavailable'); return; }
        if (phase !== 'lobby' || peers.size >= 5) { ws.close(1008, phase !== 'lobby' ? 'Run in progress; join in the lobby' : 'Party is full'); return; }
        joined = true;
        clearTimeout(helloTimer);
        const p = { id: nextId++, name: text(m.name, 20), build: m.build, ready: false };
        peers.set(ws, p);
        if (isHost) { host = ws; lastState = now; }
        send(ws, { type: 'welcome', id: p.id, host: isHost, invite: isHost ? invite : undefined, players: roster(), history });
        if (!isHost) send(host, { type: 'join', player: p });
        rosterMessage();
        chat(0, 'Party', `${p.name} joined.`);
        if (latest) send(ws, latest, true);
        return;
      }
      const p = peers.get(ws);
      if (!p) return;
      if (m.type === 'ready' && typeof m.ready === 'boolean') {
        p.ready = m.ready; rosterMessage();
      } else if (m.type === 'input' && validCommand(m.command)) {
        send(host, { type: 'input', id: p.id, command: m.command });
      } else if (m.type === 'chat' && now - chatAt >= 700 && text(m.text, 280)) {
        chatAt = now;
        chat(p.id, p.name, text(m.text, 280));
      } else if (m.type === 'state' && ws === host && m.state?.version === 1
        && Number.isInteger(m.state.tick) && Array.isArray(m.state.players) && m.state.players.length <= 5
        && Array.isArray(m.state.enemies) && m.state.enemies.length <= 223
        && ['lobby', 'playing', 'defeat', 'victory'].includes(m.state.phase)) {
        phase = m.state.phase;
        lastState = now;
        latest = JSON.stringify({ type: 'state', state: m.state });
        broadcast(latest, host, true);
      } else if (m.type === 'phase' && ws === host && ['lobby', 'playing'].includes(m.phase)) {
        // Lock joining before the first simulation snapshot of a run.
        phase = m.phase;
      } else if (m.type !== 'chat') {
        ws.close(1008, 'Invalid or unauthorized message');
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      const p = peers.get(ws);
      if (!p) return;
      peers.delete(ws);
      if (ws === host) { closeSession(); return; }
      if (host) send(host, { type: 'leave', id: p.id });
      rosterMessage();
      chat(0, 'Party', `${p.name} left.`);
    });
  });
  const heartbeat = setInterval(() => {
    if (host && clock() - lastState > 15000) { host.terminate(); return; }
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 5000);
  heartbeat.unref();
  return { server, hostKey, close: async () => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(r => wss.close(r));
    await new Promise(r => server.close(r));
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const tls = process.env.COOP_TLS_CERT && process.env.COOP_TLS_KEY ? {
    cert: await readFile(process.env.COOP_TLS_CERT), key: await readFile(process.env.COOP_TLS_KEY),
  } : undefined;
  const app = await createPartyServer({ root: process.env.COOP_WWW, tls });
  const port = Number(process.env.COOP_PORT || 8787);
  app.server.listen(port, process.env.COOP_BIND || '0.0.0.0', () => {
    const link = new URL(process.env.COOP_CLIENT_URL || 'http://127.0.0.1:8090/coop/');
    link.hash = new URLSearchParams({ host: app.hostKey, server: `${tls ? 'wss' : 'ws'}://localhost:${port}/party` }).toString();
    console.log(`Private party server ready. HOST ONLY: ${link.href}`);
    console.log('Open the host link, then share the guest invite from the lobby. Forward only this TCP port.');
    console.log('HTTP is for a trusted private network. Use TLS for public internet connections; see docs/COOP.md.');
  });
}

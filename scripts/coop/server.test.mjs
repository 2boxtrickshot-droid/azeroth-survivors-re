import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createPartyServer, validCommand } from './server.mjs';

async function fixture(t) {
  const app = await createPartyServer();
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  t.after(() => app.close());
  async function client(key, name = 'Friend', build = 'frost') {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/party`, { origin: `http://127.0.0.1:${port}` });
    const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw)));
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', version: 1, key, name, build }));
    const wait = async type => {
      for (let i = 0; i < 100; i++) {
        const m = messages.find(m => m.type === type); if (m) return m;
        if (ws.readyState === WebSocket.CLOSED) throw new Error(`Closed waiting for ${type}`);
        await new Promise(r => setTimeout(r, 10));
      }
      throw new Error(`Timeout: ${type}`);
    };
    return { ws, messages, wait, send: m => ws.send(JSON.stringify(m)) };
  }
  const host = await client(app.hostKey, 'Tank', 'protection');
  const welcome = await host.wait('welcome');
  return { app, client, host, welcome, port };
}
test('command validation rejects forged state and nonfinite or extra input', () => {
  assert.ok(validCommand({ kind: 'move', x: 1, y: -1 }));
  for (const bad of [null, [], { kind: 'move', x: Infinity, y: 0 }, { kind: 'move', x: 0, y: 0, hp: 1 }, { kind: 'upgrade', choice: 6 }, { kind: 'talent', tier: 2, choice: 1 }, { kind: 'damage', amount: 999 }]) assert.equal(validCommand(bad), false);
});
test('five real sockets share roster, authenticated inputs, chat and world state', async t => {
  const { client, host, welcome } = await fixture(t);
  const guests = [];
  for (let i = 0; i < 4; i++) { const guest = await client(welcome.invite, `Guest${i}`); await guest.wait('welcome'); guests.push(guest); }
  const last = await guests[3].wait('welcome'); assert.equal(last.players.length, 5);
  guests[0].send({ type: 'input', id: welcome.id, command: { kind: 'move', x: 1, y: 0 } });
  const input = await host.wait('input'); assert.notEqual(input.id, welcome.id);
  guests[0].send({ type: 'chat', name: 'Spoofed', text: '<script>test</script>' });
  for (const peer of [host, ...guests]) {
    for (let tries = 0; !peer.messages.some(m => m.type === 'chat' && m.text.includes('<script>')); tries++) {
      assert.ok(tries < 100); await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(peer.messages.find(m => m.type === 'chat' && m.text.includes('<script>')).name, 'Guest0');
  }
  host.send({ type: 'chat', text: 'Host reply' });
  for (const peer of guests) {
    for (let tries = 0; !peer.messages.some(m => m.type === 'chat' && m.text === 'Host reply'); tries++) {
      assert.ok(tries < 100); await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(peer.messages.find(m => m.type === 'chat' && m.text === 'Host reply').id, welcome.id);
  }
  const state = { version: 1, tick: 1, phase: 'playing', players: last.players, enemies: [{ id: 7, hp: 12 }] };
  host.send({ type: 'state', state });
  for (const g of guests) assert.deepEqual((await g.wait('state')).state, state);
});
test('capacity and late joining are rejected; guests cannot forge snapshots', async t => {
  const { client, host, welcome } = await fixture(t);
  for (let i = 0; i < 4; i++) { const g = await client(welcome.invite); await g.wait('welcome'); }
  const extra = await client(welcome.invite); const [code, reason] = await once(extra.ws, 'close');
  assert.equal(code, 1008); assert.match(reason.toString(), /full/);
  host.send({ type: 'phase', phase: 'playing' });
  const late = await client(welcome.invite); const [, why] = await once(late.ws, 'close'); assert.match(why.toString(), /progress/);
});
test('guest disconnect updates the host and host departure ends every peer', async t => {
  const { client, host, welcome } = await fixture(t);
  const a = await client(welcome.invite); const aw = await a.wait('welcome');
  const b = await client(welcome.invite); await b.wait('welcome');
  a.ws.close(); assert.equal((await host.wait('leave')).id, aw.id);
  host.ws.close(); assert.match((await b.wait('ended')).reason, /host left/i);
});
test('malformed JSON, wrong invite, unauthorized state and oversized traffic close cleanly', async t => {
  const { client, welcome } = await fixture(t);
  const bad = await client('invalid'); assert.equal((await once(bad.ws, 'close'))[0], 1008);
  for (const raw of ['{', JSON.stringify({ type: 'state', state: { tick: 1 } }), 'x'.repeat(3000)]) {
    const c = await client(welcome.invite); await c.wait('welcome');
    c.ws.send(raw); const [code] = await once(c.ws, 'close'); assert.ok([1008, 1009].includes(code));
  }
});
test('static host serves arena only, blocks traversal and exposes health', async t => {
  const { port } = await fixture(t);
  const base = `http://127.0.0.1:${port}`;
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/%2e%2e%2f%2e%2e%2fCargo.toml`)).status, 404);
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
});

test('unicode keys and excessive input are rejected without taking down the host', async t => {
  const { client, welcome, host, port } = await fixture(t);
  const wrong = await client('é'.repeat(32)); assert.equal((await once(wrong.ws, 'close'))[0], 1008);
  const flood = await client(welcome.invite); await flood.wait('welcome');
  for (let i = 0; i < 60; i++) flood.send({ type: 'input', command: { kind: 'move', x: 0, y: 0 } });
  assert.equal((await once(flood.ws, 'close'))[0], 1008);
  assert.equal(host.ws.readyState, WebSocket.OPEN);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
});

test('3D readiness belongs to the sending player and is synchronized to the party', async t => {
  const { client, host, welcome } = await fixture(t);
  const guest = await client(welcome.invite, 'Loading');
  const gw = await guest.wait('welcome');
  assert.ok(gw.players.every(p => p.ready === false));
  guest.send({ type: 'ready', ready: true, id: welcome.id });
  for (let i = 0; i < 100; i++) {
    const roster = host.messages.filter(m => m.type === 'roster').at(-1)?.players;
    if (roster?.find(p => p.id === gw.id)?.ready) {
      assert.equal(roster.find(p => p.id === welcome.id).ready, false);
      return;
    }
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail('Guest ready state did not reach the host');
});

test('website creates a reserved host, enforces origin/access code and serves isolation headers', async t => {
  let now = 1000;
  const app = await createPartyServer({ website: true, siteKey: 'private-test', clock: () => now, publicOrigin: 'https://party.example' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const create = (origin = 'https://party.example', key = 'private-test') => fetch(`${base}/api/host`, { method: 'POST', headers: { Origin: origin, 'X-Party-Key': key } });
  assert.equal((await create('https://other.example')).status, 403);
  assert.equal((await create(undefined, 'wrong')).status, 403);
  const first = await create(); assert.equal(first.status, 200);
  const stale = (await first.json()).key;
  assert.equal((await create()).status, 409);
  now += 16000;
  const second = await create(); assert.equal(second.status, 200);
  const key = (await second.json()).key; assert.notEqual(key, stale);
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/party', { origin: 'https://party.example' });
  await once(ws, 'open');
  const welcome = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'hello', version: 1, key, name: 'Browser host', build: 'frost' }));
  assert.equal(JSON.parse((await welcome)[0]).host, true);
  assert.equal((await create()).status, 409);
  const closed = once(ws, 'close'); ws.close(); await closed;
  assert.equal((await create()).status, 200);
  const health = await fetch(`${base}/health`);
  assert.equal(health.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(health.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal((await fetch(`${base}/data/DBFilesClient%5CMap.dbc`)).status, 404);
});

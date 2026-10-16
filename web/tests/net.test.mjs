// net.test.mjs — the parts of `web/net.js` that are pure logic, exercised without a browser.
//
// `RTCPeerConnection` does not exist in node, so the WebRTC half is not tested here (it is
// tested by two tabs and a pasted code). What *is* tested is everything that decides whether a
// session can work at all: the join-code codec, the party rule, and the ICE configuration —
// i.e. the code a player's typo or a wrong-NAT pair would otherwise fail on silently.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODE_VERSION,
  LocalSignal,
  Net,
  ROLES,
  createNet,
  decodeCode,
  encodeCode,
  iceConfig,
  partyProblem,
} from '../net.js';

const SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  'a=group:BUNDLE 0',
  'a=candidate:1467250027 1 udp 2122260223 192.168.0.196 55262 typ host',
  'a=end-of-candidates',
  '',
].join('\r\n');

test('a join code round-trips its kind and session description', () => {
  for (const kind of ['offer', 'answer']) {
    const code = encodeCode(kind, SDP);
    assert.equal(typeof code, 'string');
    assert.ok(!code.includes('\n'), 'a code is one line so it survives a chat message');
    const back = decodeCode(code);
    assert.equal(back.kind, kind);
    assert.equal(back.sdp, SDP, 'the SDP is byte-identical, candidates included');
  }
});

test('a code is single-line base64 of versioned JSON, so a stale code is diagnosable', () => {
  const code = encodeCode('offer', SDP);
  const parsed = JSON.parse(Buffer.from(code, 'base64').toString('utf8'));
  assert.deepEqual(Object.keys(parsed).sort(), ['kind', 'sdp', 'v']);
  assert.equal(parsed.v, CODE_VERSION);

  const stale = Buffer.from(JSON.stringify({ ...parsed, v: CODE_VERSION + 1 })).toString('base64');
  assert.throws(() => decodeCode(stale), /version/);
});

test('a code that is not a code fails with something a player can act on', () => {
  for (const junk of ['', '   ', 'not base64 !!', Buffer.from('hello').toString('base64')]) {
    assert.throws(() => decodeCode(junk), /join code/i);
  }
  const noKind = Buffer.from(JSON.stringify({ v: CODE_VERSION, sdp: SDP })).toString('base64');
  assert.throws(() => decodeCode(noKind), /kind/);
  const noSdp = Buffer.from(JSON.stringify({ v: CODE_VERSION, kind: 'offer' })).toString('base64');
  assert.throws(() => decodeCode(noSdp), /session/);
});

test('the encoder refuses to make a code it could not decode', () => {
  assert.throws(() => encodeCode('sideways', SDP), /kind/);
  assert.throws(() => encodeCode('offer', ''), /empty/);
});

test('the M0 party rule is one tank, one healer, the rest DPS, 2..5 players', () => {
  assert.equal(partyProblem(['Tank', 'Healer']), null);
  assert.equal(partyProblem(['Tank', 'Healer', 'Dps']), null);
  assert.equal(partyProblem(['Tank', 'Healer', 'Dps', 'Dps', 'Dps']), null);

  assert.match(partyProblem(['Tank']), /at least 2/);
  assert.match(partyProblem([]), /at least 2/);
  assert.match(partyProblem(['Tank', 'Healer', 'Dps', 'Dps', 'Dps', 'Dps']), /at most 5/);
  assert.match(partyProblem(['Healer', 'Dps']), /need a tank/);
  assert.match(partyProblem(['Tank', 'Dps']), /need a healer/);
  assert.match(partyProblem(['Tank', 'Tank', 'Healer']), /only one tank/);
  assert.match(partyProblem(['Tank', 'Healer', 'Healer']), /only one healer/);
  assert.match(partyProblem(['Tank', 'Healer', 'Warlord']), /unknown role/);
  assert.match(partyProblem(undefined), /no party/);
  assert.deepEqual(ROLES, ['Tank', 'Healer', 'Dps'], 'the roles match data::Role on the Rust side');
});

test('ICE defaults to STUN and takes a TURN relay when one is given', () => {
  const stunOnly = iceConfig();
  assert.equal(stunOnly.iceServers.length, 1);
  assert.ok(stunOnly.iceServers[0].urls.every((u) => u.startsWith('stun:')));

  const withTurn = iceConfig({ turn: 'turn:relay.example:3478' });
  assert.equal(withTurn.iceServers.length, 2);
  assert.deepEqual(withTurn.iceServers[1], { urls: 'turn:relay.example:3478' });

  const creds = iceConfig({
    turn: [{ urls: 'turns:relay.example:5349', username: 'u', credential: 'p' }],
  });
  assert.equal(creds.iceServers[1].username, 'u');

  // Nothing configured is legal too — a host-only loopback test wants no ICE servers at all.
  assert.deepEqual(iceConfig({ stun: [], turn: [] }), {});
});

test('a code arriving through the signal reaches the session', async () => {
  const signal = new LocalSignal();
  const net = new Net(signal, {});
  assert.equal(net.role, null);
  assert.equal(net.inbox.length, 0);
  assert.equal(net.supported, false, 'node has no RTCPeerConnection, and the layer says so');

  // `deliver` routes through the same seam a relay page would use, and fails loudly rather
  // than silently when the browser cannot do WebRTC.
  signal.deliver(encodeCode('offer', SDP));
  await new Promise((r) => setImmediate(r));
  assert.equal(net.role, 'guest', 'the offer was understood before the WebRTC call');
});

test('the page handle is constructible without a DOM', () => {
  const net = createNet({ ice: { stun: [], turn: [] } });
  assert.ok(net instanceof Net);
  assert.equal(typeof net.send, 'function');
  assert.equal(typeof net.sendFast, 'function');
  // Sending with no peers is a no-op, not a throw: the wasm sends every frame from the start.
  net.send({ t: 'hello', v: 1 });
  net.sendFast({ t: 'snap', tick: 1 });
  net.close();
  assert.equal(net.role, null);
});

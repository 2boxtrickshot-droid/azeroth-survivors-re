// net.js — the co-op connection layer: WebRTC data channels, one per pair, host-authoritative.
//
// Why this is JavaScript and not Rust. The connection is the one thing the client cannot do
// itself: a browser tab cannot listen on a socket, so "one player hosts, the others join" has
// to be a peer-to-peer DataChannel. WebRTC is a page API, and `benilla-app`'s wasm32 `web-sys`
// feature list deliberately stops at `Window`/`Location`/`Storage`/audio, so reaching for
// `RtcPeerConnection` from Rust would mean a new dependency surface (and a wasm-bindgen
// feature-set change) for something the page can do natively. This module owns the transport;
// the wasm owns the game. They meet at `window.__wenilla_net`, the same plain-object,
// once-a-frame lookup `web/bridge.js` uses for `window.__wenilla_bridge` (see
// `crates/benilla-app/src/webbridge/mod.rs`).
//
// Topology (M0 decision): **host-authoritative star.** The host runs the simulation; joiners
// run the renderer and their own input. The host quitting ends the run — no migration.
//
// Connectivity, honestly. Manual-paste join codes remove the need for a *signaling server*,
// but they do not make NAT traversal go away:
//
//   - ICE gathering is **non-trickle** (we wait for `icegatheringstate === 'complete'`), so one
//     code carries the whole offer and each side pastes exactly once. That is the whole reason
//     a single blob is enough.
//   - **STUN** is used by default. It is address discovery, not a game server: it tells a peer
//     what its own public address looks like and holds no state.
//   - **TURN** is a relay and *is* infrastructure. Some pairs (symmetric NAT, strict corporate
//     firewalls) cannot connect without it. `turn:` may be filled in by the player or a future
//     hosting page; with it empty those pairs simply fail, which the UI must say plainly rather
//     than hang on.
//
// A signaling *page* (later, not built): `Signal` below is the seam. `ManualPasteSignal` is
// M0; a `RelaySignal(url)` that POSTs and polls the same opaque blobs is a second
// implementation, not a rewrite. Nothing else in this file knows how a code travels.
//
// Not load-bearing, in the same posture as `platform.js`/`bridge.js`: the page imports this
// dynamically, every entry point feature-detects, and every failure is swallowed. A browser
// with no WebRTC plays single-player exactly as it does today.
//
// Wire messages (plain objects, no serde on either side):
//   client → host  {t:'in',  seq, dir:[x,z], face, jump, mob, pick}
//   host → client  {t:'snap',tick, players:[…], enemies:[…]}      unreliable, last-write-wins
//   host → client  {t:'ev',  kind, …}                             reliable, ordered
//   both ways      {t:'hello', v, name, class, role}
//   host → client  {t:'welcome', seed, map, party:[…], you}       reliable

/** The join-code schema version; bump on an incompatible change. */
export const CODE_VERSION = 1;

/** The party roles, matching `survivors::data::Role` on the Rust side. */
export const ROLES = ['Tank', 'Healer', 'Dps'];

/**
 * The M0 party rule: exactly one tank, exactly one healer, the rest DPS, 3–5 total. Returns a
 * human-readable reason the party is not legal, or null when it is. Kept pure so it is the same
 * answer in the lobby, in the test, and (later) on the host.
 */
export function partyProblem(roles) {
  if (!Array.isArray(roles)) return 'no party';
  if (roles.length < 2) return 'need at least 2 players (1 tank + 1 healer)';
  if (roles.length > 5) return 'at most 5 players';
  const bad = roles.find((r) => !ROLES.includes(r));
  if (bad) return `unknown role ${JSON.stringify(bad)}`;
  const tanks = roles.filter((r) => r === 'Tank').length;
  const healers = roles.filter((r) => r === 'Healer').length;
  if (tanks !== 1) return tanks === 0 ? 'need a tank' : 'only one tank';
  if (healers !== 1) return healers === 0 ? 'need a healer' : 'only one healer';
  return null;
}

/**
 * A join code: `base64(JSON({v, kind, sdp}))`. The SDP already carries every ICE candidate
 * because gathering ran to completion first, so there is nothing else to paste. `kind` is
 * `'offer'` (host) or `'answer'` (joiner) so a code pasted into the wrong box is caught here
 * rather than by WebRTC's less legible complaint.
 */
export function encodeCode(kind, sdp) {
  if (kind !== 'offer' && kind !== 'answer') throw new Error(`bad code kind ${kind}`);
  if (typeof sdp !== 'string' || !sdp) throw new Error('empty session description');
  const json = JSON.stringify({ v: CODE_VERSION, kind, sdp });
  return base64(json);
}

/** The inverse of {@link encodeCode}. Throws with a reason a player can act on. */
export function decodeCode(code) {
  let text;
  try {
    text = unb64(String(code ?? '').trim());
  } catch {
    // `atob` rejects anything that is not base64 with its own `InvalidCharacterError`; a player
    // who pasted half a code needs to hear it from us, not from the browser.
    throw new Error('that does not look like a join code (it is not valid base64)');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('that does not look like a join code (it is not valid base64 JSON)');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('malformed join code');
  if (parsed.v !== CODE_VERSION) {
    throw new Error(`join code version ${parsed.v}, this build speaks ${CODE_VERSION}`);
  }
  if (parsed.kind !== 'offer' && parsed.kind !== 'answer') throw new Error('join code has no kind');
  if (typeof parsed.sdp !== 'string' || !parsed.sdp) throw new Error('join code has no session');
  return { kind: parsed.kind, sdp: parsed.sdp };
}

/** UTF-8 → base64. `btoa` is latin1-only, so the bytes go through `TextEncoder` first. */
function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The inverse of {@link base64}. */
function unb64(code) {
  const bin = atob(code);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------------------------
// ICE

/** Public STUN by default. Address discovery only: no state, no game data, not a game server. */
const DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

/**
 * The `RTCConfiguration` a session uses. `turn` is the relay a symmetric-NAT pair cannot
 * connect without (see the header); it is a settings value this module cannot conjure, and with
 * it empty such a pair simply fails — which the lobby must say plainly instead of hanging.
 * Entries may be `turn:`/`turns:` strings or full `{urls, username, credential}` objects.
 */
export function iceConfig({ stun = DEFAULT_STUN, turn = [] } = {}) {
  const servers = [];
  if (stun?.length) servers.push({ urls: stun });
  for (const t of Array.isArray(turn) ? turn : turn ? [turn] : []) {
    servers.push(typeof t === 'string' ? { urls: t } : t);
  }
  return servers.length ? { iceServers: servers } : {};
}

/** How long to wait for ICE before sending a code with whatever was gathered. */
const ICE_TIMEOUT_MS = 5000;

/** Resolve once ICE gathering has finished, or after {@link ICE_TIMEOUT_MS}. */
function iceComplete(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, ICE_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

// ---------------------------------------------------------------------------------------------
// The signaling seam

/**
 * Where a join code goes and comes from. M0's only implementation is the page's own clipboard
 * or textarea; a relay page is a second implementation of the same three methods, and nothing
 * else in this file needs to change for it.
 *
 *   `publish(kind, code)`  this side produced a code — the page shows/copies it
 *   `onCode(cb)`           the page calls `deliver(code)` when the other side's code arrives
 */
export class LocalSignal {
  constructor() {
    /** Set by the page: `(kind, code) => void`. */
    this.onPublish = null;
    this._onCode = null;
  }
  publish(kind, code) {
    this.onPublish?.(kind, code);
  }
  onCode(cb) {
    this._onCode = cb;
  }
  /** Hand a code in from outside — a paste, a relay poll, a test. */
  deliver(code) {
    this._onCode?.(code);
  }
}

// ---------------------------------------------------------------------------------------------
// The session

/**
 * One host or one guest, plus its connections. The wasm side touches exactly three things:
 * `inbox` (drain it once a frame), `send`/`sendFast` (push a message), and `supported`. The
 * page's lobby UI touches `host()`, `join()` and `deliver()`.
 */
export class Net {
  constructor(signal = new LocalSignal(), ice = iceConfig()) {
    this.signal = signal;
    this.ice = ice;
    /** `'host' | 'guest' | null` once a session starts. */
    this.role = null;
    /** Received messages, drained by the wasm each frame (the bridge's `queue`, reversed). */
    this.inbox = [];
    /** One entry per connection; the host has one per joiner. */
    this.peers = [];
    /** `(state) => void` — 'gathering' | 'waiting' | 'connected' | 'failed' | 'closed'. */
    this.onState = null;
    /** `(error) => void`. */
    this.onError = null;
    this._nextPeer = 1;
    this.signal.onCode((code) => {
      this.deliver(code).catch((e) => this._fail(e));
    });
  }

  /** Whether this browser can do peer-to-peer at all. */
  get supported() {
    return typeof RTCPeerConnection === 'function';
  }

  _state(state) {
    this.onState?.(state);
  }

  _fail(error) {
    this.onError?.(error);
    this._state('failed');
  }

  /** The host: open a connection, make the offer code, wait for the joiner's answer code. */
  async host() {
    if (!this.supported) throw new Error('this browser has no WebRTC');
    this.role = 'host';
    const peer = this._newPeer();
    this._state('gathering');
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    await iceComplete(peer.pc);
    this.signal.publish('offer', encodeCode('offer', peer.pc.localDescription.sdp));
    this._state('waiting');
    return peer;
  }

  /** A joiner: hand in the host's offer code; the answer code comes back through the signal. */
  async join(offerCode) {
    if (!this.supported) throw new Error('this browser has no WebRTC');
    this.role = 'guest';
    return this.deliver(offerCode);
  }

  /** A code arrived: the host's offer (guest side) or the answer (host side). */
  async deliver(code) {
    const { kind, sdp } = decodeCode(code);
    if (kind === 'offer') {
      if (this.role === 'host') throw new Error('that is an offer; this side is the host');
      this.role = 'guest';
      const peer = this._newPeer();
      await peer.pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this._state('gathering');
      await iceComplete(peer.pc);
      this.signal.publish('answer', encodeCode('answer', peer.pc.localDescription.sdp));
      this._state('waiting');
      return peer;
    }
    if (this.role !== 'host') throw new Error('that is an answer; this side is the joiner');
    const waiting = this.peers.find((p) => !p.pc.remoteDescription);
    if (!waiting) throw new Error('no connection is waiting for an answer');
    await waiting.pc.setRemoteDescription({ type: 'answer', sdp });
    return waiting;
  }

  _newPeer() {
    const pc = new RTCPeerConnection(this.ice);
    const peer = { id: this._nextPeer++, pc, channels: {}, state: 'new' };
    // The joiner receives whatever the host created; the host creates the pair up front.
    pc.ondatachannel = (e) => this._adopt(peer, e.channel);
    if (this.role === 'host') {
      this._adopt(peer, pc.createDataChannel('ev', { ordered: true }));
      this._adopt(peer, pc.createDataChannel('snap', { ordered: false, maxRetransmits: 0 }));
    }
    pc.onconnectionstatechange = () => {
      peer.state = pc.connectionState;
      if (pc.connectionState === 'connected') this._state('connected');
      else if (pc.connectionState === 'failed') this._fail(new Error('peer connection failed'));
      else if (pc.connectionState === 'closed') this._state('closed');
    };
    this.peers.push(peer);
    return peer;
  }

  _adopt(peer, channel) {
    peer.channels[channel.label] = channel;
    channel.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return; // a malformed frame is dropped, never a crash
      }
      if (msg && typeof msg === 'object') this.inbox.push(msg);
    };
    // A channel opening is proof of a live path, which beats trusting `connectionState` alone
    // (it lags the first usable frame).
    channel.onopen = () => this._state('connected');
  }

  /** Reliable, ordered: discrete events (spawn, death, level-up, boss, party changes). */
  send(msg) {
    this._broadcast('ev', msg);
  }

  /** Unreliable, unordered: state that is overwritten anyway (positions, health). */
  sendFast(msg) {
    this._broadcast('snap', msg);
  }

  _broadcast(label, msg) {
    const data = JSON.stringify(msg);
    for (const peer of this.peers) {
      const channel = peer.channels[label];
      if (channel && channel.readyState === 'open') {
        try {
          channel.send(data);
        } catch {
          // A full or closing buffer is not worth a frame; the next tick re-sends.
        }
      }
    }
  }

  /** Tear the session down (the host quitting ends the run — no migration, M0 decision). */
  close() {
    for (const peer of this.peers) {
      try {
        peer.pc.close();
      } catch {
        // already gone
      }
    }
    this.peers = [];
    this.inbox = [];
    this.role = null;
    this._state('closed');
  }
}

// ---------------------------------------------------------------------------------------------
// The page's handle

/**
 * Build a session with the page's choices. `options.ice` is `{stun, turn}`; `options.signal`
 * defaults to the paste-a-code one. Separate from the class so a test (or a future lobby) can
 * supply its own signal without touching WebRTC.
 */
export function createNet(options = {}) {
  return new Net(options.signal ?? new LocalSignal(), iceConfig(options.ice));
}

// The page's global, in the same shape `bridge.js` leaves `window.__wenilla_bridge` in: the wasm
// looks it up once a frame and finds it, or finds nothing and stays single-player. Guarded so
// this module is importable in plain node (the tests) and in any context with no DOM.
if (typeof window !== 'undefined') {
  window.__wenilla_net = createNet();
  console.log('wenilla: co-op net layer ready — window.__wenilla_net');
}

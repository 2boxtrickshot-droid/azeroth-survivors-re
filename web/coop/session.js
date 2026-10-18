// The host's socket and simulation run together off the UI thread. Rendering, chat focus and
// background-tab animation throttling cannot pause combat or delay handling a friend's input.
import init, { Engine } from './pkg/azeroth_coop.js';
let socket, engine, id, closed = false, lastState = performance.now(), lastTime = performance.now(), accumulator = 0, lastSend = 0;
const ready = init();
const emit = message => postMessage(message);
const send = message => { if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 256 * 1024) socket.send(JSON.stringify(message)); };
function publish() {
  const state = JSON.parse(engine.snapshot());
  emit({ type: 'state', state }); send({ type: 'state', state });
}
onmessage = async ({ data: m }) => {
  await ready;
  if (m.type === 'connect') {
    socket = new WebSocket(m.endpoint);
    socket.onopen = () => send(m.hello);
    socket.onerror = () => emit({ type: 'error', message: 'Connection failed. Check the invite, firewall, TLS certificate and forwarded port.' });
    socket.onclose = e => { if (!closed) emit({ type: 'ended', reason: e.reason || 'Connection lost. Rejoin when the host returns to the lobby.' }); engine?.free(); engine = null; closed = true; };
    socket.onmessage = ({ data }) => {
      let event;
      try { event = JSON.parse(data); } catch { socket.close(); return; }
      if (event.type === 'welcome') {
        id = event.id;
        lastState = performance.now();
        if (event.host) { engine = new Engine(crypto.getRandomValues(new Uint32Array(1))[0]); for (const p of event.players) engine.join(p.id, p.name, p.build); }
        emit(event);
      } else if (event.type === 'join' && engine) {
        const p = event.player; engine.join(p.id, p.name, p.build);
      } else if (event.type === 'leave' && engine) engine.leave(event.id);
      else if (event.type === 'input' && engine) engine.command(event.id, JSON.stringify(event.command));
      else { if (event.type === 'state') lastState = performance.now(); emit(event); }
    };
  } else if (m.type === 'input') {
    if (engine) engine.command(id, JSON.stringify(m.command)); else send(m);
  } else if (m.type === 'start' && engine?.start()) { send({ type: 'phase', phase: 'playing' }); publish(); }
  else if (m.type === 'lobby' && engine) { engine.lobby(); send({ type: 'phase', phase: 'lobby' }); publish(); }
  else if (m.type === 'chat' || m.type === 'ready') send(m);
  else if (m.type === 'close') { closed = true; socket?.close(1000, 'Left party'); }
};
setInterval(() => {
  const now = performance.now(), dt = Math.min((now - lastTime) / 1000, 1); lastTime = now;
  if (engine && !closed) {
    accumulator += dt;
    while (accumulator >= 1 / 30) { engine.step(); accumulator -= 1 / 30; }
    if (now - lastSend >= 100) { lastSend = now; publish(); }
  } else if (id && !closed && now - lastState > 10000) {
    closed = true; socket?.close(); emit({ type: 'ended', reason: 'The host stopped responding. The run has ended.' });
  }
}, 1000 / 30);

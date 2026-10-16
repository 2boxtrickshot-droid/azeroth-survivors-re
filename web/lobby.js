// lobby.js — the co-op lobby: two buttons, two boxes, one status line.
//
// The page owns the lobby because the lobby is DOM work. A join code is a few kilobytes of text a
// player has to copy and paste, which means a textarea and the clipboard — and the wasm should not
// grow a text-input widget for it. The wasm owns the game and reads `window.__wenilla_net` (see
// `crates/benilla-app/src/survivors/coop.rs`); it never learns how a code travelled, which is what
// keeps a real invite page a drop-in replacement for this file rather than a change to the game.
//
// Posture, same as `platform.js` and `bridge.js`: imported dynamically, off the boot path, every
// failure swallowed. A page that never imports this plays exactly as it does today.

// Imported for its side effect: `net.js` installs `window.__wenilla_net` on load.
import './net.js';

/** What the status line says for a session state. Pure, so the test and the page agree. */
export function statusText(state, peers = 0) {
  switch (state) {
    case 'gathering':
      return 'preparing a join code…';
    case 'waiting':
      return peers > 0 ? `connected — ${peers} peer(s)` : 'waiting for the other player…';
    case 'connected':
      return `connected — ${peers > 0 ? peers : 1} peer(s)`;
    case 'failed':
      return 'could not connect — behind a strict router this needs a relay (turn:)';
    case 'closed':
      return 'session closed';
    default:
      return 'not in a session';
  }
}

/** The instruction that goes with a published code, per side. Pure. */
export function publishHint(kind) {
  return kind === 'offer'
    ? 'Send this code to the other player, then paste their reply below and press Join.'
    : 'Send this reply back to the host.';
}

const CSS = {
  panel: 'position:fixed;top:10px;left:10px;z-index:9;width:300px;padding:10px;'
    + 'background:rgba(12,6,4,.92);border:1px solid #8c733f;border-radius:4px;'
    + 'font:12px/1.45 system-ui,sans-serif;color:#e8dfc8',
  row: 'display:flex;gap:6px;margin-top:6px',
  button: 'flex:1;padding:5px 8px;background:#2e0f0a;color:#ffd100;'
    + 'border:1px solid #8c733f;border-radius:3px;cursor:pointer;font:inherit',
  box: 'width:100%;height:74px;margin-top:6px;resize:vertical;box-sizing:border-box;'
    + 'background:#000;color:#cfe8cf;border:1px solid #8c733f;border-radius:3px;'
    + 'font:11px/1.3 ui-monospace,monospace',
  status: 'margin-top:6px;color:#c9bda0',
  hint: 'margin-top:6px;color:#9c8f74',
};

/**
 * Build the panel and wire it to a session. `net` defaults to the handle `net.js` installed.
 * Returns the panel element, or null when there is no DOM or no session to drive.
 */
export function mount(net = globalThis.window?.__wenilla_net) {
  if (typeof document === 'undefined' || !net) return null;

  const panel = document.createElement('div');
  panel.id = 'wenilla-lobby';
  panel.style.cssText = CSS.panel;

  const title = document.createElement('b');
  title.textContent = 'Co-op';
  panel.append(title);

  const hostBtn = document.createElement('button');
  hostBtn.style.cssText = CSS.button;
  hostBtn.textContent = 'Host';
  const joinBtn = document.createElement('button');
  joinBtn.style.cssText = CSS.button;
  joinBtn.textContent = 'Join';

  const buttons = document.createElement('div');
  buttons.style.cssText = CSS.row;
  buttons.append(hostBtn, joinBtn);
  panel.append(buttons);

  const code = document.createElement('textarea');
  code.style.cssText = CSS.box;
  code.readOnly = true;
  code.placeholder = 'your join code appears here';
  panel.append(code);

  const copyBtn = document.createElement('button');
  copyBtn.style.cssText = CSS.button;
  copyBtn.textContent = 'Copy code';
  const copyRow = document.createElement('div');
  copyRow.style.cssText = CSS.row;
  copyRow.append(copyBtn);
  panel.append(copyRow);

  const paste = document.createElement('textarea');
  paste.style.cssText = CSS.box;
  paste.placeholder = 'paste the other player’s code here';
  panel.append(paste);

  const hint = document.createElement('div');
  hint.style.cssText = CSS.hint;
  panel.append(hint);

  const status = document.createElement('div');
  status.style.cssText = CSS.status;
  panel.append(status);

  document.body.append(panel);

  const say = (state) => {
    status.textContent = statusText(state, net.peers.length);
  };
  say(null);

  if (!net.supported) {
    hostBtn.disabled = joinBtn.disabled = true;
    status.textContent = 'this browser has no WebRTC — co-op is unavailable';
    return panel;
  }

  net.onState = say;
  net.onError = (e) => {
    status.textContent = `${statusText('failed')} (${e?.message ?? e})`;
  };
  net.signal.onPublish = (kind, text) => {
    code.value = text;
    hint.textContent = publishHint(kind);
    say('waiting');
  };

  hostBtn.onclick = async () => {
    code.value = '';
    hint.textContent = '';
    say('gathering');
    try {
      await net.host();
    } catch (e) {
      net.onError(e);
    }
  };
  joinBtn.onclick = async () => {
    try {
      await net.join(paste.value);
    } catch (e) {
      net.onError(e);
    }
  };
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(code.value);
      copyBtn.textContent = 'Copied';
      setTimeout(() => {
        copyBtn.textContent = 'Copy code';
      }, 1200);
    } catch {
      // Clipboard permission is a browser decision; the textarea is already selectable.
      code.select();
    }
  };

  return panel;
}

// Off the boot path: a page that never gets here loses only the panel.
try {
  mount();
} catch (e) {
  console.warn('lobby.js:', e);
}

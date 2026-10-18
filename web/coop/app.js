import { mountLocalData } from './local-data.js';
import init, { catalog } from './pkg/azeroth_coop.js';
import { Arena, BUILDS, UPGRADES, bar, label } from './presentation.js';
const $ = id => document.getElementById(id);
const connection = text => { $('connection').textContent = text; };
let classes, arena;
try {
  await init(); classes = JSON.parse(catalog()); arena = new Arena($('arena'), $('plates'), classes);
  $('host').disabled = false; $('join').disabled = false; connection('Ready · private connections only');
} catch (e) { connection('Arena failed to load. Build with scripts/coop-build.sh.'); throw e; }
let selected = 'protection', socket = null, myId = 0, isHost = false, state = null, roster = [];
let inviteKey = '', worldLoaded = false, ended = false, pendingConnection = false, rendererReady = false;
const keys = new Set();
const params = new URLSearchParams(location.hash.slice(1));
// Invite keys stay in the fragment, out of HTTP logs and Referer headers.
const hostKey = () => new URLSearchParams(location.hash.slice(1)).get('host');
if (params.has('join')) $('invite').value = location.href;
let website = false;
try { const r = await fetch('/api/browser-config'); website = r.ok && (await r.json()).localDataRequired === true; } catch {}
$('data-picker').closest('label').hidden = !website;
$('data-status').hidden = !website;
const defaultEndpoint = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/party`;
let localDataId = '';
$('data-picker').onchange = async () => {
  $('host').disabled = true; $('join').disabled = true; $('data-picker').disabled = true;
  $('data-status').textContent = 'Opening your local archives…';
  try { const mounted = await mountLocalData($('data-picker').files); localDataId = mounted.id; $('data-status').textContent = `${mounted.count} local archives ready. Files stay on your computer.`; }
  catch (e) { localDataId = ''; error(e.message); $('data-status').textContent = e.message; }
  $('host').disabled = false; $('join').disabled = false; $('data-picker').disabled = false;
};
const wow = new URLSearchParams(location.search).get('view') !== 'debug2d';
$('arena').hidden = wow;
const color = build => classes.find(c => c.id === BUILDS[build].class).color;
const className = build => classes.find(c => c.id === BUILDS[build].class).name;
for (const [key, b] of Object.entries(BUILDS)) {
  const button = document.createElement('button'); button.dataset.build = key;
  const title = label('b', `${b.icon} ${className(key)}`); title.style.color = color(key);
  button.append(title, label('span', b.name), label('small', b.role));
  button.onclick = () => select(key); $('builds').append(button);
}
function select(key) {
  selected = key; for (const b of $('builds').children) b.classList.toggle('selected', b.dataset.build === key);
  $('build-info').textContent = BUILDS[key].description;
}
select(selected);
function send(message) { socket?.postMessage(message); }
function command(cmd) { send({ type: 'input', command: cmd }); }
function stopKeys() { keys.clear(); if (myId) command({ kind: 'move', x: 0, y: 0 }); }
function error(message) { $('menu-error').textContent = message; connection(message); }
function parseInvite(value) {
  const url = new URL(value);
  const hash = new URLSearchParams(url.hash.slice(1));
  const key = hash.get('join');
  const endpoint = hash.get('server') || `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/party`;
  const ws = new URL(endpoint);
  if (!['ws:', 'wss:'].includes(ws.protocol) || !key || key.length !== 32) throw new Error('Paste the full guest invite from your host.');
  if (location.protocol === 'https:' && ws.protocol !== 'wss:') throw new Error('An HTTPS page requires a secure wss:// host connection.');
  return { key, endpoint };
}
function connect(key, endpoint) {
  if (pendingConnection || myId) return;
  if (website && !localDataId) { error('Select your WoW 1.12.1 Data folder first.'); return; }
  const name = $('name').value.trim(); if (!name) { error('Choose a player name.'); return; }
  ended = false; pendingConnection = true; $('menu-error').textContent = ''; connection('Connecting to the host…');
  let ws;
  try { ws = new Worker(new URL('./session.js', import.meta.url), { type: 'module' }); } catch (e) { pendingConnection = false; error(e.message); return; }
  socket = ws;
  const timeout = setTimeout(() => { if (!myId) { disconnect('Connection timed out. Check the address, firewall and forwarded port.'); } }, 10000);
  ws.postMessage({ type: 'connect', endpoint, hello: { type: 'hello', version: 1, key, name, build: selected } });
  ws.onmessage = event => {
    const m = event.data;
    if (m.type === 'welcome') {
      clearTimeout(timeout); pendingConnection = false;
      myId = m.id; isHost = m.host; roster = m.players; inviteKey = m.invite || '';
      $('menu').hidden = true; $('lobby').hidden = false; $('chat').hidden = false; $('party').hidden = false;
      $('messages').replaceChildren(); for (const line of m.history) addChat(line);
      const address = new URL(endpoint); address.protocol = address.protocol === 'wss:' ? 'https:' : 'http:'; address.pathname = '/';
      $('public-address').value = address.origin;
      $('public-address').closest('label').hidden = !!localDataId;
      $('host-invite').querySelector('.hint').hidden = !!localDataId;
      if (wow) loadWorld(); else { rendererReady = true; send({ type: 'ready', ready: true }); }
      $('host-invite').hidden = !isHost; $('start').hidden = !isHost; $('waiting').hidden = isHost;
      $('again').hidden = !isHost; $('result-wait').hidden = isHost;
      if (isHost) updateInvite();
      renderRoster(); connection(isHost ? 'Hosting · keep this browser open' : 'Connected to your host');
    } else if (m.type === 'roster') {
      roster = m.players; renderRoster();
    } else if (m.type === 'state') {
      if (!validState(m.state)) { disconnect('Invalid host snapshot.'); return; }
      applyState(m.state);
    } else if (m.type === 'chat') addChat(m);
    else if (m.type === 'ended') { clearTimeout(timeout); disconnect(m.reason); }
    else if (m.type === 'error') error(m.message);
  };
  ws.onerror = () => { clearTimeout(timeout); disconnect('The session worker failed. Reload and try again.'); };
}
// Bound both memory and renderer inputs, even if a host runs a modified client.
function validState(s) {
  const finite = (v, max = 1e9) => Number.isFinite(v) && Math.abs(v) <= max;
  const radius = v => finite(v, 100) && v >= 0;
  const point = p => p && finite(p.x, 1000) && finite(p.y, 1000);
  return s?.version === 1 && Number.isInteger(s.tick) && finite(s.elapsed)
    && ['lobby', 'playing', 'defeat', 'victory'].includes(s.phase)
    && Array.isArray(s.players) && s.players.length <= 5 && s.players.every(p => BUILDS[p.build] && typeof p.name === 'string' && p.name.length <= 40 && point(p.pos) && finite(p.hp) && finite(p.max_hp) && Array.isArray(p.upgrades) && p.upgrades.length === 6 && Array.isArray(p.talents) && p.talents.length === 2)
    && Array.isArray(s.enemies) && s.enemies.length <= 223 && s.enemies.every(e => point(e.pos) && finite(e.hp) && finite(e.max_hp))
    && Array.isArray(s.gems) && s.gems.length <= 180 && s.gems.every(g => point(g.pos))
    && Array.isArray(s.effects) && s.effects.length <= 80 && s.effects.every(e => point(e.from) && point(e.to) && radius(e.radius))
    && Array.isArray(s.hazards) && s.hazards.length <= 500 && s.hazards.every(h => point(h.pos) && radius(h.radius));
}
function disconnect(reason) {
  ended = true; stopKeys(); const leaving = socket; leaving?.postMessage({ type: 'close' }); setTimeout(() => leaving?.terminate(), 100); socket = null;
  myId = 0; state = null; isHost = false; roster = []; pendingConnection = false;
  window.__azeroth_coop = null;
  for (const id of ['lobby', 'chat', 'party', 'hud', 'choices', 'results']) $(id).hidden = true;
  $('menu').hidden = false; $('world').hidden = true; $('arena').hidden = wow;
  rendererReady = false; worldLoaded = false; $('world').src = 'about:blank';
  window.__azeroth_coop_ready = false; window.__azeroth_coop_error = ''; window.__azeroth_coop_plates = {}; choicesKey = ''; talentsKey = '';
  $('plates').replaceChildren(); $('world-status').textContent = '';
  error(reason); $('messages').replaceChildren();
}
$('host').onclick = async () => {
  if (pendingConnection || myId) return;
  if (hostKey()) { connect(hostKey(), params.get('server') || defaultEndpoint); return; }
  if (!website) { error('Open the HOST ONLY link printed by your local party server.'); return; }
  if (!localDataId) { error('Select your WoW 1.12.1 Data folder first.'); return; }
  $('host').disabled = true;
  try {
    const response = await fetch('/api/host', { method: 'POST', headers: { 'X-Party-Key': $('site-key').value } });
    if (!response.ok) throw new Error(await response.text());
    connect((await response.json()).key, defaultEndpoint);
  } catch (e) { error(e.message); }
  finally { $('host').disabled = false; }
};
$('join').onclick = () => { try { const { key, endpoint } = parseInvite($('invite').value.trim()); connect(key, endpoint); } catch (e) { error(e.message); } };
function updateInvite() {
  try {
    const address = new URL($('public-address').value);
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw new Error();
    const server = new URL('/party', address); server.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
    const invite = new URL(localDataId ? '/coop/' : 'http://127.0.0.1:8090/coop/', location.href);
    invite.hash = new URLSearchParams(localDataId ? { join: inviteKey } : { join: inviteKey, server: server.href }).toString();
    $('share').value = invite.href;
  } catch { $('share').value = 'Enter a valid http:// or https:// address for your host.'; }
}
$('public-address').oninput = updateInvite;
$('copy-invite').onclick = async () => {
  updateInvite();
  try { await navigator.clipboard.writeText($('share').value); connection('Guest invite copied'); }
  catch { $('share').focus(); $('share').select(); connection('Select and copy the guest invite below.'); }
};
for (const button of document.querySelectorAll('.leave')) button.onclick = () => disconnect('You left the party.');
$('start').onclick = () => { if (isHost && roster.length && roster.every(p => p.ready)) send({ type: 'start' }); };
$('again').onclick = () => { if (isHost) send({ type: 'lobby' }); };
function renderRoster() {
  $('start').disabled = !roster.length || !roster.every(p => p.ready);
  $('lobby-members').replaceChildren(); $('roster').replaceChildren();
  for (const member of roster) {
    const p = state?.players.find(p => p.id === member.id) || member;
    const row = label('div', '', 'member'); const title = label('b', `${member.name}${member.id === myId ? ' (you)' : ''}`); title.style.color = color(member.build);
    row.append(title, label('small', `${className(member.build)} · ${BUILDS[member.build].name} · ${member.ready ? 'Ready' : 'Loading 3D world…'}`)); $('lobby-members').append(row);
    const partyRow = label('div', '', `party-row ${p.hp === 0 ? 'dead' : ''}`);
    const line = label('div', '', 'title'); const name = label('span', member.name); name.style.color = color(member.build);
    line.append(name, label('span', p.hp === 0 ? 'DOWN' : p.hp !== undefined ? `${Math.ceil(p.hp)}/${Math.ceil(p.max_hp)}` : 'Ready'));
    partyRow.append(line, bar(p.hp ?? 1, p.max_hp ?? 1), label('small', `${BUILDS[member.build].name} ${p.level ? `· Lv ${p.level}` : ''}`)); $('roster').append(partyRow);
  }
}
let choicesKey = '', talentsKey = '';
function talents(container, p) {
  container.replaceChildren();
  const healer = p.build === 'restoration';
  const options = [
    [[healer ? 'Tidal focus' : 'Battle focus', '+20% damage or healing'], ['Warding spirit', '10% damage reduction']],
    [['Overwhelming force', '+25% attack damage'], ['Swift response', 'F cooldown: 12 → 8 seconds']],
  ];
  for (let tier = 0; tier < 2; tier++) {
    const section = label('div', '', 'talents'); section.append(label('strong', `Talent tier ${tier + 1}`));
    section.append(label('p', tier === 0 ? 'Choose one direction for this run.' : 'Requires level 5 and a tier 1 talent.'));
    options[tier].forEach(([name, description], index) => {
      const button = label('button', `${p.talents[tier] === index + 1 ? '✓ ' : ''}${name} · ${description}`);
      button.disabled = p.talents[tier] !== 0 || (tier === 1 && (p.level < 5 || !p.talents[0]));
      button.onclick = () => command({ kind: 'talent', tier, choice: index + 1 }); section.append(button);
    }); container.append(section);
  }
}
function applyState(next) {
  state = next;
  window.__azeroth_coop = { state, id: myId };
  const playing = state.phase === 'playing', lobby = state.phase === 'lobby';
  $('lobby').hidden = !lobby; $('hud').hidden = !playing; $('results').hidden = playing || lobby;
  $('world').hidden = !wow;
  $('arena').hidden = wow;
  renderRoster();
  const p = state.players.find(p => p.id === myId); if (!p) return;
  const minutes = Math.floor(state.elapsed / 60), seconds = Math.floor(state.elapsed % 60).toString().padStart(2, '0');
  $('run-clock').replaceChildren(label('span', `${minutes}:${seconds} / 6:00`), label('small', `${state.kills} defeated · ${state.bosses_killed}/3 commanders`));
  $('bosses').replaceChildren();
  for (const b of state.enemies.filter(e => e.boss)) { const row = label('div', `${b.name} · ${Math.ceil(b.hp)}`); row.append(bar(b.hp, b.max_hp)); $('bosses').append(row); }
  $('vitals').replaceChildren(label('strong', `${p.name} · ${Math.ceil(p.hp)} / ${p.max_hp} HP`), bar(p.hp, p.max_hp), bar(p.resource, 100, 'mana'));
  if (p.hp === 0) $('vitals').append(label('small', 'Downed — an ally can revive you nearby.'));
  $('progress').replaceChildren(label('span', `Level ${p.level} · ${Math.floor(p.xp)} / ${p.next_xp} XP`), bar(p.xp, p.next_xp, 'xp'));
  $('ability').replaceChildren(label('strong', `F · ${BUILDS[p.build].ability}`), label('div', p.cooldown > 0 ? `Ready in ${p.cooldown.toFixed(1)}s` : 'Ready · 30 resource'), label('small', 'WASD move · Enter chat · Auto attacks'));
  const talentAvailable = !p.talents[0] || (p.level >= 5 && !p.talents[1]);
  $('choices').hidden = !playing || !(p.pending > 0 || talentAvailable);
  const nextChoicesKey = `${p.id}/${p.pending}/${p.upgrades}`;
  if (nextChoicesKey !== choicesKey) {
    choicesKey = nextChoicesKey; $('upgrade-list').replaceChildren();
    if (p.pending > 0) UPGRADES.forEach(([title, detail], choice) => {
      const button = label('button', `${title} · ${p.upgrades[choice]}/8`); button.append(label('small', detail));
      button.disabled = p.upgrades[choice] >= 8; button.onclick = () => command({ kind: 'upgrade', choice }); $('upgrade-list').append(button);
    });
  }
  const nextTalentsKey = `${p.id}/${p.build}/${p.talents}/${p.level >= 5}`;
  if (nextTalentsKey !== talentsKey) { talentsKey = nextTalentsKey; talents($('talents-lobby'), p); talents($('talents-run'), p); }
  if (!playing && !lobby) {
    $('result-title').textContent = state.phase === 'victory' ? 'Elwynn stands.' : 'The watch has fallen.';
    $('result-body').replaceChildren(label('p', `${minutes}:${seconds} survived · ${state.kills} foes defeated · ${state.bosses_killed} commanders`));
    for (const member of state.players) { const row = label('div', '', 'result-row'); row.append(label('b', member.name), label('span', `${Math.round(member.damage)} damage · ${Math.round(member.healing)} healing`)); $('result-body').append(row); }
  }
}

function addChat(m) {
  const log = $('messages'), nearBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  const line = document.createElement('div'); line.append(label('b', `${String(m.name).slice(0, 20)}: `), document.createTextNode(String(m.text).slice(0, 280)));
  log.append(line); while (log.children.length > 100) log.firstChild.remove();
  if (nearBottom) log.scrollTop = log.scrollHeight;
}
$('chat-form').onsubmit = event => { event.preventDefault(); const input = $('chat-input'); if (input.value.trim()) send({ type: 'chat', text: input.value.trim() }); input.value = ''; input.blur(); stopKeys(); };
window.addEventListener('keydown', e => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
  if (typing) { if (e.key === 'Escape') { e.target.blur(); stopKeys(); } return; }
  if (!myId) return;
  if (e.key === 'Enter') { e.preventDefault(); stopKeys(); $('chat-input').focus(); return; }
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyF'].includes(e.code)) e.preventDefault();
  if (e.code === 'KeyF' && !e.repeat) command({ kind: 'ability' });
  keys.add(e.code);
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', stopKeys);
document.addEventListener('focusin', e => { if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) stopKeys(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopKeys(); if (isHost) connection('Hosting in background · keep this browser open.'); } });
setInterval(() => {
  if (myId) {
    const pressed = (...codes) => codes.some(k => keys.has(k)) ? 1 : 0;
    const x = pressed('KeyD', 'ArrowRight') - pressed('KeyA', 'ArrowLeft');
    const y = pressed('KeyS', 'ArrowDown') - pressed('KeyW', 'ArrowUp');
    command({ kind: 'move', x, y });
  }

}, 50);
function frame() {
  if (wow) arena.nameplates(state, myId);
  else arena.draw(state?.phase === 'lobby' ? null : state, myId);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

async function loadWorld() {
  if (worldLoaded) return;
  const player = myId;
  $('world-status').textContent = 'Preparing the original 3D world…';
  try {
    if (!navigator.gpu || !await navigator.gpu.requestAdapter()) throw new Error('WebGPU is unavailable. Enable hardware acceleration in a recent Chrome or Edge browser.');
    const response = await fetch('../wenilla_bg.wasm', { method: 'HEAD' });
    if (!response.ok) throw new Error('The website is missing its 3D renderer bundle. Ask the website operator to rebuild it.');
    if (myId !== player) return;
    $('world').src = `../index.html?coop=1${localDataId ? `&localData=${localDataId}` : ''}`; worldLoaded = true; $('world').hidden = false;
  } catch (e) { if (myId === player) $('world-status').textContent = e.message; }
}
setInterval(() => {
  if (!wow || !myId) return;
  const ready = window.__azeroth_coop_ready === true && !window.__azeroth_coop_error;
  if (ready !== rendererReady) { rendererReady = ready; send({ type: 'ready', ready }); }
  if (window.__azeroth_coop_error) { $('world-status').textContent = window.__azeroth_coop_error; connection('3D renderer stopped. Leave the party and reload the client.'); return; }
  if (worldLoaded) $('world-status').textContent = ready ? '3D world ready. Waiting for the party.' : `Loading terrain and character models… ${Math.round((window.__azeroth_coop_loading || 0) * 100)}%`;
}, 500);
// The iframe shares the origin; a parent gesture resumes its original audio mixer too.
for (const event of ['pointerdown', 'keydown']) window.addEventListener(event, () => $('world').contentWindow?.__azeroth_resume_audio?.());

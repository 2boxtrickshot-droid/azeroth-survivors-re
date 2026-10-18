export const BUILDS = {
  protection: { name: 'Protection', class: 1, role: 'TANK', ability: 'Challenging Shout', description: 'Cleave the front line. F taunts nearby enemies for 4s and grants 40% extra mitigation for 5s. Passive 35% mitigation.', icon: '◆' },
  fury: { name: 'Fury', class: 1, role: 'MELEE DPS', ability: 'Whirlwind', description: 'Heavy cleaves strike up to six nearby enemies. F unleashes a wide Whirlwind. Stay close and keep moving.', icon: '⚔' },
  restoration: { name: 'Restoration', class: 7, role: 'HEALER', ability: 'Chain Heal', description: 'Healing Wave automatically helps the most injured ally in range. F heals the party and grants shields. Lightning adds damage.', icon: '✦' },
  elemental: { name: 'Elemental', class: 7, role: 'RANGED DPS', ability: 'Thunderstorm', description: 'Chain Lightning strikes three foes. F blasts nearby enemies. Area upgrades add more lightning targets.', icon: 'ϟ' },
  enhancement: { name: 'Enhancement', class: 7, role: 'MELEE DPS', ability: 'Stormstrike', description: 'Lightning-infused melee strikes hit three foes. F releases a powerful storm around you. Higher damage at close range.', icon: '⚒' },
  frost: { name: 'Frost', class: 8, role: 'RANGED DPS', ability: 'Frost Nova', description: 'Frostbolt slows its target. F damages and slows the surrounding horde for 4s. Create breathing room for your party.', icon: '❄' },
};
export const UPGRADES = [
  ['Spell & steel', '+22% base damage and healing'], ['Quickening', '+14% attack and healing frequency'],
  ['Widening storm', '+16% area; every 2 ranks add a lightning target'], ['Endurance', '+20 maximum health; restore 20 health'],
  ['Trailblazer', '+7% movement speed; +1 yard XP pickup'], ['Restorative spirit', '+0.3 health/sec; +20% base healing'],
];
export function bar(value, max, kind = '') {
  const box = document.createElement('div'); box.className = `bar ${kind}`;
  const fill = document.createElement('i'); fill.style.width = `${Math.max(0, Math.min(100, value / Math.max(1, max) * 100))}%`;
  box.append(fill); return box;
}
export function label(tag, text, className) {
  const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el;
}
export class Arena {
  constructor(canvas, plates, classes) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.plates = plates; this.classes = classes;
    this.positions = new Map(); this.camera = { x: 0, y: 0 }; this.last = performance.now();
  }
  color(build) { return this.classes.find(c => c.id === BUILDS[build]?.class)?.color || '#fff'; }
  nameplates(state, id) {
    this.plates.replaceChildren();
    if (!state) return;
    const placed = [];
    for (const p of state.players) {
      const point = window.__azeroth_coop_plates?.[p.id];
      if (!p.connected || !point || !point.every(Number.isFinite)) continue;
      let [x, y] = point; y -= 32;
      if (x < 0 || x > innerWidth || y < -40 || y > innerHeight) continue;
      const w = Math.max(110, (p.name.length + BUILDS[p.build].name.length) * 7);
      let overlap = true;
      while (overlap) {
        overlap = false;
        for (const q of placed) if (Math.abs(x - q.x) < (w + q.w) / 2 && Math.abs(y - q.y) < 32) { y = q.y - 33; overlap = true; }
      }
      placed.push({x, y, w});
      const plate = label('div', `${p.name} · ${BUILDS[p.build].name}${p.hp === 0 ? ' · DOWN' : ''}`, 'plate');
      plate.style.left = `${x}px`; plate.style.top = `${y}px`; plate.style.color = this.color(p.build);
      plate.append(bar(p.hp, p.max_hp)); this.plates.append(plate);
    }
  }
  draw(state, id, wow = false) {
    const { canvas, ctx: c } = this;
    const width = innerWidth, height = innerHeight, dpr = Math.min(devicePixelRatio, 2);
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) { canvas.width = width * dpr; canvas.height = height * dpr; }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dt = Math.min((performance.now() - this.last) / 1000, .1); this.last = performance.now();
    const scale = Math.min(width / 75, height / 52);
    const me = state?.players.find(p => p.id === id);
    if (me) { this.camera.x += (me.pos.x - this.camera.x) * Math.min(1, dt * 8); this.camera.y += (me.pos.y - this.camera.y) * Math.min(1, dt * 8); }
    const screen = p => ({ x: width / 2 + (p.x - this.camera.x) * scale, y: height / 2 + (p.y - this.camera.y) * scale });
    c.clearRect(0, 0, width, height);
    const gradient = c.createRadialGradient(width / 2, height / 2, 10, width / 2, height / 2, width * .7);
    gradient.addColorStop(0, '#344637'); gradient.addColorStop(1, '#0b1915'); c.fillStyle = gradient; c.fillRect(0, 0, width, height);
    // Procedural terrain is original code; no game assets or external downloads.
    for (let x = -75; x <= 75; x += 5) for (let y = -75; y <= 75; y += 5) {
      const p = screen({ x, y }); if (p.x < -80 || p.x > width + 80 || p.y < -80 || p.y > height + 80) continue;
      const n = Math.abs(Math.sin(x * 7.12 + y * 8.71));
      c.strokeStyle = '#7e97631b'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x + 2, p.y - 4 - n * 5); c.stroke();
      if (Math.abs(x) >= 65 || Math.abs(y) >= 65) { c.fillStyle = '#122c20'; c.beginPath(); c.arc(p.x, p.y, (1.2 + n) * scale, 0, Math.PI * 2); c.fill(); }
    }
    const edge = screen({ x: -65, y: -65 }); c.strokeStyle = '#a8a57366'; c.setLineDash([8, 10]); c.strokeRect(edge.x, edge.y, 130 * scale, 130 * scale); c.setLineDash([]);
    if (!state) { this.plates.replaceChildren(); return; }
    const circle = (p, r, fill, stroke) => {
      const q = screen(p); c.beginPath(); c.arc(q.x, q.y, r * scale, 0, Math.PI * 2);
      if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.stroke(); }
    };
    const slot = state.players.findIndex(p => p.id === id);
    for (const g of state.gems) {
      if (g.collected & (1 << slot)) continue;
      const p = screen(g.pos); c.fillStyle = '#89dbd2'; c.beginPath(); c.moveTo(p.x, p.y - 5); c.lineTo(p.x + 3, p.y); c.lineTo(p.x, p.y + 5); c.lineTo(p.x - 3, p.y); c.fill();
    }
    for (const h of state.hazards) { circle(h.pos, h.radius, '#e74c3533', '#f39b68'); circle(h.pos, h.radius * Math.max(.1, 1 - h.left / 1.8), null, '#edb376'); }
    const aliveIds = new Set();
    const smooth = (key, target) => {
      aliveIds.add(key); let p = this.positions.get(key);
      if (!p || Math.hypot(p.x - target.x, p.y - target.y) > 12) p = { ...target };
      p.x += (target.x - p.x) * Math.min(1, dt * 14); p.y += (target.y - p.y) * Math.min(1, dt * 14);
      this.positions.set(key, p); return p;
    };
    for (const e of state.enemies) {
      const pos = smooth(`e${e.id}`, e.pos), p = screen(pos), r = e.boss ? 2 : e.elite ? 1.1 : .65;
      circle(pos, r + .13, '#0a1412', e.boss ? '#efb664' : e.elite ? '#d1a6ee' : '#6e342d');
      circle(pos, r, e.slow > 0 ? '#729fba' : e.boss ? '#9c5842' : ['#8e6053', '#bb8962', '#89769f'][e.kind]);
      c.fillStyle = '#e5d5b2'; c.fillRect(p.x - r * scale * .5, p.y - 2, 3, 2); c.fillRect(p.x + r * scale * .3, p.y - 2, 3, 2);
      if (e.hp < e.max_hp) { c.fillStyle = '#161817'; c.fillRect(p.x - 10, p.y - r * scale - 6, 20, 3); c.fillStyle = '#c97762'; c.fillRect(p.x - 10, p.y - r * scale - 6, 20 * e.hp / e.max_hp, 3); }
    }
    for (const f of state.effects) {
      c.globalAlpha = Math.min(1, f.left * 4);
      const from = screen(f.from), to = screen(f.to);
      c.strokeStyle = f.kind === 'heal' ? '#8de7ac' : f.kind === 'frost' ? '#98daed' : '#ebca78'; c.lineWidth = 2;
      if (['nova', 'guard'].includes(f.kind)) circle(f.to, f.radius, null, c.strokeStyle);
      else { c.beginPath(); c.moveTo(from.x, from.y); c.lineTo((from.x + to.x) / 2 + 4, (from.y + to.y) / 2 - 5); c.lineTo(to.x, to.y); c.stroke(); }
      c.globalAlpha = 1;
    }
    const platePositions = [];
    this.plates.replaceChildren();
    for (const p of state.players) {
      if (!p.connected) continue;
      const pos = smooth(`p${p.id}`, p.pos), s = screen(pos), color = this.color(p.build);
      circle(pos, .95, '#08181388', p.id === id ? '#f7e6aa' : '#8bb89b');
      circle(pos, .65, p.hp > 0 ? color : '#62645d');
      c.fillStyle = '#28342e'; c.fillRect(s.x - 4, s.y - 1, 8, 5);
      c.fillStyle = '#eadcc0'; c.beginPath(); c.arc(s.x, s.y - 5, 4, 0, Math.PI * 2); c.fill();
      if (p.shield > 0) circle(pos, 1.2, null, '#adcfef');
      if (p.revive > 0) { c.fillStyle = '#b2e8bd'; c.fillRect(s.x - 15, s.y + 18, 30 * p.revive / 4, 3); }
      let px = s.x, py = s.y - 53;
      if (wow && window.__azeroth_coop_plates?.[p.id]) { [px, py] = window.__azeroth_coop_plates[p.id]; py -= 35; }
      else if (wow) continue;
      const labelWidth = Math.max(100, p.name.length * 8);
      let moved = true;
      while (moved) { moved = false; for (const other of platePositions) if (Math.abs(px - other.x) < (labelWidth + other.w) / 2 && Math.abs(py - other.y) < 32) { py = other.y - 33; moved = true; } }
      platePositions.push({ x: px, y: py, w: labelWidth });
      const plate = label('div', `${p.name} · ${BUILDS[p.build].name}`, 'plate');
      plate.style.left = `${px}px`; plate.style.top = `${py}px`; plate.style.color = color;
      plate.append(bar(p.hp, p.max_hp)); this.plates.append(plate);
    }
    for (const key of this.positions.keys()) if (!aliveIds.has(key)) this.positions.delete(key);
    if (wow) c.clearRect(0, 0, width, height);
  }
}

# Azeroth Survivors → 3–5 player co-op horde-survival roguelite

Architecture inspection and staged implementation plan.

Status: **inspection + plan only.** No game code was changed and no dependency was
added. This document is the only new file. Everything below is derived from reading the
tree at `dd5e330` (branch `main`).

---

## 1. What this project actually is

`Azeroth Survivors` is not a standalone survivors game with WoW art bolted on. It is the
**real WoW 1.12.1 client engine** (`benilla`), forked as `wenilla` for the browser, with a
single self-contained gameplay mode — `crates/benilla-app/src/survivors/` — booted
**server-less**. The README states this and the code confirms it.

Workspace: `crates/*` (19 members, `resolver = "2"`, Bevy **0.18.1**, toolchain pinned to
**1.98.1**).

| crate | role |
|---|---|
| `benilla-app` | the game. All gameplay modules, UI, net session, `survivors/`. ~100 modules. |
| `benilla-world` | engine: terrain streaming, world plugins, camera, rig animation, particles, model fade |
| `benilla-assets` | the `mpq://` asset pipeline, coordinate conversions (`bevy_to_wow`) |
| `benilla-formats` | MPQ/BLP/M2/ADT/WDT/WMO/DBC readers |
| `benilla-protocol` | the **WoW wire protocol client** (auth, world handshake, transports) |
| `benilla-ui` | the FrameXML / Lua 5.1 VM (off in survivors) |
| `benilla-adt`, `-blp`, `-dbc`, `-m2`, `-mpq`, `-wdt`, `-wmo`, `-bytes`, `-srp`, `-buildstamp` | format crates |
| `warcraft-survivors` | **native launcher shim** — 23 lines, calls `benilla_app::run_survivors` |
| `wenilla` | **wasm launcher shim** — `#[wasm_bindgen(start)]`, calls the same entry point |
| `wenilla-host` | local dev server: static `web/dist`, `/data/*` from the MPQs, `/ws/<port>` TCP relay. Loopback only. |

Three launcher shims, one body. `benilla_app::run`, `::run_with(build, extend)` (the
documented "build on top of benilla" seam) and `::run_survivors` all funnel into
`launch()` (`crates/benilla-app/src/lib.rs:239`). `run_survivors` sets
`survivors::ACTIVE` and then `launch` does the survivor-specific wiring:

- `benilla_world::world_map::set_start_map(1)` — Kalimdor.
- `GamePlugins { connect: !capturing && !survivors, start: ClientState::InWorld }`
  (`lib.rs:435`) — **the network session thread is never started**, and login /
  character-select are skipped. Survivors is "the engine with the wire cut".
- `app.add_plugins(survivors::SurvivorsPlugin)` (`lib.rs:443`).
- Window title `"Warcraft Survivors"`.

So: **the browser build is survivors, unconditionally** (`crates/wenilla/src/lib.rs`
calls `run_survivors`), and the native `make native` target is the same game on desktop.
`?survivors=1` / `WOW_SURVIVORS` is a legacy second path (`survivors::active()`), no
longer needed to enter the mode.

## 2. Rendering style

**Real 3D WoW, viewed top-down.** Not sprites, not 2D. The mode streams the actual ADT
terrain, WMO, M2 creature models, BLP textures and spell particle kits for the picked
battleground, and the party/enemies are drawn by the *same* attach + animation +
spell-visual systems that dress a streamed unit off the wire.

The camera is `hero::CamRig` + `benilla_world::view::WorldCamera`: locked top-down by
default (`FIXED_PITCH = 61°`), `C` unlocks an orbit rig (right-drag swing/tilt, pitch
clamped 10°–83°), wheel zooms 1.5–70 yd. `hero::place_camera` seats it on the hero.

A post pass (`shaders/survivors_grade.wgsl`) does sharpen + vibrance + S-curve, toggled
with `G` / `?grade=0`.

All screens are **`bevy_ui`**, not FrameXML — the mode inserts
`crate::run_mode::CaptureMode` (`mod.rs:40`) so `OnEnter(InWorld)` skips the FrameXML
load. HUD, menu, level-up cards, pause, results and the composited minimap live in
`survivors/hud.rs`, `cards.rs`, `menu.rs`, `minimap.rs`.

Two GPU backends on wasm: `webgpu` (default; the world needs storage buffers) and
`webgl2` (glue screens only). Native uses `tuned_default_plugins`.


## 3. Player controls

`hero::drive_hero` (`hero.rs:188`) is the whole input path:

- **WASD / arrows** — world-relative in locked mode, camera-relative in orbit mode.
- **Hero faces the cursor** (`hero::aim_cursor` → `AimPoint`); movement is therefore
  backpedal + strafe, with the gait chosen by `hero::gait` (FORWARD / BACKWARD /
  STRAFE_LEFT / STRAFE_RIGHT, driving `creature_anim::move_flags`).
- **Space** jump (WoW `JUMP_SPEED` / `GRAVITY` constants).
- **F** — class mobility spell from level 5 (`mobility.rs`: Blink, Charge, Sprint, Dash,
  Fade, Ghost Wolf, Aspect of the Cheetah, Blessing of Freedom, Howl of Terror).
- **C** camera lock toggle, **wheel** zoom, **Esc** pause, **G** grade, **1/2/3** card pick.

Input is raw `ButtonInput<KeyCode>` plus `crate::player::Player` for facing. An autopilot
(`auto.rs`, `WOW_SURVIVORS_AUTO=<class>`) can substitute a steer vector — this is the
existing headless harness and is directly reusable for multiplayer validation.

## 4. Combat systems

`data.rs` (2020 lines) is the entire design table:

- **`CLASSES`** — 9 rows, WoW class ids `1,2,3,4,5,7,8,9,11` (Warrior, Paladin, Hunter,
  Rogue, Priest, Shaman, Mage, Warlock, Druid). Each has `power` (power type), `start`
  ability, a `pool` of ability keys, creature display ids for the menu look, and virtual
  weapon slots. **No role field exists** — this is where Tank/Healer/DPS must land.
- **`ABILITIES`** (~100 rows) — `kind` ∈ `Bolt | Strike | Melee | Nova | Cone | Ground |
  GroundSelf | Chain | Dot | Aura | Orbit | Shield | Immune | Thorns | Heal | Totem`;
  `effect` ∈ `None | Slow | Root | Stun | Fear | Weaken | Drain | Execute`. Spell ids are
  used only for icon/name/visual chain; **every number is the mode's own**.
- **`PASSIVES`** — 10 stats: `Might, MaxHp, Speed, Regen, Haste, Area, Magnet, Growth,
  Armor, Crit`, each 5 levels.
- **`ENEMIES` / `BOSSES`** — the Barrens-tuned ladder; every other map is numbered off it
  by `ladder()` (`data.rs:1982`), so 16 maps share one tuning curve.
- **Wave clock**: `VICTORY_SECS = 900`, `BOSS_EVERY_SECS = 135` (6 bosses), `XP_RATE`,
  `target_alive` 14 → 220, `hp_scale` 1.0 → 1.75, `damage_scale` 1.0 → 1.9,
  `xp_to_next` a Vampire-Survivors-style curve.

`abilities.rs` is auto-cast, no aiming:

- `cast_abilities` walks `run.abilities`, fires each on `Owned::cooldown(stats)`
  (haste-reduced), picks targets by `Kind`, emits visuals via `Fx`, and **schedules
  `Hit`s into `PendingHits` keyed by landing time** so damage lands when the missile would.
- `apply_hits` resolves damage, crits, splash, DoTs, CC, `Execute`, `Drain`, thorns, aura
  marks, kills, `run.damage_done`, and the loot message.
- `tick_areas` runs ground areas and totems on their own tick timers.

Damage is plain local floats on `Run` / `Enemy`; `hero::hurt_hero` applies armor then the
absorb shield.

**Level-up (the roguelite core)**: `enemies::collect_gems` banks XP and sets
`Phase::LevelUp`; `hud::choices_for` builds a **weighted** pool (upgrades ×1.2, new
abilities ×1.0, new passives ×0.5) and draws 3; `cards::rarity` colours each by a
damage-per-second heuristic in WoW item-quality colours; `cards::choose_card` /
`hud::pick` apply the choice to `Run` and bump `run.version` so the HUD rebuilds once.

Critically for us: entering `Phase::LevelUp` calls `Time<Virtual>::pause()` (`mod.rs:132`)
— **a global world pause**. Same for `Phase::Paused`. This is the single biggest
single-player assumption in the mode.

## 5. Enemy AI

`enemies.rs`:

- **Spawn** (`spawn_enemies`): a ring 34–42 yd out, kept at `target_alive(elapsed)`;
  every half-boss-interval a closing ring of 28–88 of the moment's weakest; a boss every
  `BOSS_EVERY_SECS` from the map's `Roster`. Spawned units are `Guid` + `NetEntity` +
  `ObjectStore` with `FACTION_MONSTER`.
- **Chase** (`move_enemies`): straight at the **single** `Hero`, with per-pair push-apart
  from a spatial hash, ground-clamped to terrain each frame, yaw-slerped to face travel.
- **Aggro is hard-coded**: `hero.single()`. There is no threat table, no taunt, no target
  selection. `Fade` (`run.mobile.vanish_t`) makes non-bosses "lose" the hero and mill in
  place — that is the only aggro-like state in the codebase.
- **Contact damage**: `attack_cd` 1.3 s (1.0 boss), scaled by `weaken`, applied through
  `hurt_hero`; thorns reflects.
- **CC state** per enemy: `slow/slow_t`, `root_t`, `stun_t`, `fear_t`, `weaken/weaken_t`,
  `dots: Vec<Dot>` (max 6), all boss-resisted by a factor.
- **Leash**: an enemy >75 yd behind is teleported back to 38 yd.

## 6. Build process

| | command | notes |
|---|---|---|
| data | `scripts/fetch-data.sh` | English 1.12.1 (5875) client from archive.org, **~5.5 GB**, MPQs to `wow-data/Data` (git-ignored) |
| toolchain | `scripts/web-setup.sh` | wasm32 target, `wasm-bindgen-cli` **pinned to `Cargo.lock`**, wasi-sdk (Lua's C build), binaryen. No sudo. |
| wasm | `scripts/web-build.sh` | `cargo build --target wasm32-unknown-unknown -p wenilla --no-default-features --features webgpu` → `wasm-bindgen --target web` → strip → `wasm-opt -O3` → `cp web/{index.html,favicon.svg,wasi_stubs.js,boot.js,platform.js,bridge.js}` + `examples/` + manifests into `web/dist` |
| serve | `make start` | `cargo run --release -p wenilla-host -- --www web/dist --data wow-data/Data` → `http://127.0.0.1:8090/` |
| native | `make native` | `WOW_DATA=… cargo run --release -p warcraft-survivors` |
| CI | `.github/workflows/check.yml` | wasm `cargo check`; `node --test web/tests/*.mjs`; `cargo test -p wenilla-host`; two targeted `benilla-ui` / `benilla-world` groups. **No full workspace test** (needs a patch chain). |

Two hard build facts:

1. **The shipped page is the `cp` line.** A page-side file not on it never reaches
   `web/dist`, so never reaches the browser. Any new `web/*.js` must be added there.
2. `wasm-bindgen` crate and CLI versions must match exactly.

**This sandbox has no `cargo`/`rustc` and no game data**, so nothing here was compiled or
run. See §10.

---

## 7. The seam multiplayer must be built on — and the eight hard constraints

### 7.1 The good news: the mode already fakes a server

`survivors/units.rs` spawns the hero, enemies and pickups as `Guid` + `NetEntity` +
`ObjectStore` entities and **writes WoW descriptor fields into them** (`FIELD_HEALTH`,
`FIELD_MAX_HEALTH`, `FIELD_FACTION`, `FIELD_BYTES_0`, `FIELD_VIRTUAL_ITEM_*`,
`FIELD_AURA`, `FIELD_AURAFLAGS`, …). It then emits the same messages a server would:

- `FieldChanged { entity, guid, kind, index, old, new }`
- `CastEvent` / `CastEventKind::Go | Impact` (via `units::Fx`)
- `SpellGoTargets` (missiles and impacts)
- `SwingMessage` (melee)
- `CombatTextSpawn` (floating numbers)
- `enemies::Loot` (internal)

So the presentation layer already consumes "server-shaped" state. That is the correct
replication boundary: **one peer owns the simulation, everyone else applies replicated
field updates / transforms / cast messages.** `net/objects.rs` (1565 lines) and
`net/apply.rs` are the existing consumers of that shape, which means a replicated entity
needs *no new rendering work* — only a new producer.

### 7.2 The eight hard constraints

1. **Everything is single-hero.** ~15 call sites use `hero.single()` / `single_mut()`:
   `enemies::spawn_enemies`, `enemies::move_enemies`, `enemies::collect_gems`,
   `abilities::cast_abilities`, `mobility::cast_mobility`, `hero::drive_hero`,
   `hero::place_camera`, `hero::hero_vitals`, `minimap::compose`, `hud::hero_plate`,
   `auto::plan`. And **`Run` is one global resource** holding class, xp, level, abilities,
   passives, hp, shield, thorns, mobility, kills, damage. Party support means
   `Hero` → `PartyMember { owner: OwnerId }` and `Run` → `SharedRun` (world clock, wave
   state, rng) + per-member `HeroRun`.
2. **Global `Time<Virtual>` pause** on level-up and pause (`mod.rs:132-133`). In co-op a
   level-up must be local UI only; the world must never stop for the others. Same for the
   pause screen (a party pause needs a vote or a host-only pause).
3. **Global `Rng`** (xorshift64*, seeded from `SystemTime`) and one `Spawner` resource.
   Both must become host-authoritative and seeded from the host, or two peers diverge
   immediately.
4. **`Selection` / `CurrentMap` is one world.** The whole party shares one battleground —
   which is what the design wants, so this is an asset, not a problem. It does mean map
   choice is a lobby decision.
5. **No threads on wasm.** The browser build runs one thread and `std::time::Instant` /
   `SystemTime` panic there (the codebase already uses `bevy::platform::time::Instant` /
   `web-time`). Networking must be event-loop driven and non-blocking. `benilla-protocol`'s
   `transport::web::Conn` already proves the pattern (`block_on`, `SendWrapper`,
   `wasm_bindgen` closures).
6. **A page cannot listen on a socket.** "One player hosts, no dedicated server" rules out
   the existing `wenilla-host` `/ws/<port>` TCP relay (that *is* a server, and it dials a
   fixed upstream). The only browser-native answer is **WebRTC `RTCPeerConnection` +
   `RTCDataChannel`**, host = the peer that opens the offer, invite = the SDP/ICE exchange.
7. **No `serde_json` in the shipped app.** The bridge deliberately uses plain objects and
   `PlainValue` (`webbridge/mod.rs` header says so). A wire codec should be hand-rolled on
   the existing `benilla-bytes` / `wire.rs` patterns, or plain JS objects on the JS side —
   do not add serde to the shipped wasm.
8. **Each peer already has the world.** Terrain, models and DBCs load locally from the
   MPQ chain on both host and joiner. **Only gameplay state needs to cross the wire** —
   not geometry, not assets. That is why a peer-to-peer mesh is viable at all: a snapshot
   of ~200 enemies × (pos, yaw, hp) plus 5 players is on the order of a few KB/s.

### 7.3 The one existing channel to hang it on

`crates/benilla-app/src/webbridge/` is a **live, bidirectional, non-load-bearing** channel
that already crosses the wasm↔JS boundary once a frame via `Reflect::get` on
`window.__wenilla_bridge` (`onFrame`, `onEvent`, a drained `queue`). It is compiled into
the shipped browser build (not dev-gated) and its header explicitly invites exactly this
kind of page-side extension ("a web HUD, a proximity-chat overlay, a gamepad mapper").

Two viable plumbing options, both reusing that idiom:

- **A. `web/net.js` + a new `window.__wenilla_net` object**, mirroring `webbridge`'s
  `Reflect.get`/`call`/plain-object shape: JS owns `RTCPeerConnection`, Rust owns the
  game. Cleanest, keeps WebRTC out of Rust entirely, and `web/net.js` must be added to the
  `cp` line in `web-build.sh`.
- **B. A Rust `Conn` in `benilla-protocol/src/transport/`** over a DataChannel, so the
  existing async-reader patterns are reused. More invasive; `benilla-protocol` is an
  upstream crate (carry discipline applies), and it would tempt us into reusing the WoW
  packet format, which is wrong for this game.

---

## 8. Recommended network design

**Topology: host-authoritative star.** One player is the host (runs the full simulation:
spawner, rng, enemies, damage, loot, wave clock). The other 1–4 are clients that run the
renderer, their own input and their own level-up UI, and apply replicated state. This
matches the code's existing shape (§7.1) with the least new machinery, and it is the only
model that survives the constraints in §7.2 without a rewrite.

**Transport: WebRTC DataChannels, one per pair.** Host opens an `RTCPeerConnection` per
joiner; joiner opens one back. Unreliable-unordered for transforms (they are
last-write-wins), reliable-ordered for discrete events (spawn, death, level-up, boss, map
choice, invite/join handshake).

**Invites without a server.** Two acceptable v1 mechanisms:

- **Manual copy/paste (M0's choice):** the host gathers ICE to completion
  (**non-trickle / vanilla ICE** — `icegatheringstate === 'complete'`), serialises the whole
  offer into one blob (gzip + base64), and sends it out of band. The joiner pastes it and
  returns one answer blob. One paste each way, not one per candidate. Zero infrastructure.
- **A signaling page (later, designed for but not built):** a static page whose only job is
  to swap two opaque blobs. It holds no game state and runs no simulation. §11.3 says how
  `web/net.js` is shaped so this is a new `Signal` implementation and not a refactor.

**Rate/ownership:**

| direction | payload | channel |
|---|---|---|
| client → host | `{seq, input:{dir:[x,z], face:yaw, jump, mobility, cardPick}}` ~30 Hz | unreliable |
| host → client | `{tick, players:[{id,pos,yaw,hp,level,role}], enemies:[{id,pos,yaw,hp,flags}], casts:[…], events:[…]}` 10–20 Hz, deltas only | unreliable (transforms) / reliable (events) |
| host → client | `{seed, map, rosterIndex, party}` once at join | reliable |
| client → host | `{levelUp: cardIndex}` (the client decides its own build, host validates) | reliable |

**Prediction, deliberately deferred.** v1: clients send input and render the host's
position for themselves too (a few tens of ms of input lag). Local movement prediction is
a later polish item, not a milestone — the user's own priority is "two players connected
and sharing movement" before full party combat.

**Codec.** Host↔client messages as compact binary (hand-rolled, `benilla-bytes` style) or,
for v1, plain JS objects through the bridge (zero new Rust). Quantise positions to 0.01 yd
and hp to u16 before going binary; 200 enemies then fit in a couple of KB per snapshot.

---

## 9. Staged implementation plan

The smallest viable first milestone is **M0 + M1: two browsers, one hosts, one joins via
invite, both see each other move in the same battleground — with no combat replication at
all.** Nothing else is worth building until that is real.

### M0 — De-single-player the mode (no networking, no new deps)

Pure refactor, single-player behaviour must be unchanged, validated by the existing
autopilot (`WOW_SURVIVORS_AUTO`) and the wasm/native `cargo check`.

1. Split `Run` into `SharedRun` (elapsed, `bosses`, `rings`, `next_guid`, `won`, `banner`,
   spawner state) and `HeroRun` (class, race, xp, level, hp, abilities, passives,
   shield/thorns/heal, mobility, pending_levels, damage_done, version, dead_t). Add a
   `Party { members: Vec<Entity> }` resource.
2. Replace `Hero` with `PartyMember { owner: OwnerId, slot: u8, role: Role }`; keep a
   `LocalPlayer` marker so `drive_hero` / `aim_cursor` / `place_camera` bind to exactly
   one member.
3. Rewrite the ~15 `single()` sites: per-member where the semantics are per-member
   (`cast_abilities`, `hero_vitals`, `collect_gems` magnet), **nearest member** where the
   semantics are world-level (`spawn_enemies` ring centre, `move_enemies` chase target,
   `minimap` centre, `hero_plate`).
4. Add `Role { Tank, Healer, Dps }` to `ClassDef` and a per-class role table (Warrior /
   Paladin → Tank, Priest / Druid → Healer, rest → DPS; Paladin / Shaman / Druid are the
   hybrid arguments — decide per class, not per tree, for v1).
5. Make level-up non-pausing: `Phase::LevelUp` must stop being a global state that pauses
   `Time<Virtual>`. Move it to a per-member flag (`HeroRun.pending_levels`) with a local
   overlay; the world keeps running. `Phase::Paused` becomes host-only.
6. `Rng` gains an explicit seed so the host can hand it to joiners; `Spawner` moves onto
   `SharedRun`.

Deliverable: one player, identical to today, but the code is party-shaped.

### M1 — Two peers, shared movement (the first milestone)

1. `web/net.js`: `RTCPeerConnection` + DataChannel, offer/answer + ICE blob generation and
   paste-in, `window.__wenilla_net = { send(obj), onMessage(obj), peers: [] }`, mirroring
   `web/bridge.js`'s shape. Add it to the `cp` line in `scripts/web-build.sh`.
2. `crates/benilla-app/src/survivors/coop.rs` (a new file — keeps the carry surface
   small): a `CoopPlugin` that
   - reads `__wenilla_net` once a frame (the `webbridge` idiom, `Reflect::get`),
   - sends the local input packet,
   - applies peer transforms onto `PartyMember` entities,
   - owns `OwnerId` allocation and the join handshake (`seed`, `map`, `party`).
3. A minimal lobby UI in `hud.rs` / `menu.rs`: Host / Join, the invite blob in a textarea,
   a per-member class/role pick, and "waiting for players".
4. Peer avatars use the **same** `units::spawn_unit` + `UnitSpec` path as the local hero,
   with `Guid` + `NetEntity` + `ObjectStore` — so they animate, cast and take nameplates
   with no new rendering code.

Validation: two browser tabs (or two machines) against `wenilla-host`; host picks a map,
joiner joins via blob, both walk, both see the other's gait / backpedal / facing, and a
disconnect/reconnect is survivable.

### M2 — Host-authoritative combat, per-player level-up

- Host replicates spawn / kill / hp deltas and `CastEvent` / `SpellGoTargets` /
  `SwingMessage` / `CombatTextSpawn`. Clients stop running `spawn_enemies`,
  `move_enemies`, `apply_hits` (gate them on `is_host`).
- Client inputs become intents the host resolves. Damage, XP gems and kills are host-side;
  gems are granted to the member that earned them, or split.
- Roles become mechanical: an enemy `threat` map with the Tank's abilities building threat
  and a taunt; Healer abilities gain ally targets (`Kind::Heal` exists but only ever
  self-targets today); DPS keeps the current single-target / area pool.
- Party HUD: 5 plates (`hud.rs` already draws one; make it a list).

### M3 — Party-scale content

- Multiplayer scaling: `target_alive`, `hp_scale`, `damage_scale`, XP and loot keyed off
  party size, so 5 players is not trivially easier than 1.
- Elite enemies (a new `EnemyDef` flag + affixes), shared boss HP with a party-visible bar,
  downed / revive instead of instant game-over, and a party-wipe condition.
- Synergies: cross-class effects (e.g. a Tank's `demoralizing_shout` raising Healer
  throughput) and role-aware level-up pools.

### M4 — Loot and persistent progression

- Loot tables and item drops between waves; the mode's `Weapon` / virtual-item plumbing
  already knows how to display them.
- Persistent character progression: `local_state.rs` already persists `config.toml`, saved
  variables, keybinds and the remembered pick to `localStorage` on web and
  `benilla-config/` on native. Meta-progression (unlocks, class levels) belongs there, or
  host-signed so a client cannot forge it.
- Roguelite meta layer: unlock new abilities / passives per class across runs.

---

## 10. Verification, risks and open questions

### What was verified (by reading)

- The mode's entry points and that the wire is cut: `lib.rs:230-233`, `lib.rs:435-445`,
  `wenilla/src/lib.rs:22-39`, `warcraft-survivors/src/main.rs`.
- The single-hero assumption, exhaustively: 15 `single()` / `single_mut()` sites across
  `enemies.rs`, `abilities.rs`, `hero.rs`, `mobility.rs`, `minimap.rs`, `hud.rs`, `auto.rs`.
- The global pause: `mod.rs:132-133` (`Time<Virtual>::pause()` on `LevelUp` / `Paused`).
- The sim→presentation seam: `units.rs` descriptor writes and the `FieldChanged` /
  `CastEvent` / `SpellGoTargets` / `SwingMessage` / `CombatTextSpawn` messages.
- No existing multiplayer of any kind: zero hits for `peer|lobby|multiplayer|coop|netcode`
  in `survivors/`, `warcraft-survivors/`, `web/`; zero hits for `RTCPeerConnection` /
  `WebRTC` anywhere in the tree.
- The web build's shipped-file list (`scripts/web-build.sh` `cp` line) and CI gates
  (`.github/workflows/check.yml`).

### What was NOT verified (and cannot be, here)

- **Nothing was compiled.** This sandbox has no `cargo`/`rustc` (`rustc: command not
  found`), no wasm toolchain, and no 1.12.1 game data (~5.5 GB). Every claim above is from
  source reading. Before M0 starts, the first action must be a green
  `cargo check --workspace --all-targets` and
  `cargo check --target wasm32-unknown-unknown -p wenilla --no-default-features --features webgpu`
  in an environment with rustup, to establish the baseline.
- Browser/WebRTC behaviour, latency budget, and whether a 200-enemy snapshot at 10 Hz is
  actually comfortable are all unmeasured. M1 should measure before M2 assumes.

### Risks, ranked

1. **M0's refactor is the real work, and it is invisible.** Splitting `Run` and de-singling
   the hero touches every file in `survivors/` (9329 lines). It has no player-visible
   payoff, and it can regress single-player. Mitigation: land it as its own PR with the
   autopilot runs compared before/after, and do not mix it with any netcode.
2. **Two diverging simulations.** If a client ever runs `spawn_enemies` with its own `Rng`,
   the party desyncs permanently. Mitigation: gate all world mutation on `is_host` in M2,
   and treat the host snapshot as the only truth for enemies.
3. **`benilla` is upstream and fork discipline applies.** `docs/CONTRIBUTING.md` says a
   deviation lives in a crate of its own or a fork, and `AGENTS.md` says a carry inside an
   upstream file must be `#[cfg]`-gated. So: `survivors/coop.rs` (new file), `survivors/mod.rs`
   (already a fork file), `web/net.js` (fork file), and avoid touching `benilla-protocol` /
   `benilla-world` unless unavoidable.
4. **The "no dedicated server" promise.** WebRTC still needs *some* out-of-band exchange for
   the SDP/ICE blobs. Manual paste is genuinely server-free; a relay page is not a game
   server but is infrastructure. Decide explicitly rather than letting it creep in.
5. **NAT traversal.** Without STUN/TURN, WebRTC fails behind symmetric NATs. STUN is free
   and public; TURN is a relay (i.e. a server) and will be needed for a fraction of pairs.
   This is the honest limit of "no dedicated server" and should be stated to players.
6. **Sandbox limits for future work here**: 4 vCPU / 6 GiB. A Bevy workspace build is heavy;
   `cargo check` is feasible, a full `cargo build` of the wasm bundle likely is not.

### A documentation discrepancy worth fixing

`AGENTS.md` in this repo describes the **wenilla fork's** process: `crates/wenilla-realm`
(the realm service, `templates/play.html`, `realmctl`), `wenilla-realm/docs/RELEASE.md`,
`docs/UPSTREAM.md`, and `gh pr create -R Arnesen/wenilla`. **None of that exists here.**
This repo is `2boxtrickshot-droid/azeroth-survivors-re`, has no `wenilla-realm` crate, no
`docs/UPSTREAM.md`, and `web/boot.js` / `web/platform.js` still *reference*
`crates/wenilla-realm/templates/play.html` in comments (and
`crates/benilla-app/tests/web_assets.rs` asserts against that path). Anyone (or any agent)
following `AGENTS.md` literally will look for files and a PR target that are not here.

### Decisions taken (M0)

Settled by the project owner. §11 works out what each one costs.

1. **Host migration: none.** The run ends when the host quits or drops. Revisit later; it is
   complexity the first playable version does not need.
2. **Level-ups: per player.** Each player earns XP and picks their own upgrades, so one
   player's choice never interrupts the party. This is what forces the global
   `Time<Virtual>` pause out of `Phase::LevelUp` (§7.2 constraint 2).
3. **Invites: manual-paste join codes.** No signaling site in M0. The connection layer is
   shaped so a proper invite page can be added later without a rewrite (§11.3).
4. **Tank threat: a real threat table.** Enemies prioritise the tank once it has established
   threat, with sensible fallback when there is no tank. Proximity taunting is a tank
   *ability*, not the whole aggro system.
5. **Arena: a dedicated co-op arena.** Do not force co-op into the existing battlegrounds
   before their suitability is known; reuse existing maps, assets and systems where practical.
6. **Upstream: keep merging when practical, but not at the cost of the architecture.** Keep
   `benilla-app` changes modular, document intentional divergences, avoid wholesale
   refactoring, and resolve conflicts deliberately rather than blindly.
7. **Priority order:** prove connect → move → see each other → share enemy/combat state
   first. Then 3–5 players, then roles, then full co-op runs.
8. **Connectivity:** manual paste still needs a peer-to-peer path, and possibly a relay for
   restrictive routers. Chosen from this repo's actual setup in §11.3 — not assumed.

---

## 11. M0 decisions in detail

### 11.1 The revised sequence

The priority order in §10.7 (connect → move → see each other → share enemy/combat state,
*then* 3–5 players, *then* roles) reorders §9's milestones: roles stop being a prerequisite
for connecting and become a later step. The revised path:

| step | what | why here |
|---|---|---|
| **P1** | the connection layer (§11.3) | nothing else is provable without it |
| **P2** | the party refactor: `Run` → `SharedRun` + per-member `HeroRun`, `Hero` → `PartyMember` | required by *every* later step; no player-visible change |
| **P3** | two peers: move, face, see each other | the first thing worth showing anyone |
| **P4** | shared enemy and combat state, host-authoritative | the first thing worth *playing* |
| **P5** | 3–5 players | scale, once two are solid |
| **P6** | roles become mechanical: threat table (§11.4), ally-targeted heals, DPS scaling | needs P4's authority model to exist |
| **P7** | the co-op arena (§11.2), elites, party-scaled waves, shared boss HP | content on top of a working party |
| **P8** | loot and persistent progression | the roguelite meta layer |

Roles exist as **data** from P2 (the `Role` enum and `ClassDef::role` are in the tree now, and
the pick screen shows them), but they do not change behaviour until P6. That keeps P2 a pure
refactor.

### 11.2 The co-op arena

Per decision 5, co-op gets its own `MapDef` rather than a borrowed battleground, but it reuses
everything else. Concretely, as a new **last** entry in `data::MAPS`:

- a `coop_only: bool` field on `MapDef` (false for the existing sixteen, true for the arena),
  filtered out of the single-player zone list in `menu.rs` so **solo play is unchanged**;
- `map` and `center` taken from a **proven** entry (the Barrens' `[-950.0, -2700.0, 92.0]` is
  the safe start — `MAPS[0]` already stands there, so the ground is known good), to be moved
  to a purpose-chosen spot once someone can eyeball the terrain in a browser;
- its own `foes`/`bosses` ladders, which `ladder()` numbers off the Barrens tuning for free;
- a party-scaled wave clock (§P7), which is where the arena actually differs from a
  battleground: the spawner is tuned for N players, not one.

This is deliberately the *last* content step, because the arena's real content — packs that
need a tank to hold, elites that need a healer, waves that need DPS — cannot be designed
until roles are mechanical (P6).

### 11.3 Connectivity: the decision, and the evidence for it

The question was whether a join code is enough, or whether a relay/signaling service is
needed. **The code is not enough by itself, and the repo's existing relay cannot be it.**
Reading the actual setup:

| fact | where | consequence |
|---|---|---|
| A page cannot listen on a socket. | `benilla-protocol/src/transport/mod.rs` header | P2P must be WebRTC; a socket-based host is not available to a browser. |
| `wenilla-host`'s only network feature is `GET /ws/{port}`, an allowlist TCP proxy for **3724 and 8085 only**, dialing a fixed `--upstream`. | `wenilla-host/src/lib.rs` (`ALLOWED_PORTS`), `src/ws.rs` | It is not a message relay and cannot be repurposed without breaking its security boundary. |
| `wenilla-host` is documented as a **local development tool** that "must never be exposed on the open internet" — `/data` hands out the game files unauthenticated. | `wenilla-host/src/main.rs` doc + `--help` + the non-loopback warning | It cannot host co-op signaling, and it cannot be the peer everyone dials. |
| There is **no WebRTC anywhere**, and the wasm32 `web-sys` feature lists (`benilla-app`, `benilla-protocol`) stop at `Window`/`Location`/`Storage`/audio. | `Cargo.toml` of both crates; zero `RtcPeerConnection` hits | Owning WebRTC in Rust means widening a pinned dependency surface for something the page does natively. So: **JS owns the transport** (`web/net.js`), the wasm owns the game. |
| Cross-origin isolation is already on (`COOP: same-origin`, `COEP: require-corp`). | `wenilla-host/src/static_site.rs` | `crossOriginIsolated` is true. WebRTC does not need it, but COOP severs `window.opener` — so a future signaling page must be reached by `fetch`/WebSocket, **not** embedded in an iframe. |
| WebGPU requires a secure context (`localhost` or https). | `web/README.md` | Any hosted co-op page is https anyway, which WebRTC also wants. The two constraints agree. |
| wasm is single-threaded and event-loop driven; `std::time::Instant` panics there. | `docs/COOP-PLAN.md` §7.2(5), `benilla-app/Cargo.toml` | Signaling must be non-blocking; the once-a-frame `Reflect.get` idiom the bridge already uses is the pattern. |
| No `serde_json` in the shipped app; the bridge uses plain objects and `PlainValue`. | `webbridge/mod.rs` header; `serde_json` is dev-only | The wire format is plain objects now, hand-rolled binary later. |

**Decision:**

1. **Transport: WebRTC `RTCDataChannel`, one connection per pair, host-authoritative star.**
2. **Signaling: manual paste, non-trickle ICE.** The host waits for `icegatheringstate ===
   'complete'` before reading `localDescription`, so every candidate is already inside the
   SDP and **one blob each way is enough**. Trickle ICE would mean one paste per candidate —
   unusable. Implemented in `web/net.js` (`encodeCode`/`decodeCode`).
3. **STUN by default; TURN as a settings value.** Public STUN is address discovery, not a game
   server. **TURN is a relay and is infrastructure** — some pairs (symmetric NAT, strict
   corporate firewalls) cannot connect without it. M0 ships with `turn: []` and must *say so*
   in the lobby rather than hang; the field exists so a player or a future page can fill it.
4. **No hosting needed for M0.** Each peer runs its own local `wenilla-host` for its own wasm
   and game data; only gameplay state crosses the DataChannel. Assets stay local on both
   sides, which is why a peer-to-peer mesh is viable at all.
5. **The seam for a later signaling page is `Signal`.** `LocalSignal` (paste) is M0; a
   `RelaySignal(url)` posting/polling the same opaque blobs is a second implementation, not a
   refactor. Nothing else in `web/net.js` knows how a code travels.

**Stated plainly, because it is a real limit:** the join code is DTLS-encrypted but not
*authenticated* — whoever carries the blob between the two players could in principle
substitute their own. That is acceptable for playing with friends over a chat channel, and it
is the same trust model the paste itself implies. A signaling page should add a fingerprint
the players compare out of band; that is noted here so it is not forgotten.

**Not load-bearing, in the house posture:** the page imports `web/net.js` dynamically, every
entry point feature-detects, and every failure is swallowed. A browser with no WebRTC plays
single-player exactly as it does today. The wasm finds `window.__wenilla_net` or finds
nothing; the absent case costs one `Reflect.get` per frame, the same as the bridge's.

### 11.4 The threat table (P6)

Decision 4: a real threat table, with a proximity taunt as a tank *ability* rather than the
whole system. The shape that fits this codebase:

- **Where it lives:** one `Threat` resource, `HashMap<(Entity /*enemy*/, Entity /*member*/),
  f32>`. It is **host-side only** — a client never needs it, because it only renders whichever
  member the enemy is chasing. That keeps it out of the wire format entirely.
- **Generation:** damage dealt adds threat equal to the damage, scaled by a per-role
  multiplier (tank high, DPS low, healer a flat fraction of healing done so healing pulls
  aggro the way it does in the source game). The multiplier belongs next to `Role`, so it is
  one table to tune.
- **Selection:** `move_enemies` today does `hero.single()` and walks straight at it. It becomes
  `target_of(enemy, &party, &threat)`, which returns the highest-threat living member within
  range; **fallbacks in order:** nearest member if no threat has been generated yet, nearest
  member if there is no tank in the party, nearest member if the tank is dead. That satisfies
  "sensible fallback when the tank is absent or unavailable" without a special case per
  situation.
- **Taunt as an ability:** a new `Effect::Taunt` (or a `Kind`) that sets the caster's threat to
  the table's current maximum across the affected enemies — which is what a proximity taunt
  actually is. `Effect` already carries `Slow/Root/Stun/Fear/Weaken/Drain/Execute`, so this is
  one more arm and one more line in `apply_hits`.
- **Decay:** threat decays on the same timer as the existing `marks`/`dots` bookkeeping, so a
  tank that stops hitting things loses the pack — otherwise the table becomes a permanent
  leash and the DPS role stops mattering.

### 11.5 What is in the tree now, and what is next

Landed with this document:

- `crates/benilla-app/src/survivors/data.rs` — `Role { Tank, Healer, Dps }` with `label()`, a
  `role` field on `ClassDef`, and a role for all nine classes: Warrior/Paladin Tank,
  Priest/Druid Healer, Hunter/Rogue/Shaman/Mage/Warlock DPS. Solo play is unaffected; the
  field is data only.
- `crates/benilla-app/src/survivors/menu.rs` — the pick screen names the role, e.g.
  "Human Warrior — Tank". This is also what keeps the new enum used, so
  `cargo clippy --workspace --all-targets -- -D warnings` (`.github/workflows/ci.yml`) stays
  green.
- `web/net.js` — the connection layer: the join-code codec, the `LocalSignal` seam, the
  `Net` session (host/join/deliver, a reliable `ev` channel and an unreliable `snap` channel,
  `inbox`/`send`/`sendFast` for the wasm), `iceConfig` with STUN-by-default and a TURN field,
  and the guarded `window.__wenilla_net` handle.
- `web/tests/net.test.mjs` — 8 tests over the parts that are pure logic and decide whether a
  session can work at all: the codec round-trip, stale/wrong/garbage codes, the encoder
  refusing to emit what it could not read, the one-tank/one-healer party rule, ICE defaults,
  and the signal→session path. Run with `node --test web/tests/*.test.mjs`.
- `scripts/web-build.sh` — `web/net.js` added to the `cp` line. **This is load-bearing:** a
  page file that is not on that line never reaches `web/dist`, so never reaches the browser.
- `docs/COOP-PLAN.md` — this document.

Next, in the §11.1 order:

1. **P2, the party refactor.** The `Role` data is in place; now `Run` splits and `Hero` becomes
   `PartyMember`. This is the largest and least visible step, and it should land as its own
   change with single-player behaviour compared before and after (the `WOW_SURVIVORS_AUTO`
   autopilot makes that mechanical).
2. **P3.** `survivors/coop.rs` reads `window.__wenilla_net` once a frame (the `webbridge`
   idiom), sends the local input packet, and applies peer transforms to `PartyMember`
   entities spawned through the existing `units::spawn_unit` path. Plus the lobby UI: Host /
   Join, a textarea for the code, and the party's roles.
3. **P4.** Gate `spawn_enemies` / `move_enemies` / `apply_hits` on `is_host` and replicate.

Two things to do first, both cheap and both prerequisites for trusting any of it:

- **Establish the build baseline.** The wasm check
  (`cargo check --target wasm32-unknown-unknown -p wenilla --no-default-features --features webgpu`)
  is the CI gate and is runnable without game data; the native
  `cargo check --workspace --all-targets` needs `libasound2-dev`/`libudev-dev` and was **not**
  possible in the sandbox this was written in. Run both before P2.
- **Note the pre-existing web test failure.** `node --test web/tests/boot.test.mjs` fails 6/6
  in this sandbox on a pristine checkout (`git stash` → same result), so it is not caused by
  anything here. It is worth a look on a normal machine, since `.github/workflows/check.yml`
  runs it.

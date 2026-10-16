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

- **Manual copy/paste:** host generates an offer (SDP + ICE candidates, compressed into a
  base64 blob), sends it out of band (Discord), joiner pastes it and returns an answer
  blob. Zero infrastructure, works today, ugly but shippable for a first milestone.
- **A tiny "signaling relay" page**: a static HTML page on any static host with no game
  logic, whose only job is to swap two opaque blobs. This is not a game server and holds
  no game state. Acceptable if manual paste is too rough; note it in the doc so the "no
  dedicated server" rule stays honest.

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

### Open questions for the user

1. **Host migration?** If the host quits, does the run end (simplest, recommend for v1), or
   does another peer take over?
2. **Level-up: local or shared?** Per-player builds (each player picks their own cards,
   current `Run` model extended per member) vs a shared party card pool. Per-player is
   assumed above and is the stronger design.
3. **Invite mechanism:** manual paste, or a signaling relay page? This decides whether
   anything at all is deployed.
4. **Tank aggro model:** a real threat table (WoW-like, more work, more depth) or a
   proximity/taunt flag (cheap, readable on screen)?
5. **Roster/scale:** is the goal 3–5 players in one of the existing 16 battlegrounds, or a
   new purpose-built co-op arena?
6. **Upstream relationship:** keep merging `benilla` upstream into this fork (the
   `AGENTS.md`/`docs/UPSTREAM.md` discipline), or freeze the engine and treat this as a
   game on top? This changes how aggressively we may refactor `benilla-app` internals.

# Private co-op: Elwynn Watch

> For website-only play without player-side launchers, see [BROWSER-COOP.md](BROWSER-COOP.md). The local-client instructions below remain available.

## Play in the original 3D world

Co-op uses **the existing Bevy 0.18.1 renderer**, original animated character/enemy models, Elwynn terrain, unit dressing, original spell kits and the top-down survivors camera. The host simulation, party/chat UI and transport are independent of presentation. The earlier flat arena is retained only as an explicit developer diagnostic (`?view=debug2d`); it is not the default game or the delivered visual direction.

Requirements on **each player's PC**: Node.js 22+, recent desktop Chrome or Edge with working WebGPU/hardware acceleration, a keyboard, and a WoW **1.12.1 Data folder**. Each player runs a local asset reader. Game data is read locally and is never included in source/build archives or served by the public party port. The host computer must remain awake.

### Build from source

```bash
# Once: install the Rust toolchain declared in rust-toolchain.toml.
bash scripts/web-setup.sh
bash scripts/coop-build.sh
bash scripts/web-build.sh
cargo build --release -p wenilla-host

# Host: local 3D asset server plus the private party router
node scripts/coop/play.mjs /absolute/path/to/WoW/Data --host

# Every friend: their own local 3D asset server
node scripts/coop/play.mjs /absolute/path/to/WoW/Data
```

Use quotes around paths containing spaces. No WoW account, realm server or public matchmaking is needed. The existing `scripts/fetch-data.sh` setup helper is preserved; alternatively supply your own Data folder as above.

### Launch an assembled build

Use the same `node scripts/coop/play.mjs ...` commands. A build must include `web/dist/`, `web/dist/coop/pkg/`, the locked `ws` dependency and a compatible local data-host executable. A **Windows x64** package with bundled Node and launchers is available; see [WINDOWS-COOP.md](WINDOWS-COOP.md). macOS users must build `wenilla-host` on their platform with Cargo. The browser bundle itself is platform independent. See the delivered launch guide for archive contents and observed verification.

Open the **HOST ONLY** link printed by the host terminal. Choose a name and specialization, then **Host party**. In the lobby, enter the **party server's reachable address** and copy the guest invite. Each friend starts their local client, opens that invite (or pastes it into **Join party**), and chooses a name/build. The invite opens `http://127.0.0.1:8090/coop/` on **that friend's PC**; its fragment identifies the remote party server and guest capability. It is not an invitation to connect to the host's private asset reader.

The original 3D renderer loads in a same-origin iframe during the lobby. Its session uses windowed mode, the page’s current size, and the original 177-yard view-distance option, which covers the bounded co-op arena without loading the solo mode’s distant landscape. Solo display settings are not overwritten. Terrain and character-model readiness are reported separately by every client; **Begin the run** unlocks when everyone is ready. Loading trouble stays visible in the lobby, with no automatic flat-renderer fallback. Maximum: one host and four guests. Solo hosting works too.

Never share the HOST ONLY link: it authorizes the simulation host. Guest invites carry a random 192-bit capability in the URL fragment. Restarting the server invalidates all links; ending the host session rotates the guest invite. There is one party per process. The default port is 8787 (`COOP_PORT` overrides it); `COOP_BIND=127.0.0.1` confines a test to your computer.

### Controls and progression

- WASD / arrows: move. Attacks automatically target nearby enemies.
- F: the specialization's active ability (30 resource; 12-second cooldown).
- Enter: focus chat. Send with Enter; Escape releases focus. Typing does not move or cast.
- Click level-up choices while the world continues. Six repeatable upgrade tracks, eight ranks each; XP gems can be collected once **by each player**.
- Choose a tier 1 talent in the lobby or during play. Tier 2 requires level 5 and tier 1. Each tier has two mutually exclusive choices, reset between runs.
- Stay within 3.5 yards of a fallen ally for four seconds to revive them. A complete party wipe ends the run.
- Bosses arrive at 1:30, 3:15 and 5:00. Leave the orange circles before impact. Victory requires at least six minutes **and** all three bosses dead.
- The host can return everyone to the lobby after victory or defeat. New players join only in the lobby. A disconnected guest can rejoin there; there is no mid-run reconnect, save restoration or host migration.

| Build | Role | Automatic action | F |
| --- | --- | --- | --- |
| Warrior / Protection | Tank | Cleave, 4× damage threat, 35% mitigation | Area taunt for 4s, +40% mitigation for 5s |
| Warrior / Fury | Melee DPS | Six-target cleave | Whirlwind |
| Shaman / Restoration | Healer | Lightning plus Healing Wave on the most injured nearby ally | Party Chain Heal and shields |
| Shaman / Elemental | Ranged DPS | Chain Lightning | Thunderstorm |
| Shaman / Enhancement | Melee DPS | Three-target weapon strikes | Stormstrike area burst |
| Mage / Frost | Ranged DPS / control | Frostbolt and slow | Frost Nova with 4s slow |

Other classes, pets, extensive class-specific talent trees, persistent character progression and the full solo ability catalogue are not implemented in co-op. The first roster deliberately covers all three roles with a smaller working set. The two talent tiers currently share their mechanical branches across builds; their trade-offs are damage/healing versus mitigation, then attack power versus active cooldown.

## Internet connections and $0 recurring cost

**No hosted signaling, matchmaking, STUN, TURN, database, public account system or commercial multiplayer SDK is used.** There is no multiplayer subscription or hosting bill. Existing computer, electricity and internet access are prerequisites. There are no optional paid integrations in this implementation.

The connection mechanism is a direct **WebSocket connection to the host's PC**, where a small Node process routes messages. Each browser obtains its 3D assets from its own loopback-only data host. The host browser's Rust/WASM simulation is authoritative; the Node process does not simulate combat. This is a host-and-clients topology, not a WebRTC mesh. WebSocket uses TCP and a congested connection can introduce head-of-line delay.

WebRTC was considered: a short join code still needs signaling, and some NAT combinations need a TURN relay. A public free signaling/relay provider would introduce availability and usage-limit dependencies. This initial transport instead accepts the one-time host networking setup requested by this project and has no provider terms or free-tier quotas to depend on.

### Reach the host

1. Give the host computer a stable LAN address (a DHCP reservation is sufficient).
2. Permit incoming TCP 8787 in the host firewall and forward that TCP port on the router to the host computer. Do **not** forward the original benilla data server (8090), WoW server ports, or any other port.
3. Use the host's public address in the lobby, e.g. `https://203.0.113.10:8787/` (the example IP is a documentation address; substitute yours). Friends use the generated guest invite.
4. Test with one friend on another internet connection first. A localhost test or two computers behind one router does not establish that forwarding works. Some routers do not support joining your own public address from inside the LAN; the host can keep using its local host link.

For an encrypted internet session configure TLS before inviting friends:

```bash
COOP_TLS_CERT=/absolute/path/to/cert.pem \
COOP_TLS_KEY=/absolute/path/to/key.pem \
node scripts/coop/server.mjs
```

A certificate can be obtained without a paid service. If you already control a hostname, use a free certificate from your preferred ACME issuer. A private self-signed certificate also has $0 cost, but each friend must explicitly trust the verified certificate on their computer before WSS can connect. Never send the private key. For a private certificate with OpenSSL (substitute your actual IP, keep keys outside the repository):

```bash
openssl req -x509 -newkey rsa:3072 -sha256 -days 365 -nodes \
  -keyout party-key.pem -out party-cert.pem -subj '/CN=Private Azeroth party' \
  -addext 'subjectAltName=IP:203.0.113.10,DNS:localhost,IP:127.0.0.1'
```

Verify the certificate fingerprint with your friends through your existing private chat, then install trust using their operating system's certificate instructions. HTTPS pages require `wss://` connections. Plain HTTP/WS works for a trusted LAN or an already encrypted private network but does not encrypt the invite, chat or gameplay on its own.

### Networks that cannot accept incoming connections

Router forwarding cannot bypass ISP **CGNAT** or an upstream firewall. A reachable global IPv6 address with the corresponding firewall rule and `COOP_BIND=::` can work, without IPv4 forwarding; write IPv6 URLs with square brackets. Otherwise all players need an existing private network/VPN that can connect their PCs, or a friend with a reachable connection must host. Self-managed WireGuard has no subscription cost but still needs at least one reachable endpoint. There is no bundled VPN or mandatory paid relay. If none of your networks can accept connections and you have no functioning private network, this transport cannot establish the session; a join code does not fix that limitation.

## Original WoW / Bevy presentation

The wasm-gated `survivors/coop.rs` plugin is selected by the embedded renderer's `?coop=1`. It replaces the solo simulation systems with a snapshot presenter while retaining benilla's MPQ/DBC/M2/ADT readers, unit/model dressing, animation, terrain, original spell visual pipeline, survivors color grade and daylight. The solo entry at `/` still runs the existing game.

The adapter interpolates authoritative transforms and uses terrain height for placement, drives movement/death animation, projects nameplates from the actual 3D camera, and draws boss telegraphs in the world. It reuses XP wisp models and original lightning, frost, healing and melee spell kits. Combat authority remains in the host worker; a rendering stall does not make a guest an authority. Original terrain obstacles are visual scenery: the co-op simulation currently uses bounded X/Z movement, without authoritative tree/building collision. Full solo ability, animation and terrain-physics parity is not implemented.

The local asset reader must stay on loopback. Only the party router (8787 by default) is reachable by friends. The launcher binds the data reader explicitly to `127.0.0.1:8090`; do not forward this port.

## Architecture and upstream compatibility

Repository assessment:

- Rust 1.98.1, Cargo workspace, Bevy 0.18.1; `wenilla` is the browser entry point, `warcraft-survivors` the native solo launcher. Lua and original MPQ/DBC/M2/ADT readers provide the WoW client presentation.
- `survivors/mod.rs` registered a singleton `Run`, singleton `Hero`, and global phases. `hero.rs` handles WASD/camera; `enemies.rs` handles continuous spawning, chasing, contact damage and gems; `abilities.rs` handles autonomous spells, effects and hits; `hud.rs`, `cards.rs` and `menu.rs` handle selection and paused level-ups. `data.rs` contains nine class identities, spell tables, sixteen battlegrounds and tuned progression.
- Existing `benilla-protocol` networking speaks WoW 1.12 authentication/world packets to a WoW server. `wenilla-host` relays those streams; neither supplied a peer-hosted survivors simulation.
- Replacing singleton assumptions throughout the solo mode would create a large upstream carry. `azeroth-coop` instead imports the existing pure content table and supplies party-owned state, fixed-step rules and serde snapshots. The original renderer attaches to those snapshots through the new `survivors/coop.rs` file. The sole plugin switch is wasm-gated. Solo logic is preserved.
- Upstream `samwhosung/benilla` and the `Arnesen/wenilla` browser carries retain their history. No ancestry was rewritten and no upstream merge was attempted. Upstream updates still use real merges as described in `UPSTREAM.md`.

New modules:

- `crates/azeroth-coop`: deterministic fixed-step simulation, threat, abilities, progression, bosses, tests, WASM bindings.
- `web/coop/session.js`: worker-owned host simulation and real WebSocket transport.
- `web/coop/app.js`: connection/menu/party/chat/progression UI; remote state is rendered, never simulated by guests.
- `web/coop/presentation.js`: projected nameplates with overlap avoidance; the old procedural networking diagnostic is explicit opt-in only.
- `scripts/coop/server.mjs`: one-party host-PC connection router; bounded frames, rate limits, backpressure, membership, safe text chat and heartbeats.
- `crates/benilla-app/src/survivors/coop.rs`: default existing-engine 3D presentation.
- `scripts/coop/play.mjs`: starts each player’s loopback asset server and, for the host, the party router.

Simulation runs at 30Hz. Full authoritative snapshots are sent at up to 10Hz, with WebSocket deflate compression and latest-frame dropping when a peer falls behind. Enemies are capped at 220 plus scheduled bosses; gems at 180 and effects at 80. Threat tables stay private to the host; authoritative target IDs are in snapshots. Movement interpolation smooths displays; client prediction is not implemented. Input expires after 0.5s. Host snapshot silence ends the session after 15s; guests detect silence after 10s. Browser/OS suspension can still terminate a run; host migration is intentionally absent.

The host is trusted. Guests cannot submit health, positions, damage, XP, other player IDs, or snapshots. Unauthenticated peers have a short handshake timeout, all messages have size/rate bounds, and chat is rendered as text. The public listener serves only the co-op directory, never `/data` or repository files.

## Development checks

```bash
cargo test -p azeroth-coop -- --nocapture
cargo clippy -p azeroth-coop --all-targets -- -D warnings
npm test --prefix scripts/coop
npm audit --prefix scripts/coop --omit=dev
node --test web/tests/*.test.mjs
scripts/coop-build.sh
WASI_SDK="$PWD/tools/wasi-sdk" cargo check --target wasm32-unknown-unknown -p wenilla --no-default-features --features webgpu
scripts/check.sh
```

The deterministic run test drives five roles through real movement, talent, upgrade and active-ability commands, with no HP/invulnerability shortcut. It is a repeatable simulation and bounds check, not a human balance test or a separate-network test. See the delivered launch guide for observed build/test results and remaining limitations. Separate-internet routing, hardware-GPU performance and human party balance require testing on the friends’ own computers.

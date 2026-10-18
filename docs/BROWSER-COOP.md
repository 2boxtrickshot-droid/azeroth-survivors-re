# Play Azeroth Survivors co-op from a website

## For players

Open the site's **`/coop/`** page in a recent desktop Chrome or Edge with hardware
acceleration and WebGPU. You need your own complete **WoW 1.12.1 (build 5875) Data
folder**. No Windows package, Node, command prompt, game account or realm is needed
on a player's computer.

1. Choose your Data folder in the page. Wait for **local archives ready**.
2. Choose a name and build. One player clicks **Host Game** (and supplies the website
   owner's host access code if configured).
3. Copy the guest invite from the lobby. Friends open that same website, select
   their own Data folder, choose a build and click **Join Game**.
4. Wait for every player's original 3D terrain and models to load. Host clicks
   **Begin the run**. Cold loading can take minutes on a software GPU.
5. WASD/arrows move; attacks are automatic; F uses your build ability; Enter opens
   chat. Click level-up choices without pausing the party. Stay near a fallen ally
   for four seconds to revive them.

Bosses arrive at 90, 195 and 300 seconds. Victory requires six minutes and all three
bosses defeated. A wipe ends the run. The host can return the party to the lobby
and replay. Closing the host browser ends the session. New players join only in
lobbies; no host migration or mid-run reconnect restoration is provided.

Select Data again after refreshing or reopening the website. Archives are read
locally, not uploaded, copied into browser storage or redistributed. The chooser's
browser UI may use the word “upload”; the application passes the selected File
objects only to a local worker. Keep the folder available throughout play.

Expected archives: `dbc.MPQ`, `speech.MPQ`, `fonts.MPQ`, `interface.MPQ`, `misc.MPQ`,
`sound.MPQ`, `wmo.MPQ`, `terrain.MPQ`, `texture.MPQ`, `model.MPQ`, plus the installation's
`patch.MPQ`, single-character `patch-?.MPQ` archives and `speech2.MPQ` when present.
Modern Classic/retail CASC files are incompatible. A successful archive probe checks
Map.dbc; it does not certify every asset in a modified or damaged installation.

## What the website operator runs

There are two distinct roles:

- **Party host:** a player whose browser runs the existing authoritative Rust/WASM
  simulation. Guests send input; the host produces world snapshots.
- **Website operator:** runs one small Node HTTP/WebSocket process on a reachable
  machine. It serves asset-free code and routes messages. It never reads players'
  WoW data and does not run the game simulation.

This release supports one private party of up to five players per website process.
A browser cannot accept a WebSocket listener itself. Keeping the existing router
avoids a new signaling protocol, public STUN/TURN dependency and a new multiplayer
stack. It is direct client-to-operator WebSocket transport, not WebRTC peer-to-peer.

### Cost and hosting choices

**No paid multiplayer service, account provider, subscription, signaling provider,
or relay vendor is required.** The supported $0-service-fee deployment is on an
existing computer with an existing internet connection and reachable address.
The operator provides uptime, TLS and firewall/router configuration. Electricity,
hardware and internet access are prerequisites. CGNAT can prevent inbound access;
use a reachable machine or an already functioning private network.

A free cloud/container tier can run the same process only if it supports persistent
WebSockets, the artifact size and traffic volume. Such tiers can sleep, disconnect
sessions, impose bandwidth/usage caps or change terms. No particular vendor is
selected, provisioned or claimed to be a permanently free compatible host here.
Static-only hosting cannot run this router. GitHub Pages alone is insufficient:
this release also needs the isolation headers below. There is no mandatory paid
fallback if a host is unreachable.

## Test the built website locally (operator/developer only)

Extract the browser deployment ZIP. Install Node 22+ on the **operator's** machine;
the archive already includes the pinned `ws` JavaScript dependency.

```bash
node scripts/coop/website.mjs
```

Open **http://127.0.0.1:8080/coop/**. Select your own Data folder. A second tab can
join using the generated invite and its own folder selection. This tests two
clients on one machine, not two physical computers or internet reachability.
No `wenilla-host`, WoW server or local `/data` server should run for this test.
The site's `/data/...` URLs intentionally return 404 outside the browser bridge.

## Deploy for friends

The default listener is loopback. For direct HTTPS deployment, provide PEM
certificate/key paths and bind on the intended interface, e.g. on Linux:

```bash
COOP_BIND=0.0.0.0 PORT=8443 \
COOP_TLS_CERT=/private/party-cert.pem COOP_TLS_KEY=/private/party-key.pem \
COOP_ORIGIN=https://YOUR-HOST:8443 COOP_SITE_KEY='your-long-private-host-code' \
node scripts/coop/website.mjs
```

Use an actual reachable hostname/IP and a certificate trusted by each browser;
include the port in COOP_ORIGIN when non-default. A free certificate for an existing
hostname or an explicitly trusted private certificate avoids a mandatory paid
certificate. Never send friends the private key. Certificate issuance/trust and WAN
routing are not configured automatically or verified by the local tests.
Forward/allow only the selected **website TCP port** (8443 in that example), not
8090, 8787 or WoW realm ports. HTTP outside localhost is not sufficient for WebGPU,
service workers or the shared-memory data bridge.

Alternatively terminate HTTPS at an existing reverse proxy and run the process on
loopback. Set **COOP_ORIGIN** to the exact external HTTPS origin. Proxy all paths,
including `/party`, to the process and preserve WebSocket Upgrade/Connection.
Use a sufficiently long WebSocket idle timeout. Do not strip these response headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The application sends them on every website response, along with CSP and MIME
headers. Serve the entire bundle from the same origin at the site root; deployment
under a subdirectory or inside a cross-origin iframe is not supported. No external
asset CDN is necessary. `.br`/`.gz` siblings reduce the renderer transfer size. The compact ZIP omits
redundant compressed copies; the operator process generates a Brotli renderer copy
on first startup when its folder is writable, falling back to the raw bundle otherwise.

Example environment values (configuration, not a shell-specific launcher):

```text
COOP_BIND=127.0.0.1
PORT=8080
COOP_ORIGIN=https://game.example.com
COOP_SITE_KEY=replace-with-a-long-private-host-code
```

Only host creation uses the optional access code. Friends need the guest invite,
which carries a random capability in its URL fragment. An active party prevents a
second host. Unused host reservations expire after 15 seconds. Restarting the
website process invalidates existing invites and ends its session.

## Rebuild reproducibly

Close running game/browser instances before a memory-constrained build; the WASM
binding step can require several GiB of free RAM. Use the repository's Rust toolchain
(1.98.1), Node/npm, and the setup script's pinned
wasm-bindgen, WASI SDK and Binaryen. On Linux/WSL2 from the source checkout:

```bash
bash scripts/web-setup.sh
CARGO_BUILD_JOBS=1 CARGO_PROFILE_RELEASE_OPT_LEVEL=1 bash scripts/browser-build.sh
node scripts/coop/website.mjs
python3 scripts/coop/package-browser.py /path/to/output
```

`browser-build.sh` builds the existing host simulation, the small local MPQ adapter,
and the complete original Bevy/WebGPU renderer. `web/dist` is the production
website. `package-browser.py` produces the deployment ZIP and complete modified
source ZIP, excludes WoW data and includes licenses and the locked router dependency.
No native game executable is part of this browser delivery.

Tests:

```bash
cargo test -p benilla-mpq
cargo test -p azeroth-coop -- --nocapture
cargo clippy --target wasm32-unknown-unknown -p azeroth-data -- -D warnings
npm test --prefix scripts/coop
node --test scripts/coop/data-order.test.mjs
bash scripts/check.sh
```

See the delivered browser-test-results.md for actual passes, earlier failures,
reused simulation results and unverified physical-PC/WAN tests. Commands here are
instructions, not a claim that every repository-wide gate passes.

## Implementation and upstream boundaries

The original renderer, terrain/model formats, camera, animation and spells remain.
The existing host worker, rules, six builds, progression, nameplates, party health
and chat remain. The diagnostic flat renderer is not the website's normal mode.

`azeroth-data` exposes the original `benilla-mpq::Archive`; a feature-gated file
adapter reads selected File slices through FileReaderSync in a dedicated worker.
The native parser and its default native File path remain unchanged. Archive mount
order follows `benilla-formats::Chain`, including patch overrides/delete markers.
Only file handles and small read windows are held; the entire multi-GB installation
is not loaded into WASM memory.

Asynchronous renderer reads use a service worker and a per-tab BroadcastChannel.
A complete archive filename index is not exposed; the original Chain uses accurate
per-name existence probes instead. The underlying, unused macro-icon chooser can
log an empty-index warning; it is not part of the co-op UI.
Upstream synchronous XHR bypasses service workers, so `local-data-xhr.js` adapts
only that explicitly selected local-data session to a shared-memory worker read.
The parser still runs off the render thread; the synchronous caller must wait,
with a 10-second failure deadline and a 128 MiB per-asset buffer limit. Initial
loading remains blocking in places, as it was with synchronous HTTP reads. This
requires cross-origin isolation and can cause loading stalls; it is not a rewrite
of the upstream renderer into an asynchronous engine.

Known inherited gaps: authoritative collision with trees/buildings, full solo
victory balance, more classes/pets/talent trees, host migration and mid-run
restoration. No additional gameplay features were added for this delivery.

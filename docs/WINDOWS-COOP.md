# Azeroth Survivors co-op — Windows x64

## Install the packaged build

Requires Windows 10/11 x64, a recent Chrome or Edge with hardware acceleration/WebGPU,
and your own complete WoW **1.12.1 (build 5875)** `Data` folder on every PC.
This is the original Rust/Bevy 3D renderer compiled to WebGPU/WASM, with a Windows
asset-reader executable and bundled Node runtime. It opens in your browser; it is
not a native DirectX standalone game. No Rust, npm, WoW account or realm is needed to play.

Download **every Windows part** and `Install-Azeroth.cmd` into the same folder.
Double-click `Install-Azeroth.cmd`. It verifies SHA-256 checksums, joins the parts and
extracts the game into `Azeroth-Coop-Windows` beside them. No administrator access or
downloads during installation. Parts exist because each downloadable file is limited
to 25 MB. Do not extract or rename the individual parts. Installation refuses to
replace an existing game directory; choose a fresh folder for an update.

1. Double-click **Host.cmd** to play solo or host friends.
2. On first launch, paste the path to your WoW `Data` folder, e.g. `C:\Games\WoW 1.12.1\Data`.
3. Open the printed HOST ONLY link in Chrome or Edge if your default browser is unsuitable.
4. Choose a name/build, click Host party, wait for 3D readiness, then Begin the run.
5. Keep the terminal and host browser open. Closing the host ends everyone's run.

**Join.cmd** starts a friend's local asset reader and opens the join menu. Paste the
host's guest invite there. **Configure.cmd** changes the saved data path and then
starts hosting. Settings live in `benilla-config/coop.json` beside the game:

```json
{ "data": "C:\\Games\\WoW 1.12.1\\Data" }
```

Do not run two launchers on the same PC: the local asset port is 8090. For support,
keep the terminal error text. A missing WebGPU adapter requires checking browser
hardware acceleration and GPU drivers. An incomplete patch chain can cause missing
terrain/models; the launcher checking the folder exists does not certify its contents.

## Game data — not included

Supply the **complete** original 1.12.1 Data directory, including the base archives:
`dbc.MPQ`, `speech.MPQ`, `fonts.MPQ`, `interface.MPQ`, `misc.MPQ`, `sound.MPQ`,
`wmo.MPQ`, `terrain.MPQ`, `texture.MPQ`, `model.MPQ`, and your installation's
`patch.MPQ`, `patch-2.MPQ`/other patch archives and `speech2.MPQ` if present.
The reader applies the original patch order. Modern Classic/retail CASC data is
incompatible. No game data is downloaded, redistributed or written by this package.
Each friend's own reader stays on **127.0.0.1:8090**; never forward that port.

## Host and friend setup ($0 multiplayer service fees)

First test two PCs on your LAN. Host runs Host.cmd; friend runs Join.cmd. In the host
lobby set the server address to `http://HOST-LAN-IP:8787/` and copy the **guest** invite.
Allow incoming TCP 8787 for the bundled Node executable in Windows Firewall on the
network you intend to use. Never share the HOST ONLY link.

For separate internet connections, the host needs a reachable public address and
router TCP **8787** forwarding to the host's LAN IP, plus the firewall rule. Use the
public address in the lobby. There is no automated NAT traversal, hosted signaling,
paid relay, matchmaking or dedicated simulation server. The host browser simulates;
the bundled router transports messages. CGNAT can block this setup. A different
reachable friend can host, or use an already working private VPN. No VPN is bundled
or required when direct routing works. A join link alone cannot bypass CGNAT.

Plain WS is appropriate only on a trusted LAN or encrypted private network. For
public internet play, configure TLS with a certificate trusted by every friend's
browser, then launch from Command Prompt:

```bat
set "COOP_TLS_CERT=C:\PrivateParty\party-cert.pem"
set "COOP_TLS_KEY=C:\PrivateParty\party-key.pem"
Host.cmd
```

Use `https://YOUR-PUBLIC-HOST:8787/` in the lobby. A free ACME certificate works for a
hostname you control, or a private certificate can be explicitly trusted after
verifying its fingerprint. Include localhost and the public hostname/IP in its SAN
because the host uses localhost. Never share the private key. See [COOP.md](COOP.md)
for certificate examples, IPv6 and CGNAT limitations. No paid service is introduced.

## Controls and a full run

WASD/arrows move; attacks are automatic. F activates your build ability. Enter opens
chat; Escape releases text focus. Click talent and level-up choices while playing.
Names/health appear above players and in the party panel. Revive by staying near a
fallen ally for four seconds. Bosses spawn at 90, 195 and 300 seconds. Avoid orange
telegraphs. Win by surviving six minutes **and** killing all three bosses. A wipe
ends the run; the host can return everyone to the lobby and replay.

## Build from source

The delivered browser bundle is the compiled original 3D game. To rebuild just its
Windows asset reader on Windows, install Rust (the repository pins 1.98.1) and Visual
Studio Build Tools with Desktop development with C++, then from the source root:

```bat
cargo build --locked --release --target x86_64-pc-windows-msvc -p wenilla-host
copy target\x86_64-pc-windows-msvc\release\wenilla-host.exe C:\PATH\TO\GAME\bin\win32-x64\wenilla-host.exe
```

To rebuild the entire package, use Linux/WSL2 with Rust, Python 3, Node 22+, npm and
MinGW-w64 (`x86_64-w64-mingw32-gcc`). On Ubuntu install the latter with
`sudo apt-get install gcc-mingw-w64-x86-64`. From the repository:

```bash
bash scripts/web-setup.sh
bash scripts/coop-build.sh
CARGO_BUILD_JOBS=1 CARGO_PROFILE_RELEASE_OPT_LEVEL=1 bash scripts/web-build.sh
rustup target add x86_64-pc-windows-gnu
CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc \
  CARGO_BUILD_JOBS=2 cargo build --locked --release --target x86_64-pc-windows-gnu -p wenilla-host
python3 scripts/coop/package-windows.py /path/to/output
```

The packager fetches pinned Node 24.14.1 for Windows and verifies its upstream SHA-256.
It includes licenses, the locked `ws` runtime, both WASM modules, Windows executables,
launchers and a separate complete source archive. The MinGW build and archive checks
were run on Linux; MSVC commands above are provided for Windows and were **not** run here.

## Windows acceptance checklist — run on each PC

1. Run installer, then Host.cmd; confirm no missing-DLL error and terrain/models load.
2. Play solo through a boss and victory/defeat; choose upgrades, then replay.
3. On PC B run Join.cmd. Confirm both names/health bars and movement on both screens.
4. Send a distinct message from A to B and B to A. Typing must not move or cast.
5. Fight together: compare enemy deaths, party HP, XP and boss completion. Let one
   player fall, revive them, then test guest leave and host close.
6. Repeat from a different internet connection using the public guest invite.

See the accompanying `windows-test-results.md` for actual results. These checklist
steps are instructions, not claims that Windows or WAN testing passed.

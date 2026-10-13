<div align="center">

# Azeroth Survivors

**A top-down survivors roguelite running on a from-scratch
[World of Warcraft](https://worldofwarcraft.com) 1.12.1 client engine — Rust + [Bevy](https://bevy.org).**

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20%2F%20Apache--2.0-blue.svg)](LICENSE-MIT)

</div>

Pick a class and a battleground, then survive the run: WASD to move, your abilities cast
themselves, enemies swarm in waves, you level up and pick upgrades, and a boss shows up every
couple of minutes. **No server, no login, no account** — the mode is offline and self-contained.

> **You supply the game data.** This repository ships *zero* Blizzard content. It pulls a
> WoW 1.12.1 client's `Data` folder from [archive.org](https://archive.org) at setup time and
> reads it locally. See [The game data](#the-game-data-not-in-this-repo).

## Features

- **Authentic WoW 1.12.1 look and feel** — real models, animations, spells, and terrain, drawn by
  a from-scratch client engine rather than the original binary.
- **Survivors loop** — choose a class, auto-cast abilities (with a radial cooldown sweep), jump,
  and dodge a mounting swarm.
- **Two targets** — play in the browser (WebAssembly) or as a native desktop app.
- **Fully offline** — no login, no account, no reachable server.

## Play it

```bash
git clone https://github.com/OutThisLife/azeroth-survivors-re
cd azeroth-survivors-re
./scripts/setup.sh        # fetch game data + install toolchain + build the wasm (~5.5 GB download)
cargo run --release -p wenilla-host -- --www web/dist --data wow-data/Data
# → open http://127.0.0.1:8090/
```

`setup.sh` chains three re-runnable scripts, each skipping what's already done:

| Script | What it does |
| --- | --- |
| `scripts/fetch-data.sh` | downloads the WoW 1.12.1 client and extracts its MPQs |
| `scripts/web-setup.sh` | installs the wasm toolchain (wasi-sdk, wasm-bindgen, binaryen) |
| `scripts/web-build.sh` | builds the client into `web/dist/` |

**Prerequisites:** [Rust](https://rustup.rs/), `curl`, `unzip`.

## Controls

See [CONTROLS.md](CONTROLS.md). The short version: **WASD** to move, **Space** to jump, the
**mouse wheel** to zoom, **Esc** to pause, **1/2/3** to pick a level-up card. The camera is a
fixed-angle top-down chase cam.

## The game data (not in this repo)

This repo ships **no Blizzard content** — no art, models, sounds, maps, MPQ contents, or
FrameXML. The game reads a WoW 1.12.1 client's `Data` folder at runtime, which you supply.

`scripts/fetch-data.sh` automates that: it downloads the **English WoW 1.12.1 (build 5875)**
client from [archive.org](https://archive.org/details/WoW_1.12.1-5875) (~5.5 GB) and extracts the
MPQs into `wow-data/Data/` (git-ignored, resumable, skipped when already present). Or point at a
client you already have with `--data` / `WOW_DATA`.

## How it's built

The survivors mode is `crates/benilla-app/src/survivors/` plus the `warcraft-survivors` launcher
crate. It rides on two upstream projects:

- [benilla](https://github.com/samwhosung/benilla) — a from-scratch WoW 1.12.1 client.
- [wenilla](https://github.com/Arnesen/wenilla) — benilla compiled to WebAssembly, with a local
  host and realm service.

Everything else in this repository is that engine (formats, world streaming, models, UI), which
the survivors mode is built on.

## Legal

Azeroth Survivors is an independent fan project, not affiliated with or endorsed by Blizzard
Entertainment. It ships no Blizzard content. World of Warcraft is a trademark of Blizzard
Entertainment, Inc. Our code is licensed under [MIT](LICENSE-MIT) or
[Apache 2.0](LICENSE-APACHE), at your option; the vendored components under `third_party/` keep
their own upstream licenses.

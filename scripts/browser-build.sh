#!/usr/bin/env bash
# Build the original 3D game, host rules, and local MPQ worker into web/dist.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/coop-build.sh
cargo build --locked --release --target wasm32-unknown-unknown -p azeroth-data
wasm-bindgen --target web --out-dir web/coop/data-pkg "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/azeroth_data.wasm"
bash scripts/web-build.sh

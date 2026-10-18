#!/usr/bin/env bash
# Asset-free arena + host simulation; the full benilla renderer remains scripts/web-build.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --release --target wasm32-unknown-unknown -p azeroth-coop
want=$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/[" ]/, ""); sub("version=", ""); print; exit}' Cargo.lock)
have=$(wasm-bindgen --version | awk '{print $2}')
[ "$have" = "$want" ] || { echo "wasm-bindgen CLI must match $want (found $have)" >&2; exit 1; }
wasm-bindgen --target web --out-dir web/coop/pkg "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/azeroth_coop.wasm"
npm ci --prefix scripts/coop --ignore-scripts

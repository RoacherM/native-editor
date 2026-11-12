#!/bin/sh
# Rebuilds the vendored terminal runtime: installs the pinned xterm packages in
# vendor/xterm, bundles page.mjs into ONE minified IIFE, then writes
# src/xtermVendor.generated.ts, vendor/xterm/dist/build.json and
# vendor/xterm/THIRD_PARTY_NOTICES.txt. Reproducible (same inputs, same bytes).
# Needs bun. Run after changing vendor/xterm/{page,build}.mjs or package.json.
set -eu
cd "$(dirname "$0")/.."

cd vendor/xterm
bun install --frozen-lockfile
mkdir -p dist
bun build page.mjs --outfile dist/xterm-runtime.js --format iife --minify --target browser
bun build.mjs

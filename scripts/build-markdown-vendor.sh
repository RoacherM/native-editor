#!/bin/sh
# Rebuilds the vendored Markdown runtime: installs pinned deps in
# vendor/markdown, bundles page.mjs + entry.mjs into ONE minified IIFE, then
# writes src/markdownVendor.generated.ts and THIRD_PARTY_NOTICES.txt.
# Needs bun. Run after changing vendor/markdown/{entry,page}.mjs or package.json.
set -eu
cd "$(dirname "$0")/.."

cd vendor/markdown
bun install --frozen-lockfile
mkdir -p dist
bun build page.mjs --outfile dist/markdown-runtime.js --format iife --minify --target browser
node build.mjs

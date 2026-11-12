#!/bin/sh
# Fetches the pinned libghostty-vt release (the official static library and
# headers) into vendor/ghostty-vt/, checked against its SHA-256. Idempotent:
# a lib already there with the right hash is kept. native/build.rs links it.
# vendor/ghostty-vt/ is not committed (27 MB); native/src/ffi.rs is, generated
# from these headers with bindgen 0.72:
#   bindgen vendor/ghostty-vt/Headers/ghostty/vt.h --allowlist-function 'ghostty_.*' \
#     --allowlist-type 'Ghostty.*' --allowlist-var 'GHOSTTY_.*' --no-prepend-enum-name \
#     --no-layout-tests --with-derive-default --no-doc-comments -- -Ivendor/ghostty-vt/Headers
set -eu
cd "$(dirname "$0")/.."

VERSION=1.0.1
URL="https://release.files.ghostty.org/libghostty-vt/$VERSION/ghostty-vt-$VERSION.xcframework.zip"
ZIP_SHA=c0f9631277f726154c8f521954d17cdc41aac4626fc0df8cf925a19ee58e829b
LIB_SHA=5388c66b81d8fadc63d4fd6ca8984d2be4645a98d2397ad9d43437a6b96c7cf5
DEST=vendor/ghostty-vt

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

if [ -f "$DEST/libghostty-vt.a" ] && [ "$(sha "$DEST/libghostty-vt.a")" = "$LIB_SHA" ]; then
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/vt.zip"
[ "$(sha "$TMP/vt.zip")" = "$ZIP_SHA" ] || { echo "libghostty-vt: zip SHA-256 mismatch" >&2; exit 1; }
unzip -q "$TMP/vt.zip" -d "$TMP/x"
SLICE="$TMP/x/ghostty-vt.xcframework/macos-arm64_x86_64"
[ "$(sha "$SLICE/libghostty-vt.a")" = "$LIB_SHA" ] || { echo "libghostty-vt: lib SHA-256 mismatch" >&2; exit 1; }
rm -rf "$DEST"
mkdir -p "$DEST"
cp "$SLICE/libghostty-vt.a" "$DEST/"
cp -R "$SLICE/Headers" "$DEST/"
echo "libghostty-vt $VERSION -> $DEST"

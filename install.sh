#!/bin/sh
set -eu

REPO="RoacherM/native-editor"
APP_NAME="Native Editor.app"
INSTALL_DIR="/Applications"
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "==> Downloading latest Native Editor release from $REPO..."
ZIP_URL="https://github.com/$REPO/releases/latest/download/Native-Editor-0.0.1-macos-arm64.zip"
curl -fsSL "$ZIP_URL" -o "$TMP_DIR/Native-Editor.zip"

echo "==> Extracting $APP_NAME..."
ditto -x -k "$TMP_DIR/Native-Editor.zip" "$TMP_DIR"

echo "==> Installing to $INSTALL_DIR/$APP_NAME..."
rm -rf "$INSTALL_DIR/$APP_NAME"
mv "$TMP_DIR/$APP_NAME" "$INSTALL_DIR/$APP_NAME"
xattr -cr "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true

echo "==> Installed successfully: $INSTALL_DIR/$APP_NAME"
open "$INSTALL_DIR/$APP_NAME"

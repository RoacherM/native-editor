#!/bin/sh
set -eu

SET_DEFAULT=0
for arg in "$@"; do
  case "$arg" in
    --set-default) SET_DEFAULT=1 ;;
    *)
      echo "usage: $0 [--set-default]" >&2
      exit 2
      ;;
  esac
done

REPO="RoacherM/native-editor"
APP_NAME="Aed.app"
INSTALL_DIR="/Applications"
TMP_DIR="$(mktemp -d)"
cleanup() {
  if [ -d "$TMP_DIR/mnt" ]; then
    hdiutil detach "$TMP_DIR/mnt" -force -quiet 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "==> Finding the latest Aed release of $REPO..."
# /releases/latest redirects to /releases/tag/v<version>; asset names carry the version.
LATEST_URL="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")"
VERSION="${LATEST_URL##*/v}"
case "$VERSION" in
  ""|*/*) echo "error: cannot read the latest version from $LATEST_URL" >&2; exit 1 ;;
esac
BASE_URL="https://github.com/$REPO/releases/download/v$VERSION"
ZIP_URL="$BASE_URL/Aed-$VERSION-macos-arm64.zip"
DMG_URL="$BASE_URL/Aed-$VERSION-macos-arm64.dmg"

# Download and unpack first: a failed download must not remove the installed app.
echo "==> Downloading Aed $VERSION..."
if curl -fsSL "$ZIP_URL" -o "$TMP_DIR/Aed.zip" 2>/dev/null; then
  ditto -x -k --norsrc "$TMP_DIR/Aed.zip" "$TMP_DIR"
else
  curl -fsSL "$DMG_URL" -o "$TMP_DIR/Aed.dmg"
  mkdir -p "$TMP_DIR/mnt"
  hdiutil attach -nobrowse -readonly -noverify -noautoopen -mountpoint "$TMP_DIR/mnt" "$TMP_DIR/Aed.dmg" >/dev/null
  ditto --norsrc "$TMP_DIR/mnt/$APP_NAME" "$TMP_DIR/$APP_NAME"
  hdiutil detach "$TMP_DIR/mnt" -force -quiet 2>/dev/null || true
fi

echo "==> Installing to $INSTALL_DIR/$APP_NAME..."
rm -rf "${INSTALL_DIR:?}/Native Editor.app" "${INSTALL_DIR:?}/${APP_NAME:?}"
mv "$TMP_DIR/$APP_NAME" "$INSTALL_DIR/$APP_NAME"

xattr -cr "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true
for bin in libFinderBridge.dylib AedCore set_default_handlers Aed; do
  if [ -f "$INSTALL_DIR/$APP_NAME/Contents/MacOS/$bin" ]; then
    codesign --force --sign - "$INSTALL_DIR/$APP_NAME/Contents/MacOS/$bin" 2>/dev/null || true
  fi
done
codesign --force --deep --sign - "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true
touch "$INSTALL_DIR/$APP_NAME/Contents/Info.plist" "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true
"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister" -f -R -trusted "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true

if [ "$SET_DEFAULT" -eq 1 ]; then
  "$INSTALL_DIR/$APP_NAME/Contents/MacOS/set_default_handlers" 2>/dev/null || true
  echo "==> Installed and set as default document editor: $INSTALL_DIR/$APP_NAME"
else
  echo "==> Installed: $INSTALL_DIR/$APP_NAME (pass --set-default to set as default document editor)"
fi
open "$INSTALL_DIR/$APP_NAME" || "$INSTALL_DIR/$APP_NAME/Contents/MacOS/Aed" >/dev/null 2>&1 &

#!/bin/sh
set -eu

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

echo "==> Downloading latest Aed release from $REPO..."
ZIP_URL="https://github.com/$REPO/releases/latest/download/Aed-0.0.1-macos-arm64.zip"
DMG_URL="https://github.com/$REPO/releases/latest/download/Aed-0.0.1-macos-arm64.dmg"

echo "==> Extracting $APP_NAME..."
rm -rf "$INSTALL_DIR/Native Editor.app" "$INSTALL_DIR/$APP_NAME"
if curl -fsSL "$ZIP_URL" -o "$TMP_DIR/Aed.zip" 2>/dev/null; then
  ditto -x -k --norsrc "$TMP_DIR/Aed.zip" "$TMP_DIR"
  echo "==> Installing to $INSTALL_DIR/$APP_NAME..."
  mv "$TMP_DIR/$APP_NAME" "$INSTALL_DIR/$APP_NAME"
else
  curl -fsSL "$DMG_URL" -o "$TMP_DIR/Aed.dmg"
  mkdir -p "$TMP_DIR/mnt"
  hdiutil attach -nobrowse -readonly -noverify -noautoopen -mountpoint "$TMP_DIR/mnt" "$TMP_DIR/Aed.dmg" >/dev/null
  echo "==> Installing to $INSTALL_DIR/$APP_NAME..."
  ditto --norsrc "$TMP_DIR/mnt/$APP_NAME" "$INSTALL_DIR/$APP_NAME"
  hdiutil detach "$TMP_DIR/mnt" -force -quiet 2>/dev/null || true
fi

/usr/bin/plutil -replace LSMinimumSystemVersion -string "11.0" "$INSTALL_DIR/$APP_NAME/Contents/Info.plist" 2>/dev/null || true

PYTHON_BIN="python3"
if [ -x "/usr/bin/python3" ]; then
  PYTHON_BIN="/usr/bin/python3"
fi

if command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  "$PYTHON_BIN" - "$INSTALL_DIR/$APP_NAME" << 'PYEOF' || true
import base64, hashlib, os, re, struct, sys

app_dir = sys.argv[1]
plist_path = os.path.join(app_dir, "Contents", "Info.plist")
code_res_path = os.path.join(app_dir, "Contents", "_CodeSignature", "CodeResources")
macos_dir = os.path.join(app_dir, "Contents", "MacOS")

if os.path.isfile(plist_path):
    with open(plist_path, "rb") as f:
        raw_plist = f.read()
    raw_plist = re.sub(
        rb"(<key>LSMinimumSystemVersion</key>\s*<string>)[^<]*(</string>)",
        rb"\g<1>11.0\g<2>",
        raw_plist,
    )
    with open(plist_path, "wb") as f:
        f.write(raw_plist)
    info_plist_sha256 = hashlib.sha256(raw_plist).digest()
else:
    info_plist_sha256 = b"\x00" * 32

def patch_and_adhoc_sign_macho(path, ident, is_main=False, info_hash=None, cr_hash=None):
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as f:
        data = bytearray(f.read())
    if len(data) < 32 or struct.unpack("<I", data[:4])[0] != 0xFEEDFACF:
        return None
    ncmds = struct.unpack("<I", data[16:20])[0]
    offset = 32
    cs_off = cs_size = 0
    for _ in range(ncmds):
        if offset + 8 > len(data):
            break
        cmd, cmdsize = struct.unpack("<II", data[offset:offset+8])
        if cmd == 0x32 and cmdsize >= 24:
            platform, minos, sdk, ntools = struct.unpack("<IIII", data[offset+8:offset+24])
            struct.pack_into("<IIII", data, offset+8, platform, 0x000B0000, 0x000E0000, ntools)
        elif cmd == 0x1D and cmdsize >= 16:
            cs_off, cs_size = struct.unpack("<II", data[offset+8:offset+16])
        offset += cmdsize
    if cs_off == 0 or cs_size == 0:
        with open(path, "wb") as f:
            f.write(data)
        return None
    old_sig = data[cs_off:cs_off+cs_size]
    _, b_off0 = struct.unpack(">II", old_sig[12:20])
    exec_seg_base, exec_seg_limit, exec_seg_flags = struct.unpack(">QQQ", old_sig[b_off0+64:b_off0+88])
    req_blob = struct.pack(">III", 0xFADE0C01, 12, 0)
    req_hash = hashlib.sha256(req_blob).digest()
    cms_blob = struct.pack(">II", 0xFADE0B01, 8)
    page_size = 16384
    n_code = (cs_off + page_size - 1) // page_size
    n_special = 3 if is_main else 2
    ident_bytes = ident.encode("utf-8") + b"\x00"
    ident_off = 88
    hash_off = ident_off + len(ident_bytes) + n_special * 32
    cd_len = hash_off + n_code * 32
    cd_header = struct.pack(
        ">IIIIIIIIIBBBBIIIIQQQQ",
        0xFADE0C02, cd_len, 0x00020400, 0x00000002, hash_off, ident_off,
        n_special, n_code, cs_off, 32, 2, 0, 14, 0, 0, 0, 0, 0,
        exec_seg_base, exec_seg_limit, exec_seg_flags,
    )
    special_hashes = (cr_hash + req_hash + info_hash) if is_main else (req_hash + b"\x00" * 32)
    code_hashes = bytearray()
    for p in range(n_code):
        chunk = data[p * page_size : min((p + 1) * page_size, cs_off)]
        code_hashes.extend(hashlib.sha256(chunk).digest())
    cd_blob = cd_header + ident_bytes + special_hashes + bytes(code_hashes)
    off_cd = 36
    off_req = off_cd + len(cd_blob)
    off_cms = off_req + len(req_blob)
    sb_len = off_cms + len(cms_blob)
    sb = (
        struct.pack(">III", 0xFADE0CC0, sb_len, 3)
        + struct.pack(">II", 0, off_cd)
        + struct.pack(">II", 2, off_req)
        + struct.pack(">II", 0x10000, off_cms)
        + cd_blob + req_blob + cms_blob
    )
    if len(sb) <= cs_size:
        data[cs_off:cs_off+cs_size] = sb + b"\x00" * (cs_size - len(sb))
    with open(path, "wb") as f:
        f.write(data)
    return hashlib.sha256(cd_blob).digest()[:20]

cdhashes = {}
for fname, ident in [("AedCore", "AedCore"), ("libFinderBridge.dylib", "libFinderBridge"), ("set_default_handlers", "set_default_handlers")]:
    h = patch_and_adhoc_sign_macho(os.path.join(macos_dir, fname), ident, is_main=False)
    if h:
        cdhashes[f"MacOS/{fname}"] = h

if os.path.isfile(code_res_path):
    with open(code_res_path, "rb") as f:
        raw_cr = f.read()
    for rel_key, cdhash in cdhashes.items():
        b64 = base64.b64encode(cdhash)
        pattern = (
            rb"(<key>" + re.escape(rel_key.encode("utf-8")) + rb"</key>\s*<dict>\s*)"
            rb"<key>cdhash</key>\s*<data>\s*[^<]*</data>"
            rb"(?:\s*<key>requirement</key>\s*<string>[^<]*</string>)?"
            rb"(\s*</dict>)"
        )
        replacement = rb"\g<1><key>cdhash</key>\n\t\t\t<data>\n\t\t\t" + b64 + rb"\n\t\t\t</data>\g<2>"
        raw_cr = re.sub(pattern, replacement, raw_cr)
    with open(code_res_path, "wb") as f:
        f.write(raw_cr)
    cr_sha256 = hashlib.sha256(raw_cr).digest()
else:
    cr_sha256 = b"\x00" * 32

patch_and_adhoc_sign_macho(os.path.join(macos_dir, "Aed"), "dev.byronwayne.aed", is_main=True, info_hash=info_plist_sha256, cr_hash=cr_sha256)
PYEOF
fi

for bin in libFinderBridge.dylib AedCore set_default_handlers Aed; do
  if [ -f "$INSTALL_DIR/$APP_NAME/Contents/MacOS/$bin" ]; then
    codesign --force --sign - "$INSTALL_DIR/$APP_NAME/Contents/MacOS/$bin" 2>/dev/null || true
  fi
done
codesign --force --deep --sign - "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true
xattr -cr "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true
touch "$INSTALL_DIR/$APP_NAME/Contents/Info.plist" "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true
"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister" -f -R -trusted "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true
"$INSTALL_DIR/$APP_NAME/Contents/MacOS/set_default_handlers" 2>/dev/null || true

echo "==> Installed successfully and set as default document editor: $INSTALL_DIR/$APP_NAME"
open "$INSTALL_DIR/$APP_NAME" || "$INSTALL_DIR/$APP_NAME/Contents/MacOS/Aed" >/dev/null 2>&1 &

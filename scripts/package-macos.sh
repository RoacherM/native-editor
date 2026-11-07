#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

APP_BUNDLE=".nsh/out/Aed.app"
MACOS_DIR="$APP_BUNDLE/Contents/MacOS"
PLIST_PATH="$APP_BUNDLE/Contents/Info.plist"
SIGN_ID="1BA80B4A6DD4AA3BF2D4A3C39578ED857831F4B5"
export MACOSX_DEPLOYMENT_TARGET="11.0"

if ! security find-identity -v -p codesigning | grep -q "$SIGN_ID"; then
  SIGN_ID="-"
fi

echo "==> 1. Running nsh check, nsh test & nsh package..."
rm -rf .nsh/out
nsh check
nsh test
nsh package --target macos

echo "==> 2. Building Finder open-file bridge, CLI launcher & UTI handler..."
mv "$MACOS_DIR/Aed" "$MACOS_DIR/AedCore"
clang -mmacosx-version-min=11.0 -dynamiclib -framework Cocoa -O2 \
  -install_name "@executable_path/libFinderBridge.dylib" \
  scripts/finder_bridge.m -o "$MACOS_DIR/libFinderBridge.dylib"
clang -mmacosx-version-min=11.0 -O2 scripts/launcher.c -o "$MACOS_DIR/Aed"
clang -mmacosx-version-min=11.0 -framework Foundation -framework CoreServices -framework UniformTypeIdentifiers -O2 \
  scripts/set_default_handlers.m -o "$MACOS_DIR/set_default_handlers"

echo "==> 3. Updating Info.plist with CFBundleDocumentTypes & UTExportedTypeDeclarations..."
python3 - "$PLIST_PATH" "$MACOS_DIR" << 'PYEOF'
import json, os, struct, subprocess, sys

plist_path = sys.argv[1]
macos_dir = sys.argv[2]
try:
    import plistlib
    with open(plist_path, "rb") as f:
        plist = plistlib.load(f)
    use_plistlib = True
except Exception:
    use_plistlib = False
    subprocess.run(["/usr/bin/plutil", "-convert", "json", plist_path], check=True)
    with open(plist_path, "r", encoding="utf-8") as f:
        plist = json.load(f)

plist["LSMinimumSystemVersion"] = "11.0"

extensions = [
    "md", "markdown", "mdx", "txt", "text", "log", "rst", "adoc", "srt", "vtt", "ass",
    "mmd", "mermaid",
    "json", "jsonl", "ndjson", "csv", "tsv",
    "yaml", "yml", "toml", "ini", "conf", "cfg", "env", "xml", "plist",
    "diff", "patch",
    "ts", "tsx", "js", "jsx", "mjs", "cjs",
    "py", "rs", "go", "c", "h", "cpp", "hpp", "cc",
    "swift", "java", "kt", "rb", "php", "lua", "zig",
    "sql", "graphql", "gql", "proto", "css", "scss", "less", "html", "svg",
    "sh", "bash", "zsh", "fish",
    "png", "jpg", "jpeg", "gif", "webp", "avif", "mp4", "mov", "m4v", "wav", "mp3", "m4a", "flac", "ogg", "pdf"
]

plist["CFBundleDocumentTypes"] = [
    {
        "CFBundleTypeName": "Document & Source File",
        "CFBundleTypeRole": "Editor",
        "LSHandlerRank": "Default",
        "CFBundleTypeIconFile": "AppIcon",
        "CFBundleTypeExtensions": extensions,
        "LSItemContentTypes": [
            "public.text",
            "public.plain-text",
            "public.utf8-plain-text",
            "public.source-code",
            "public.script",
            "public.shell-script",
            "public.data",
            "public.json",
            "public.xml",
            "public.yaml",
            "org.yaml.yaml",
            "org.toml.toml",
            "net.daringfireball.markdown",
            "public.markdown",
            "public.comma-separated-values-text",
            "public.tab-separated-values-text",
            "public.patch-file",
            "public.log",
            "dev.byronwayne.aed.mermaid",
            "dev.byronwayne.aed.jsonl",
        ],
    },
    {
        "CFBundleTypeName": "Folder",
        "CFBundleTypeRole": "Viewer",
        "LSHandlerRank": "Alternate",
        "LSItemContentTypes": ["public.folder"],
    },
]

plist["UTExportedTypeDeclarations"] = [
    {
        "UTTypeIdentifier": "dev.byronwayne.aed.mermaid",
        "UTTypeDescription": "Mermaid Diagram",
        "UTTypeConformsTo": ["public.plain-text", "public.text"],
        "UTTypeTagSpecification": {
            "public.filename-extension": ["mmd", "mermaid"],
            "public.mime-type": ["text/vnd.mermaid", "text/plain"],
        },
    },
    {
        "UTTypeIdentifier": "dev.byronwayne.aed.jsonl",
        "UTTypeDescription": "JSON Lines Data",
        "UTTypeConformsTo": ["public.json", "public.plain-text"],
        "UTTypeTagSpecification": {
            "public.filename-extension": ["jsonl", "ndjson"],
            "public.mime-type": ["application/x-ndjson", "application/jsonl"],
        },
    },
]

if use_plistlib:
    with open(plist_path, "wb") as f:
        plistlib.dump(plist, f)
else:
    with open(plist_path, "w", encoding="utf-8") as f:
        json.dump(plist, f)
    subprocess.run(["/usr/bin/plutil", "-convert", "xml1", plist_path], check=True)

for name in os.listdir(macos_dir):
    bin_path = os.path.join(macos_dir, name)
    if not os.path.isfile(bin_path):
        continue
    with open(bin_path, "rb") as f:
        data = bytearray(f.read())
    if len(data) < 32 or struct.unpack("<I", data[:4])[0] != 0xFEEDFACF:
        continue
    ncmds = struct.unpack("<I", data[16:20])[0]
    offset = 32
    changed = False
    for _ in range(ncmds):
        if offset + 8 > len(data):
            break
        cmd, cmdsize = struct.unpack("<II", data[offset:offset+8])
        if cmd == 0x32 and cmdsize >= 24:
            platform, minos, sdk, ntools = struct.unpack("<IIII", data[offset+8:offset+24])
            struct.pack_into("<IIII", data, offset+8, platform, 0x000B0000, 0x000E0000, ntools)
            changed = True
        offset += cmdsize
    if changed:
        with open(bin_path, "wb") as f:
            f.write(data)
PYEOF

echo "==> 4. Signing Aed.app (identity: $SIGN_ID)..."
codesign --force --sign "$SIGN_ID" "$MACOS_DIR/libFinderBridge.dylib"
codesign --force --sign "$SIGN_ID" "$MACOS_DIR/AedCore"
codesign --force --sign "$SIGN_ID" "$MACOS_DIR/set_default_handlers"
codesign --force --sign "$SIGN_ID" "$MACOS_DIR/Aed"
codesign --force --deep --sign "$SIGN_ID" "$APP_BUNDLE"
xattr -cr "$APP_BUNDLE"

echo "==> 5. Installing to /Applications & registering LaunchServices..."
FIRST_INSTALL=0
if [ ! -d "/Applications/Aed.app" ]; then
  FIRST_INSTALL=1
fi
rm -rf "/Applications/Native Editor.app" "/Applications/Aed.app"
cp -R "$APP_BUNDLE" "/Applications/Aed.app"
xattr -cr "/Applications/Aed.app"
codesign --force --deep --sign "$SIGN_ID" "/Applications/Aed.app"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "/Applications/Aed.app"
fi

if [ "$FIRST_INSTALL" = "1" ] || [ "${1:-}" = "--set-default" ]; then
  "/Applications/Aed.app/Contents/MacOS/set_default_handlers"
fi

echo "==> 6. Building DMG and ZIP release archives..."
rm -rf .nsh/dmg-stage .nsh/out/*.dmg .nsh/out/*.zip
mkdir -p .nsh/dmg-stage
cp -R "$APP_BUNDLE" .nsh/dmg-stage/
ln -s /Applications .nsh/dmg-stage/Applications
cat << 'EOF' > ".nsh/dmg-stage/Install & Set Default.command"
#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
rm -rf "/Applications/Native Editor.app" "/Applications/Aed.app"
cp -R "$DIR/Aed.app" "/Applications/Aed.app"
codesign --force --deep --sign - "/Applications/Aed.app" 2>/dev/null || true
xattr -cr "/Applications/Aed.app"
"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister" -f "/Applications/Aed.app" 2>/dev/null || true
"/Applications/Aed.app/Contents/MacOS/set_default_handlers" 2>/dev/null || true
open "/Applications/Aed.app"
EOF
chmod +x ".nsh/dmg-stage/Install & Set Default.command"

ditto -c -k --norsrc --noextattr --keepParent "$APP_BUNDLE" .nsh/out/Aed-0.0.1-macos-arm64.zip
hdiutil create -volname "Aed 0.0.1" -srcfolder .nsh/dmg-stage -ov -format UDZO .nsh/out/Aed-0.0.1-macos-arm64.dmg
rm -rf .nsh/dmg-stage
ls -lh .nsh/out/

#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

APP_BUNDLE=".nsh/out/Native Editor.app"
MACOS_DIR="$APP_BUNDLE/Contents/MacOS"
PLIST_PATH="$APP_BUNDLE/Contents/Info.plist"
SIGN_ID="1BA80B4A6DD4AA3BF2D4A3C39578ED857831F4B5"

if ! security find-identity -v -p codesigning | grep -q "$SIGN_ID"; then
  SIGN_ID="-"
fi

echo "==> 1. Running nsh check, nsh test & nsh package..."
rm -rf .nsh/out
nsh check
nsh test
nsh package --target macos

echo "==> 2. Building Finder open-file bridge & CLI launcher..."
mv "$MACOS_DIR/NativeEditor" "$MACOS_DIR/NativeEditorCore"
clang -dynamiclib -framework Cocoa -O2 \
  -install_name "@executable_path/libFinderBridge.dylib" \
  scripts/finder_bridge.m -o "$MACOS_DIR/libFinderBridge.dylib"
clang -O2 scripts/launcher.c -o "$MACOS_DIR/NativeEditor"

echo "==> 3. Updating Info.plist with CFBundleDocumentTypes & UTExportedTypeDeclarations..."
python3 - "$PLIST_PATH" << 'PYEOF'
import plistlib, sys

plist_path = sys.argv[1]
with open(plist_path, "rb") as f:
    plist = plistlib.load(f)

extensions = [
    "md", "markdown", "mdx", "txt", "text", "log", "rst", "adoc",
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
            "dev.byronwayne.nativeeditor.mermaid",
            "dev.byronwayne.nativeeditor.jsonl",
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
        "UTTypeIdentifier": "dev.byronwayne.nativeeditor.mermaid",
        "UTTypeDescription": "Mermaid Diagram",
        "UTTypeConformsTo": ["public.plain-text", "public.text"],
        "UTTypeTagSpecification": {
            "public.filename-extension": ["mmd", "mermaid"],
            "public.mime-type": ["text/vnd.mermaid", "text/plain"],
        },
    },
    {
        "UTTypeIdentifier": "dev.byronwayne.nativeeditor.jsonl",
        "UTTypeDescription": "JSON Lines Data",
        "UTTypeConformsTo": ["public.json", "public.plain-text"],
        "UTTypeTagSpecification": {
            "public.filename-extension": ["jsonl", "ndjson"],
            "public.mime-type": ["application/x-ndjson", "application/jsonl"],
        },
    },
]

with open(plist_path, "wb") as f:
    plistlib.dump(plist, f)
PYEOF

echo "==> 4. Signing Native Editor.app (identity: $SIGN_ID)..."
codesign --force --sign "$SIGN_ID" "$MACOS_DIR/libFinderBridge.dylib"
codesign --force --sign "$SIGN_ID" "$MACOS_DIR/NativeEditorCore"
codesign --force --sign "$SIGN_ID" "$MACOS_DIR/NativeEditor"
codesign --force --deep --sign "$SIGN_ID" "$APP_BUNDLE"
xattr -cr "$APP_BUNDLE"

echo "==> 5. Installing to /Applications & registering default file associations..."
rm -rf "/Applications/Native Editor.app"
cp -R "$APP_BUNDLE" "/Applications/Native Editor.app"
xattr -cr "/Applications/Native Editor.app"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "/Applications/Native Editor.app"
fi

clang -framework Foundation -framework CoreServices -framework UniformTypeIdentifiers -O2 \
  scripts/set_default_handlers.m -o .nsh/out/set_default_handlers
cp .nsh/out/set_default_handlers "/Applications/Native Editor.app/Contents/MacOS/set_default_handlers"
cp .nsh/out/set_default_handlers "$MACOS_DIR/set_default_handlers"
codesign --force --sign "$SIGN_ID" "$MACOS_DIR/set_default_handlers"
codesign --force --deep --sign "$SIGN_ID" "$APP_BUNDLE"
codesign --force --deep --sign "$SIGN_ID" "/Applications/Native Editor.app"
.nsh/out/set_default_handlers
rm -f .nsh/out/set_default_handlers

echo "==> 6. Building DMG and ZIP release archives..."
rm -rf .nsh/dmg-stage .nsh/out/*.dmg .nsh/out/*.zip
mkdir -p .nsh/dmg-stage
cp -R "$APP_BUNDLE" .nsh/dmg-stage/
ln -s /Applications .nsh/dmg-stage/Applications
cat << 'EOF' > ".nsh/dmg-stage/Install & Set Default.command"
#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
rm -rf "/Applications/Native Editor.app"
cp -R "$DIR/Native Editor.app" "/Applications/Native Editor.app"
xattr -cr "/Applications/Native Editor.app"
"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister" -f "/Applications/Native Editor.app" 2>/dev/null || true
"/Applications/Native Editor.app/Contents/MacOS/set_default_handlers" 2>/dev/null || true
open "/Applications/Native Editor.app"
EOF
chmod +x ".nsh/dmg-stage/Install & Set Default.command"

ditto -c -k --sequesterRsrc --keepParent "$APP_BUNDLE" .nsh/out/Native-Editor-0.0.1-macos-arm64.zip
hdiutil create -volname "Native Editor 0.0.1" -srcfolder .nsh/dmg-stage -ov -format UDZO .nsh/out/Native-Editor-0.0.1-macos-arm64.dmg
rm -rf .nsh/dmg-stage
ls -lh .nsh/out/

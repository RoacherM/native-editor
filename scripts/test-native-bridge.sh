#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

TMP_DIR="$(mktemp -d)"
cleanup() {
  chmod -R u+rwx "$TMP_DIR" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  if [ "$1" != "$2" ]; then
    fail "$3: expected [$2], got [$1]"
  fi
}

echo "==> 1. Running shellcheck on scripts/*.sh and install.sh..."
shellcheck scripts/*.sh install.sh

echo "==> 2. Compiling launcher.c and finder_bridge.m..."
mkdir -p "$TMP_DIR/MacOS" "$TMP_DIR/work" "$TMP_DIR/home/Library"
REAL_TMP="$(cd "$TMP_DIR" && pwd -P)"
REAL_WORK="$REAL_TMP/work"
REAL_HOME="$REAL_TMP/home"

clang -mmacosx-version-min=11.0 -Wall -Wextra -Werror -O2 \
  scripts/launcher.c -o "$TMP_DIR/MacOS/Aed"

clang -mmacosx-version-min=11.0 -Wall -Wextra -Werror -Wno-unused-parameter \
  -dynamiclib -framework Cocoa -O2 \
  -install_name "@executable_path/libFinderBridge.dylib" \
  scripts/finder_bridge.m -o "$TMP_DIR/MacOS/libFinderBridge.dylib"

cat << 'EOF' > "$TMP_DIR/MacOS/AedCore"
#!/bin/sh
set -eu
OUT="$AED_TEST_CAPTURE"
printf '%s' "${AED_OPEN_FILE:-}" > "$OUT/open_file"
printf '%s' "${AED_ROOT:-}" > "$OUT/root"
printf '%s' "${AED_OPEN_QUEUE:-}" > "$OUT/open_queue"
printf '%s' "${DYLD_INSERT_LIBRARIES:-}" > "$OUT/dyld"
mkdir -p "$OUT/queued"
if [ -n "${AED_OPEN_QUEUE:-}" ] && [ -d "$AED_OPEN_QUEUE" ]; then
  cp "$AED_OPEN_QUEUE"/*.path "$OUT/queued/" 2>/dev/null || true
fi
EOF
chmod +x "$TMP_DIR/MacOS/AedCore"

run_launcher() {
  rm -rf "$TMP_DIR/cap"
  mkdir -p "$TMP_DIR/cap"
  HOME="$REAL_HOME" AED_TEST_CAPTURE="$TMP_DIR/cap" \
    AED_OPEN_FILE="/stale/file" AED_ROOT="/stale/root" \
    "$TMP_DIR/MacOS/Aed" "$@"
}

echo "==> 3. Testing launcher CLI resolution & unambiguous file://#L queue framing..."
printf 'line1\n' > "$REAL_WORK/a.ts"
printf 'spaced\n' > "$REAL_WORK/spaced file.ts"
printf 'sharp\n' > "$REAL_WORK/C# notes.md"
printf 'colon\n' > "$REAL_WORK/foo:10"

# a.ts:12:3, #L9, file://#L9, file://localhost/...#L7C2
run_launcher \
  "$REAL_WORK/a.ts:12:3" \
  "$REAL_WORK/a.ts#L9" \
  "file://$REAL_WORK/a.ts#L15" \
  "file://localhost$REAL_WORK/spaced%20file.ts#L7C2" \
  "$REAL_WORK/C# notes.md:5"

assert_eq "$(cat "$TMP_DIR/cap/open_file")" "file://$REAL_WORK/a.ts#L12C3" "a.ts:12:3 -> file://#L12C3"
assert_eq "$(cat "$TMP_DIR/cap/root")" "" "files clear AED_ROOT"
assert_eq "$(cat "$TMP_DIR/cap/queued/1.path")" "file://$REAL_WORK/a.ts#L9" "a.ts#L9 -> 1.path"
assert_eq "$(cat "$TMP_DIR/cap/queued/2.path")" "file://$REAL_WORK/a.ts#L15" "file://...#L15 -> 2.path"
assert_eq "$(cat "$TMP_DIR/cap/queued/3.path")" "file://$REAL_WORK/spaced%20file.ts#L7C2" "file://localhost spaced -> 3.path"
assert_eq "$(cat "$TMP_DIR/cap/queued/4.path")" "file://$REAL_WORK/C%23%20notes.md#L5" "C# notes.md:5 -> 4.path"

# Literal foo:10 vs foo:10:20 (foo:10 exists on disk; foo does not)
run_launcher "$REAL_WORK/foo:10" "$REAL_WORK/foo:10:20"
assert_eq "$(cat "$TMP_DIR/cap/open_file")" "$REAL_WORK/foo:10" "literal foo:10 stays plain path"
assert_eq "$(cat "$TMP_DIR/cap/queued/1.path")" "file://$REAL_WORK/foo%3A10#L20" "foo:10:20 -> foo%3A10#L20"

# Folder argument sets AED_ROOT when no files are given
run_launcher "$REAL_WORK"
assert_eq "$(cat "$TMP_DIR/cap/root")" "$REAL_WORK" "folder sets AED_ROOT"
assert_eq "$(cat "$TMP_DIR/cap/open_file")" "" "folder leaves AED_OPEN_FILE empty"

echo "==> 4. Testing symlink queue safety & permissions..."
CACHE_DIR="$REAL_HOME/Library/Caches/dev.byronwayne.aed"
CACHE_MODE="$(stat -f '%Lp' "$CACHE_DIR")"
assert_eq "$CACHE_MODE" "700" "cache dir mode 0700"

mkdir -p "$TMP_DIR/victim"
printf 'keep\n' > "$TMP_DIR/victim/keep.txt"
ln -s "$TMP_DIR/victim" "$CACHE_DIR/open-99999992"
run_launcher "$REAL_WORK/a.ts"
[ ! -L "$CACHE_DIR/open-99999992" ] || fail "dead-pid symlink queue was not removed"
[ -f "$TMP_DIR/victim/keep.txt" ] || fail "dead-pid cleanup followed symlink into victim dir"

rm -rf "$CACHE_DIR"
ln -s "$TMP_DIR/victim" "$CACHE_DIR"
run_launcher "$REAL_WORK/a.ts" "$REAL_WORK/spaced file.ts"
[ -L "$CACHE_DIR" ] || fail "symlinked cache dir was unexpectedly replaced"
[ ! -e "$TMP_DIR/victim/1.path" ] || fail "queue writer followed symlinked cache dir"
rm -f "$CACHE_DIR"

echo "==> 5. Testing finder_bridge.m (#fragment URLs & state-based window reuse)..."
cat << 'EOF' > "$TMP_DIR/test_finder_bridge.m"
#import <Cocoa/Cocoa.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

@interface FakeBridgeDelegate : NSObject
@end
@implementation FakeBridgeDelegate
@end

@interface MenuTarget : NSObject
@property(nonatomic, assign) int queuedTriggered;
- (void)onOpenQueued:(id)sender;
@end
@implementation MenuTarget
- (void)onOpenQueued:(id)sender {
  (void)sender;
  self.queuedTriggered += 1;
}
@end

@interface FakeApp : NSObject
@property(nonatomic, retain) id delegate;
@property(nonatomic, retain) NSMenu *mainMenu;
@property(nonatomic, assign) int activatedCount;
- (NSArray *)windows;
- (void)activateIgnoringOtherApps:(BOOL)flag;
- (BOOL)sendAction:(SEL)action to:(id)target from:(id)sender;
- (void)replyToOpenOrPrint:(NSApplicationDelegateReply)reply;
@end

@implementation FakeApp
- (NSArray *)windows { return @[]; }
- (void)activateIgnoringOtherApps:(BOOL)flag {
  (void)flag;
  self.activatedCount += 1;
}
- (BOOL)sendAction:(SEL)action to:(id)target from:(id)sender {
  if (!target || !action) return NO;
  ((void (*)(id, SEL, id))[target methodForSelector:action])(target, action, sender);
  return YES;
}
- (void)replyToOpenOrPrint:(NSApplicationDelegateReply)reply { (void)reply; }
@end

@interface NSObject (BridgeHooks)
- (void)application:(NSApplication *)app openURLs:(NSArray<NSURL *> *)urls;
@end

static NSString *readFileString(NSString *path) {
  NSData *d = [NSData dataWithContentsOfFile:path];
  if (!d) return nil;
  return [[[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding] autorelease];
}

int main(void) {
  @autoreleasepool {
    if (getenv("DYLD_INSERT_LIBRARIES") != NULL) {
      fprintf(stderr, "DYLD_INSERT_LIBRARIES was not cleared by constructor\n");
      return 1;
    }
    const char *qEnv = getenv("AED_OPEN_QUEUE");
    if (!qEnv || qEnv[0] != '/') {
      fprintf(stderr, "AED_OPEN_QUEUE was not set by constructor\n");
      return 1;
    }
    NSString *queueDir = [NSString stringWithUTF8String:qEnv];

    FakeApp *app = [[[FakeApp alloc] init] autorelease];
    FakeBridgeDelegate *delegate = [[[FakeBridgeDelegate alloc] init] autorelease];
    app.delegate = delegate;

    MenuTarget *target = [[[MenuTarget alloc] init] autorelease];
    NSMenu *bar = [[[NSMenu alloc] initWithTitle:@"Main"] autorelease];
    NSMenuItem *fileTop = [[[NSMenuItem alloc] initWithTitle:@"File" action:NULL keyEquivalent:@""] autorelease];
    NSMenu *fileMenu = [[[NSMenu alloc] initWithTitle:@"File"] autorelease];
    NSMenuItem *openQueued = [[[NSMenuItem alloc] initWithTitle:@"Open Queued Files"
                                                         action:@selector(onOpenQueued:)
                                                  keyEquivalent:@""] autorelease];
    [openQueued setTarget:target];
    [fileMenu addItem:openQueued];
    [fileTop setSubmenu:fileMenu];
    [bar addItem:fileTop];
    app.mainMenu = bar;

    // Assign headless FakeApp to NSApp without calling +sharedApplication (never touches WindowServer/Dock).
    NSApp = (NSApplication *)app;
    [[NSNotificationCenter defaultCenter] postNotificationName:NSApplicationDidFinishLaunchingNotification object:app];

    NSString *samplePath = [NSString stringWithFormat:@"%s/work/a.ts", getenv("AED_BRIDGE_TMP")];
    NSURL *fragUrl = [NSURL URLWithString:[NSString stringWithFormat:@"file://%@#L42C5", samplePath]];
    NSURL *plainUrl = [NSURL fileURLWithPath:samplePath];

    // 1. Cold start openURLs preserves #L42C5 fragment and plain path fallback.
    [(id)delegate application:(NSApplication *)app openURLs:@[ fragUrl, plainUrl ]];
    NSString *entry1 = readFileString([queueDir stringByAppendingPathComponent:@"1.path"]);
    NSString *entry2 = readFileString([queueDir stringByAppendingPathComponent:@"2.path"]);
    NSString *expectedFrag = [NSString stringWithFormat:@"file://%@#L42C5", samplePath];
    if (![entry1 isEqualToString:expectedFrag]) {
      fprintf(stderr, "cold fragment mismatch: got [%s], want [%s]\n",
              entry1 ? [entry1 UTF8String] : "(nil)", [expectedFrag UTF8String]);
      return 1;
    }
    if (![entry2 isEqualToString:samplePath]) {
      fprintf(stderr, "cold plain mismatch: got [%s], want [%s]\n",
              entry2 ? [entry2 UTF8String] : "(nil)", [samplePath UTF8String]);
      return 1;
    }
    [[NSFileManager defaultManager] removeItemAtPath:[queueDir stringByAppendingPathComponent:@"1.path"] error:nil];
    [[NSFileManager defaultManager] removeItemAtPath:[queueDir stringByAppendingPathComponent:@"2.path"] error:nil];

    // 2. Warm open (gHasClaimedInitialTarget is now YES): with state="loose\n", reuses this window.
    NSString *statePath = [queueDir stringByAppendingPathComponent:@"state"];
    [@"loose\n" writeToFile:statePath atomically:NO encoding:NSUTF8StringEncoding error:nil];
    chmod([statePath fileSystemRepresentation], 0600);
    int beforeAct = app.activatedCount;
    [(id)delegate application:(NSApplication *)app openURLs:@[ fragUrl ]];
    NSString *warmEntry = readFileString([queueDir stringByAppendingPathComponent:@"1.path"]);
    if (![warmEntry isEqualToString:expectedFrag] || target.queuedTriggered != 1 || app.activatedCount <= beforeAct) {
      fprintf(stderr, "loose window reuse failed: entry=[%s] menu=%d act=%d->%d\n",
              warmEntry ? [warmEntry UTF8String] : "(nil)", target.queuedTriggered, beforeAct, app.activatedCount);
      return 1;
    }
    [[NSFileManager defaultManager] removeItemAtPath:[queueDir stringByAppendingPathComponent:@"1.path"] error:nil];

    // 3. With state="home", also reuses this window.
    [@"home" writeToFile:statePath atomically:NO encoding:NSUTF8StringEncoding error:nil];
    [(id)delegate application:(NSApplication *)app openURLs:@[ plainUrl ]];
    NSString *homeEntry = readFileString([queueDir stringByAppendingPathComponent:@"1.path"]);
    if (![homeEntry isEqualToString:samplePath] || target.queuedTriggered != 2) {
      fprintf(stderr, "home window reuse failed: entry=[%s] menu=%d\n",
              homeEntry ? [homeEntry UTF8String] : "(nil)", target.queuedTriggered);
      return 1;
    }
    [[NSFileManager defaultManager] removeItemAtPath:[queueDir stringByAppendingPathComponent:@"1.path"] error:nil];

    // 4. With state="workspace\n/tmp/w", does NOT queue into this window or trigger Open Queued Files.
    // Point mainBundle nowhere .app and no sibling Aed binary so spawnStandaloneWindow is a safe no-op.
    [@"workspace\n/tmp/w\n" writeToFile:statePath atomically:NO encoding:NSUTF8StringEncoding error:nil];
    [(id)delegate application:(NSApplication *)app openURLs:@[ plainUrl ]];
    NSString *wsEntry = readFileString([queueDir stringByAppendingPathComponent:@"1.path"]);
    if (wsEntry != nil || target.queuedTriggered != 2) {
      fprintf(stderr, "workspace window should not reuse: entry=[%s] menu=%d\n",
              wsEntry ? [wsEntry UTF8String] : "(nil)", target.queuedTriggered);
      return 1;
    }
    return 0;
  }
}
EOF

mkdir -p "$TMP_DIR/bridge-bin"
cp "$TMP_DIR/MacOS/libFinderBridge.dylib" "$TMP_DIR/bridge-bin/libFinderBridge.dylib"
clang -mmacosx-version-min=11.0 -Wall -Wextra -Werror -framework Cocoa -O2 \
  "$TMP_DIR/test_finder_bridge.m" \
  "$TMP_DIR/bridge-bin/libFinderBridge.dylib" \
  -Wl,-rpath,"$TMP_DIR/bridge-bin" \
  -o "$TMP_DIR/bridge-bin/test_finder_bridge"

HOME="$REAL_HOME" AED_BRIDGE_TMP="$REAL_TMP" \
  DYLD_INSERT_LIBRARIES="$TMP_DIR/bridge-bin/libFinderBridge.dylib" \
  "$TMP_DIR/bridge-bin/test_finder_bridge"

echo "✓ All native bridge & script checks passed"

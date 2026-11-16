#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#include <stdlib.h>

#include "aed_paths.h"

#define NE_MIN_WINDOW_WIDTH 760.0
#define NE_MIN_WINDOW_HEIGHT 520.0
#define AED_QUIT_RETRY_SECONDS 4.0

static CFAbsoluteTime gDidFinishLaunchingTime = 0.0;
static BOOL gDidFinishLaunching = NO;
static BOOL gHasClaimedInitialTarget = NO;

static NSString *const kAedEditedTitleSuffix = @" — Edited";
static NSString *const kAedOpenQueuedMenuTitle = @"Open Queued Files";

static void (*orig_setDelegate)(id, SEL, id) = NULL;
static BOOL (*gAedOrigWindowShouldClose)(id, SEL, NSWindow *) = NULL;
static NSApplicationTerminateReply (*gAedOrigShouldTerminate)(id, SEL, NSApplication *) = NULL;
static Class gAedWindowDelegateClass = Nil;
static Class gAedAppDelegateClass = Nil;
static CFAbsoluteTime gAedQuitChosenAt = 0;

/*
 * Install or replace `sel` on `cls` with `imp`, resolving its Objective-C type
 * encoding from an existing method, `protocol`, or `fallbackTypes`. Returns the
 * previous implementation (inherited or own), or NULL when none existed.
 */
static IMP neHookMethod(Class cls, SEL sel, IMP imp, Protocol *protocol, const char *fallbackTypes) {
  if (!cls) return NULL;
  Method m = class_getInstanceMethod(cls, sel);
  IMP orig = m ? method_getImplementation(m) : NULL;
  const char *types = m ? method_getTypeEncoding(m) : NULL;
  if (!types && protocol) {
    struct objc_method_description desc = protocol_getMethodDescription(protocol, sel, NO, YES);
    if (!desc.types) desc = protocol_getMethodDescription(protocol, sel, YES, YES);
    types = desc.types;
  }
  if (!types) types = fallbackTypes;
  if (!types) return NULL;
  if (!class_addMethod(cls, sel, imp, types) && m) {
    method_setImplementation(m, imp);
  }
  return orig;
}

static NSSize ne_window_willResize_toSize(id self, SEL _cmd, NSWindow *sender, NSSize frameSize) {
  CGFloat w = frameSize.width < NE_MIN_WINDOW_WIDTH ? NE_MIN_WINDOW_WIDTH : frameSize.width;
  CGFloat h = frameSize.height < NE_MIN_WINDOW_HEIGHT ? NE_MIN_WINDOW_HEIGHT : frameSize.height;
  return NSMakeSize(w, h);
}

static void enforceWindowMinSize(NSWindow *win) {
  static BOOL inEnforce = NO;
  if (inEnforce) return;
  if (!win || ![win isKindOfClass:[NSWindow class]]) return;
  NSUInteger mask = [win styleMask];
  if (!(mask & NSWindowStyleMaskResizable) || (mask & NSWindowStyleMaskFullScreen)) return;
  inEnforce = YES;
  id winDelegate = [win delegate];
  if (winDelegate) {
    neHookMethod([winDelegate class], @selector(windowWillResize:toSize:), (IMP)ne_window_willResize_toSize,
                 @protocol(NSWindowDelegate), "{CGSize=dd}@:@{CGSize=dd}");
  }
  NSSize minSize = NSMakeSize(NE_MIN_WINDOW_WIDTH, NE_MIN_WINDOW_HEIGHT);
  [win setContentMinSize:minSize];
  [win setMinSize:minSize];
  NSRect frame = [win frame];
  if (frame.size.width < NE_MIN_WINDOW_WIDTH || frame.size.height < NE_MIN_WINDOW_HEIGHT) {
    CGFloat nextW = frame.size.width < NE_MIN_WINDOW_WIDTH ? NE_MIN_WINDOW_WIDTH : frame.size.width;
    CGFloat nextH = frame.size.height < NE_MIN_WINDOW_HEIGHT ? NE_MIN_WINDOW_HEIGHT : frame.size.height;
    frame.origin.y -= (nextH - frame.size.height);
    frame.size.width = nextW;
    frame.size.height = nextH;
    [win setFrame:frame display:NO];
  }
  inEnforce = NO;
}

static void enforceAllWindowsMinSize(void) {
  for (NSWindow *win in [NSApp windows]) {
    enforceWindowMinSize(win);
  }
}

static void bringAppToFront(NSApplication *app) {
  if (!app) return;
  [app activateIgnoringOtherApps:YES];
  for (NSWindow *win in [app windows]) {
    if ([win isMiniaturized]) {
      [win deminiaturize:nil];
    }
    if ([win canBecomeKeyWindow]) {
      [win makeKeyAndOrderFront:nil];
    }
  }
}

/*
 * Queue `paths` for this window (`AED_OPEN_QUEUE`, DESIGN.md「术语与边界」);
 * nothing goes through /tmp or through the environment, which shells inherit.
 */
static BOOL queueForThisWindow(NSArray<NSString *> *paths) {
  BOOL ok = YES;
  for (NSString *path in paths) {
    const char *raw = [path hasPrefix:@"file://"] ? [path UTF8String] : [path fileSystemRepresentation];
    if (!raw || aedQueueAppend(getpid(), raw) != 0) ok = NO;
  }
  return ok;
}

static BOOL isBoundaryAfterStateWord(char c) {
  return c == '\0' || c == '\n' || c == '\r';
}

/*
 * Read `<cache>/open-<pid>/state` (`home` / `loose` / `workspace\n<root>`).
 * Returns YES when this window is in `home` or `loose` mode and may absorb
 * external file opens directly instead of spawning `open -n`.
 */
static BOOL aedWindowAcceptsLooseFiles(void) {
  char queueDir[PATH_MAX];
  if (aedQueueDir(getpid(), queueDir, sizeof queueDir) != 0) return NO;
  int qfd = open(queueDir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (qfd < 0) return NO;
  struct stat dirSt;
  if (fstat(qfd, &dirSt) != 0 || !S_ISDIR(dirSt.st_mode) || dirSt.st_uid != getuid()) {
    close(qfd);
    return NO;
  }
  int sfd = openat(qfd, "state", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  close(qfd);
  if (sfd < 0) return NO;
  struct stat fileSt;
  char buf[32];
  ssize_t n = -1;
  if (fstat(sfd, &fileSt) == 0 && S_ISREG(fileSt.st_mode) && fileSt.st_uid == getuid()) {
    n = read(sfd, buf, sizeof(buf) - 1);
  }
  close(sfd);
  if (n <= 0) return NO;
  buf[n] = '\0';
  return (strncmp(buf, "home", 4) == 0 && isBoundaryAfterStateWord(buf[4])) ||
         (strncmp(buf, "loose", 5) == 0 && isBoundaryAfterStateWord(buf[5]));
}

static NSMenuItem *aedFindMenuItemByTitle(NSMenu *menu, NSString *title) {
  if (!menu) return nil;
  for (NSMenuItem *item in [menu itemArray]) {
    if (![item isSeparatorItem] && [item action] != NULL && [[item title] isEqualToString:title]) {
      return item;
    }
    NSMenuItem *nested = aedFindMenuItemByTitle([item submenu], title);
    if (nested) return nested;
  }
  return nil;
}

static BOOL reuseIdleWindowForFiles(NSApplication *app, NSArray<NSString *> *files) {
  if (!app || [files count] == 0 || !aedWindowAcceptsLooseFiles()) return NO;
  NSMenu *root = ([app respondsToSelector:@selector(mainMenu)] ? [app mainMenu] : nil) ?: [NSApp mainMenu];
  NSMenuItem *item = aedFindMenuItemByTitle(root, kAedOpenQueuedMenuTitle);
  if (!item) return NO;
  if (!queueForThisWindow(files)) return NO;
  [app sendAction:[item action] to:[item target] from:item];
  bringAppToFront(app);
  return YES;
}

/* One new tree-less window that opens all `paths` as tabs. */
static void spawnStandaloneWindow(NSArray<NSString *> *paths) {
  if ([paths count] == 0) return;
  NSBundle *bundle = [NSBundle mainBundle];
  NSString *bundlePath = [bundle bundlePath];
  if (bundlePath && [bundlePath hasSuffix:@".app"]) {
    NSTask *task = [[[NSTask alloc] init] autorelease];
    [task setLaunchPath:@"/usr/bin/open"];
    NSMutableArray<NSString *> *args = [NSMutableArray arrayWithObjects:@"-n", bundlePath, @"--args", nil];
    [args addObjectsFromArray:paths];
    [task setArguments:args];
    @try {
      [task launch];
      return;
    } @catch (NSException *exception) {
    }
  }
  NSString *exeDir = [[bundle executablePath] stringByDeletingLastPathComponent];
  NSString *launcherPath = [exeDir stringByAppendingPathComponent:@"Aed"];
  if (launcherPath && [[NSFileManager defaultManager] isExecutableFileAtPath:launcherPath]) {
    NSTask *task = [[[NSTask alloc] init] autorelease];
    [task setLaunchPath:launcherPath];
    [task setArguments:paths];
    @try {
      [task launch];
    } @catch (NSException *exception) {
    }
  }
}

/*
 * One open event (N files selected in Finder) is one batch: all files open
 * as tabs of one window (this one on a cold start or an idle home/loose window,
 * else one new window); each folder gets a window of its own.
 */
static void handleExternalOpenPaths(NSApplication *app, NSArray<NSString *> *paths) {
  NSMutableArray<NSString *> *files = [NSMutableArray array];
  NSMutableArray<NSString *> *folders = [NSMutableArray array];
  for (NSString *entry in paths) {
    if (!entry || [entry length] == 0) continue;
    NSString *fsPath = entry;
    if ([entry hasPrefix:@"file://"]) {
      NSURL *u = [NSURL URLWithString:entry];
      if (u && [u path]) fsPath = [u path];
    }
    BOOL isDir = NO;
    BOOL exists = [[NSFileManager defaultManager] fileExistsAtPath:fsPath isDirectory:&isDir];
    [(exists && isDir ? folders : files) addObject:entry];
  }
  if ([files count] == 0 && [folders count] == 0) return;
  BOOL isColdInitialOpen =
      (!gHasClaimedInitialTarget && (!gDidFinishLaunching || (CFAbsoluteTimeGetCurrent() - gDidFinishLaunchingTime) < 1.5));
  if (isColdInitialOpen) {
    gHasClaimedInitialTarget = YES;
    if ([files count] > 0) {
      queueForThisWindow(files);
    } else {
      queueForThisWindow(@[ folders[0] ]);
      [folders removeObjectAtIndex:0];
    }
    bringAppToFront(app);
  } else if ([files count] > 0 && !reuseIdleWindowForFiles(app, files)) {
    spawnStandaloneWindow(files);
  }
  for (NSString *folder in folders) {
    spawnStandaloneWindow(@[ folder ]);
  }
}

static BOOL ne_application_openFile(id self, SEL _cmd, NSApplication *app, NSString *filename) {
  handleExternalOpenPaths(app, filename ? @[ filename ] : @[]);
  return YES;
}

static void ne_application_openFiles(id self, SEL _cmd, NSApplication *app, NSArray<NSString *> *filenames) {
  handleExternalOpenPaths(app, filenames ?: @[]);
  [app replyToOpenOrPrint:NSApplicationDelegateReplySuccess];
}

static void ne_application_openURLs(id self, SEL _cmd, NSApplication *app, NSArray<NSURL *> *urls) {
  NSMutableArray<NSString *> *paths = [NSMutableArray array];
  for (NSURL *url in urls) {
    if (![url isFileURL]) continue;
    NSString *frag = [url fragment];
    const char *raw = (frag && [frag length] > 0) ? [[url absoluteString] UTF8String] : [[url path] UTF8String];
    if (raw && raw[0] != '\0') [paths addObject:[NSString stringWithUTF8String:raw]];
  }
  handleExternalOpenPaths(app, paths);
}

// ---- Quit guard (I-016) ---------------------------------------------------

static BOOL aedHasUnsavedEdits(void) {
  for (NSWindow *win in [NSApp windows]) {
    if ([[win title] hasSuffix:kAedEditedTitleSuffix]) return YES;
  }
  return NO;
}

static BOOL aedFindAppQuitItem(NSMenu **outMenu, NSInteger *outIndex) {
  for (NSMenuItem *top in [[NSApp mainMenu] itemArray]) {
    NSMenu *menu = [top submenu];
    for (NSMenuItem *item in [menu itemArray]) {
      NSEventModifierFlags mods = [item keyEquivalentModifierMask] & NSEventModifierFlagDeviceIndependentFlagsMask;
      if (![[item keyEquivalent] isEqualToString:@"q"] || mods != NSEventModifierFlagCommand) continue;
      if ([item action] == @selector(terminate:)) continue;
      *outMenu = menu;
      *outIndex = [menu indexOfItem:item];
      return YES;
    }
  }
  return NO;
}

static BOOL aedChooseAppQuitItem(void) {
  NSMenu *menu = nil;
  NSInteger index = -1;
  if (!aedFindAppQuitItem(&menu, &index)) return NO;
  dispatch_async(dispatch_get_main_queue(), ^{
    NSMenu *latest = nil;
    NSInteger at = -1;
    if (aedFindAppQuitItem(&latest, &at) && at >= 0) [latest performActionForItemAtIndex:at];
  });
  return YES;
}

static BOOL aedConfirmQuitAnyway(void) {
  NSAlert *alert = [[[NSAlert alloc] init] autorelease];
  [alert setMessageText:@"Quit Aed without saving?"];
  [alert setInformativeText:@"Some files have unsaved changes. If Aed is not responding, you can quit anyway and lose them."];
  [alert addButtonWithTitle:@"Cancel"];
  [alert addButtonWithTitle:@"Quit Anyway"];
  return [alert runModal] == NSAlertSecondButtonReturn;
}

static BOOL aedRouteQuitToApp(void) {
  CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
  if (gAedQuitChosenAt > 0 && now - gAedQuitChosenAt < AED_QUIT_RETRY_SECONDS) {
    gAedQuitChosenAt = 0;
    return !aedConfirmQuitAnyway();
  }
  if (!aedChooseAppQuitItem()) return NO;
  gAedQuitChosenAt = now;
  return YES;
}

static BOOL ne_windowShouldClose(id self, SEL _cmd, NSWindow *sender) {
  if ([[sender title] hasSuffix:kAedEditedTitleSuffix] && aedRouteQuitToApp()) return NO;
  return gAedOrigWindowShouldClose ? gAedOrigWindowShouldClose(self, _cmd, sender) : YES;
}

static NSApplicationTerminateReply ne_applicationShouldTerminate(id self, SEL _cmd, NSApplication *app) {
  if (aedHasUnsavedEdits() && aedRouteQuitToApp()) return NSTerminateCancel;
  return gAedOrigShouldTerminate ? gAedOrigShouldTerminate(self, _cmd, app) : NSTerminateNow;
}

static void aedInstallQuitGuard(void) {
  id appDelegate = [NSApp delegate];
  if (appDelegate && !gAedAppDelegateClass) {
    gAedAppDelegateClass = [appDelegate class];
    gAedOrigShouldTerminate = (NSApplicationTerminateReply (*)(id, SEL, NSApplication *))neHookMethod(
        gAedAppDelegateClass, @selector(applicationShouldTerminate:), (IMP)ne_applicationShouldTerminate,
        @protocol(NSApplicationDelegate), "Q@:@");
  }
  if (gAedWindowDelegateClass) return;
  for (NSWindow *win in [NSApp windows]) {
    id winDelegate = [win delegate];
    if (!winDelegate) continue;
    gAedWindowDelegateClass = [winDelegate class];
    gAedOrigWindowShouldClose = (BOOL (*)(id, SEL, NSWindow *))neHookMethod(
        gAedWindowDelegateClass, @selector(windowShouldClose:), (IMP)ne_windowShouldClose,
        @protocol(NSWindowDelegate), "c@:@");
    return;
  }
}

static void attachOpenHandlersToDelegate(id delegate) {
  if (!delegate) return;
  Class cls = [delegate class];
  neHookMethod(cls, @selector(application:openFile:), (IMP)ne_application_openFile,
               @protocol(NSApplicationDelegate), "c@:@@");
  neHookMethod(cls, @selector(application:openFiles:), (IMP)ne_application_openFiles,
               @protocol(NSApplicationDelegate), "v@:@@");
  neHookMethod(cls, @selector(application:openURLs:), (IMP)ne_application_openURLs,
               @protocol(NSApplicationDelegate), "v@:@@");
  neHookMethod(cls, @selector(windowWillResize:toSize:), (IMP)ne_window_willResize_toSize,
               @protocol(NSWindowDelegate), "{CGSize=dd}@:@{CGSize=dd}");
}

static void swizzled_setDelegate(id self, SEL _cmd, id delegate) {
  attachOpenHandlersToDelegate(delegate);
  if (orig_setDelegate) {
    orig_setDelegate(self, _cmd, delegate);
  }
}

__attribute__((constructor))
static void initFinderBridge(void) {
  unsetenv("DYLD_INSERT_LIBRARIES");
  // This process's own queue, recomputed from the pid: an inherited value is never trusted.
  char queueDir[PATH_MAX];
  if (aedQueueDir(getpid(), queueDir, sizeof queueDir) == 0) {
    setenv("AED_OPEN_QUEUE", queueDir, 1);
  } else {
    unsetenv("AED_OPEN_QUEUE");
  }
  const char *initFile = getenv("AED_OPEN_FILE");
  const char *initRoot = getenv("AED_ROOT");
  if ((initFile && initFile[0] != '\0') || (initRoot && initRoot[0] != '\0')) {
    gHasClaimedInitialTarget = YES;
  }
  orig_setDelegate = (void (*)(id, SEL, id))neHookMethod(
      [NSApplication class], @selector(setDelegate:), (IMP)swizzled_setDelegate, NULL, "v@:@");

  NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
  [nc addObserverForName:NSApplicationWillFinishLaunchingNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *note) {
                attachOpenHandlersToDelegate([NSApp delegate]);
                enforceAllWindowsMinSize();
              }];
  [nc addObserverForName:NSApplicationDidFinishLaunchingNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *note) {
                if (!gDidFinishLaunching) {
                  gDidFinishLaunching = YES;
                  gDidFinishLaunchingTime = CFAbsoluteTimeGetCurrent();
                }
                attachOpenHandlersToDelegate([NSApp delegate]);
                aedInstallQuitGuard();
                enforceAllWindowsMinSize();
                bringAppToFront(NSApp);
              }];
  [nc addObserverForName:NSWindowDidBecomeKeyNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *note) {
                enforceWindowMinSize([note object]);
                aedInstallQuitGuard();
              }];
}

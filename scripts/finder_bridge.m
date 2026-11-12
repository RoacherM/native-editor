#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#include <stdlib.h>

#include "aed_paths.h"

#define NE_MIN_WINDOW_WIDTH 760.0
#define NE_MIN_WINDOW_HEIGHT 520.0

static NSSize ne_window_willResize_toSize(id self, SEL _cmd, NSWindow *sender, NSSize frameSize) {
  CGFloat w = frameSize.width < NE_MIN_WINDOW_WIDTH ? NE_MIN_WINDOW_WIDTH : frameSize.width;
  CGFloat h = frameSize.height < NE_MIN_WINDOW_HEIGHT ? NE_MIN_WINDOW_HEIGHT : frameSize.height;
  return NSMakeSize(w, h);
}

static void setOrReplaceMethod(Class cls, SEL sel, IMP imp, const char *types) {
  if (!cls) return;
  if (!class_addMethod(cls, sel, imp, types)) {
    Method m = class_getInstanceMethod(cls, sel);
    if (m) {
      method_setImplementation(m, imp);
    }
  }
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
    setOrReplaceMethod([winDelegate class], @selector(windowWillResize:toSize:), (IMP)ne_window_willResize_toSize, "{CGSize=dd}@:@{CGSize=dd}");
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

static CFAbsoluteTime gDidFinishLaunchingTime = 0.0;
static BOOL gDidFinishLaunching = NO;
static BOOL gHasClaimedInitialTarget = NO;

static void bringAppToFront(NSApplication *app) {
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
 * Cold start: queue the paths for this window. The app reads its own queue
 * (`AED_OPEN_QUEUE`, DESIGN.md「术语与边界」); nothing goes through /tmp or
 * through the environment, which the built-in terminal's shells inherit.
 */
static void queueForThisWindow(NSArray<NSString *> *paths) {
  for (NSString *path in paths) {
    const char *cpath = [path fileSystemRepresentation];
    if (cpath) aedQueueAppend(getpid(), cpath);
  }
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
 * as tabs of one window (this one on a cold start, else one new window);
 * each folder gets a window of its own.
 */
static void handleExternalOpenPaths(NSApplication *app, NSArray<NSString *> *paths) {
  NSMutableArray<NSString *> *files = [NSMutableArray array];
  NSMutableArray<NSString *> *folders = [NSMutableArray array];
  for (NSString *path in paths) {
    if (!path || [path length] == 0) continue;
    BOOL isDir = NO;
    BOOL exists = [[NSFileManager defaultManager] fileExistsAtPath:path isDirectory:&isDir];
    [(exists && isDir ? folders : files) addObject:path];
  }
  if ([files count] == 0 && [folders count] == 0) return;
  BOOL isColdInitialOpen = (!gHasClaimedInitialTarget && (!gDidFinishLaunching || (CFAbsoluteTimeGetCurrent() - gDidFinishLaunchingTime) < 1.5));
  if (isColdInitialOpen) {
    gHasClaimedInitialTarget = YES;
    if ([files count] > 0) {
      queueForThisWindow(files);
    } else {
      queueForThisWindow(@[ folders[0] ]);
      [folders removeObjectAtIndex:0];
    }
    bringAppToFront(app);
  } else {
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
    if ([url isFileURL] && [url path]) [paths addObject:[url path]];
  }
  handleExternalOpenPaths(app, paths);
}

static void attachOpenHandlersToDelegate(id delegate) {
  if (!delegate) return;
  Class cls = [delegate class];
  setOrReplaceMethod(cls, @selector(application:openFile:), (IMP)ne_application_openFile, "c@:@@");
  setOrReplaceMethod(cls, @selector(application:openFiles:), (IMP)ne_application_openFiles, "v@:@@");
  setOrReplaceMethod(cls, @selector(application:openURLs:), (IMP)ne_application_openURLs, "v@:@@");
  setOrReplaceMethod(cls, @selector(windowWillResize:toSize:), (IMP)ne_window_willResize_toSize, "{CGSize=dd}@:@{CGSize=dd}");
}

static void (*orig_setDelegate)(id, SEL, id) = NULL;

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
  Method m = class_getInstanceMethod([NSApplication class], @selector(setDelegate:));
  if (m) {
    orig_setDelegate = (void (*)(id, SEL, id))method_getImplementation(m);
    method_setImplementation(m, (IMP)swizzled_setDelegate);
  }
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
                enforceAllWindowsMinSize();
                bringAppToFront(NSApp);
              }];
  [nc addObserverForName:NSWindowDidBecomeKeyNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *note) {
                enforceWindowMinSize([note object]);
              }];
}

// ---- Quit guard (I-016) ---------------------------------------------------
// Self-contained: its own constructor and observers, no edits to the code
// above. While the window title ends with " — Edited" (App.tsx sets it from
// `windowTitle()` in src/session.ts whenever a tab has unsaved edits), the
// close button and system quits (Dock, logout, `osascript quit`) do not end
// the app: they choose the app's own Quit menu item (⌘Q, `actions.quit()`),
// which asks about the unsaved files and then calls `process.exit`. Without
// the mark, the host's own behavior runs unchanged.

static NSString *const kAedEditedTitleSuffix = @" — Edited";
static BOOL (*gAedOrigWindowShouldClose)(id, SEL, NSWindow *) = NULL;
static NSApplicationTerminateReply (*gAedOrigShouldTerminate)(id, SEL, NSApplication *) = NULL;
static Class gAedWindowDelegateClass = Nil;
static Class gAedAppDelegateClass = Nil;

static BOOL aedHasUnsavedEdits(void) {
  for (NSWindow *win in [NSApp windows]) {
    if ([[win title] hasSuffix:kAedEditedTitleSuffix]) return YES;
  }
  return NO;
}

// The app's Quit menu item (⌘Q, not the `terminate:` role) and the menu it is
// in, or NO when the menu has none.
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

// Chooses the app's Quit item on the next turn of the run loop, looked up
// again then (the app may rebuild its menu meanwhile). NO when the menu has
// none: the caller then lets the host go on as before.
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

// A second close or quit this soon after the last one, with the mark still
// there, means the page may not be answering: ask natively instead.
#define AED_QUIT_RETRY_SECONDS 4.0
static CFAbsoluteTime gAedQuitChosenAt = 0;

static BOOL aedConfirmQuitAnyway(void) {
  NSAlert *alert = [[[NSAlert alloc] init] autorelease];
  [alert setMessageText:@"Quit Aed without saving?"];
  [alert setInformativeText:@"Some files have unsaved changes. If Aed is not responding, you can quit anyway and lose them."];
  [alert addButtonWithTitle:@"Cancel"];
  [alert addButtonWithTitle:@"Quit Anyway"];
  return [alert runModal] == NSAlertSecondButtonReturn;
}

// YES: refuse this close or quit (the app's Quit item will ask about the
// unsaved files). NO: let the host's own behavior run.
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

// Puts `imp` on `cls` for `sel` (of `protocol`, whose types it takes) and
// returns the implementation it replaces (the class's own or an inherited
// one), NULL when there was none.
static IMP aedHookMethod(Class cls, SEL sel, IMP imp, Protocol *protocol) {
  Method m = class_getInstanceMethod(cls, sel);
  IMP orig = m ? method_getImplementation(m) : NULL;
  const char *types = m ? method_getTypeEncoding(m) : protocol_getMethodDescription(protocol, sel, NO, YES).types;
  if (!types) return NULL;
  if (!class_addMethod(cls, sel, imp, types)) method_setImplementation(m, imp);
  return orig;
}

// Hooks each delegate class once; a class seen again keeps its first hook.
static void aedInstallQuitGuard(void) {
  id appDelegate = [NSApp delegate];
  if (appDelegate && !gAedAppDelegateClass) {
    gAedAppDelegateClass = [appDelegate class];
    gAedOrigShouldTerminate = (NSApplicationTerminateReply (*)(id, SEL, NSApplication *))aedHookMethod(
        gAedAppDelegateClass, @selector(applicationShouldTerminate:), (IMP)ne_applicationShouldTerminate, @protocol(NSApplicationDelegate));
  }
  if (gAedWindowDelegateClass) return;
  for (NSWindow *win in [NSApp windows]) {
    id winDelegate = [win delegate];
    if (!winDelegate) continue;
    gAedWindowDelegateClass = [winDelegate class];
    gAedOrigWindowShouldClose = (BOOL (*)(id, SEL, NSWindow *))aedHookMethod(
        gAedWindowDelegateClass, @selector(windowShouldClose:), (IMP)ne_windowShouldClose, @protocol(NSWindowDelegate));
    return;
  }
}

__attribute__((constructor))
static void initQuitGuard(void) {
  NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
  [nc addObserverForName:NSApplicationDidFinishLaunchingNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *note) {
                aedInstallQuitGuard();
              }];
  [nc addObserverForName:NSWindowDidBecomeKeyNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *note) {
                aedInstallQuitGuard();
              }];
}

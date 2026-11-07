#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#include <stdlib.h>

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

static void recordOpenedFilePath(NSString *path) {
  if (!path || [path length] == 0) return;
  const char *cpath = [path fileSystemRepresentation];
  if (!cpath) return;
  BOOL isDir = NO;
  if ([[NSFileManager defaultManager] fileExistsAtPath:path isDirectory:&isDir] && isDir) {
    setenv("AED_ROOT", cpath, 1);
  } else {
    setenv("AED_OPEN_FILE", cpath, 1);
  }
  FILE *fp = fopen("/tmp/aed-open.queue", "a");
  if (fp) {
    fprintf(fp, "%s\n", cpath);
    fclose(fp);
  }
}

static BOOL ne_application_openFile(id self, SEL _cmd, NSApplication *app, NSString *filename) {
  recordOpenedFilePath(filename);
  bringAppToFront(app);
  return YES;
}

static void ne_application_openFiles(id self, SEL _cmd, NSApplication *app, NSArray<NSString *> *filenames) {
  for (NSString *filename in filenames) {
    recordOpenedFilePath(filename);
  }
  bringAppToFront(app);
  [app replyToOpenOrPrint:NSApplicationDelegateReplySuccess];
}

static void ne_application_openURLs(id self, SEL _cmd, NSApplication *app, NSArray<NSURL *> *urls) {
  for (NSURL *url in urls) {
    if ([url isFileURL]) {
      recordOpenedFilePath([url path]);
    }
  }
  bringAppToFront(app);
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
                enforceAllWindowsMinSize();
              }];
  [nc addObserverForName:NSWindowDidBecomeKeyNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *note) {
                enforceWindowMinSize([note object]);
              }];
}

#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#include <stdlib.h>

static void recordOpenedFilePath(NSString *path) {
  if (!path || [path length] == 0) return;
  const char *cpath = [path fileSystemRepresentation];
  if (!cpath) return;
  setenv("NATIVE_EDITOR_OPEN_FILE", cpath, 1);
  NSString *dir = [path stringByDeletingLastPathComponent];
  if (dir && [dir length] > 0) {
    setenv("NATIVE_EDITOR_ROOT", [dir fileSystemRepresentation], 1);
  }
  FILE *fp = fopen("/tmp/native-editor-open.queue", "a");
  if (fp) {
    fprintf(fp, "%s\n", cpath);
    fclose(fp);
  }
}

static BOOL ne_application_openFile(id self, SEL _cmd, NSApplication *app, NSString *filename) {
  recordOpenedFilePath(filename);
  [app activateIgnoringOtherApps:YES];
  return YES;
}

static void ne_application_openFiles(id self, SEL _cmd, NSApplication *app, NSArray<NSString *> *filenames) {
  for (NSString *filename in filenames) {
    recordOpenedFilePath(filename);
  }
  [app activateIgnoringOtherApps:YES];
  [app replyToOpenOrPrint:NSApplicationDelegateReplySuccess];
}

static void ne_application_openURLs(id self, SEL _cmd, NSApplication *app, NSArray<NSURL *> *urls) {
  for (NSURL *url in urls) {
    if ([url isFileURL]) {
      recordOpenedFilePath([url path]);
    }
  }
  [app activateIgnoringOtherApps:YES];
}

static void attachOpenHandlersToDelegate(id delegate) {
  if (!delegate) return;
  Class cls = [delegate class];
  class_addMethod(cls, @selector(application:openFile:), (IMP)ne_application_openFile, "c@:@@");
  class_addMethod(cls, @selector(application:openFiles:), (IMP)ne_application_openFiles, "v@:@@");
  class_addMethod(cls, @selector(application:openURLs:), (IMP)ne_application_openURLs, "v@:@@");
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
  [[NSNotificationCenter defaultCenter]
      addObserverForName:NSApplicationWillFinishLaunchingNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *note) {
                attachOpenHandlersToDelegate([NSApp delegate]);
              }];
}

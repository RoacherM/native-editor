#import <CoreServices/CoreServices.h>
#import <Foundation/Foundation.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static BOOL bindUTIOnce(NSString *uti, NSString *bundleId, NSMutableSet<NSString *> *seen, NSUInteger *skippedCount) {
  if (!uti || [uti length] == 0) return NO;
  NSString *key = [uti lowercaseString];
  if ([seen containsObject:key]) return NO;
  [seen addObject:key];

  CFStringRef currentRef = LSCopyDefaultRoleHandlerForContentType(
      (__bridge CFStringRef)uti, kLSRolesAll);
  if (currentRef) {
    NSString *current = CFBridgingRelease(currentRef);
    if (current && [current caseInsensitiveCompare:bundleId] == NSOrderedSame) {
      (*skippedCount)++;
      return NO;
    }
  }

  LSSetDefaultRoleHandlerForContentType(
      (__bridge CFStringRef)uti,
      kLSRolesAll,
      (__bridge CFStringRef)bundleId);
  return YES;
}

static BOOL bindExtensionOnce(NSString *ext, NSString *bundleId, NSMutableSet<NSString *> *seen, NSUInteger *skippedCount, BOOL allowDynamic) {
  UTType *type = [UTType typeWithFilenameExtension:ext];
  if (!type || !type.identifier) return NO;
  if (!allowDynamic && [type.identifier hasPrefix:@"dyn."]) return NO;
  return bindUTIOnce(type.identifier, bundleId, seen, skippedCount);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *bundleId = @"dev.byronwayne.aed";
    NSMutableSet<NSString *> *seen = [NSMutableSet set];
    NSUInteger updatedCount = 0;
    NSUInteger skippedCount = 0;
    BOOL includeCode = NO;
    NSMutableArray<NSString *> *customExts = [NSMutableArray array];

    for (int i = 1; i < argc; i++) {
      NSString *arg = [NSString stringWithUTF8String:argv[i]];
      if ([arg isEqualToString:@"--all"] || [arg isEqualToString:@"--all-code"]) {
        includeCode = YES;
      } else if (![arg hasPrefix:@"-"]) {
        NSString *clean = [arg hasPrefix:@"."] ? [arg substringFromIndex:1] : arg;
        if ([clean length] > 0) [customExts addObject:clean];
      }
    }

    if ([customExts count] > 0) {
      for (NSString *ext in customExts) {
        if (bindExtensionOnce(ext, bundleId, seen, &skippedCount, YES)) {
          updatedCount++;
        }
      }
    } else {
      // Core document & data UTIs (deduplicated, skips already-bound UTIs)
      NSArray<NSString *> *coreUtis = @[
        @"net.daringfireball.markdown",
        @"dev.byronwayne.aed.mermaid",
        @"dev.byronwayne.aed.jsonl",
        @"public.json",
        @"public.comma-separated-values-text",
        @"public.tab-separated-values-text",
        @"public.plain-text",
        @"public.patch-file"
      ];
      for (NSString *uti in coreUtis) {
        if (bindUTIOnce(uti, bundleId, seen, &skippedCount)) {
          updatedCount++;
        }
      }

      if (includeCode) {
        NSArray<NSString *> *codeUtis = @[
          @"public.yaml",
          @"org.toml.toml",
          @"public.xml",
          @"public.source-code",
          @"public.shell-script",
          @"public.python-script",
          @"com.netscape.javascript-source",
          @"public.css"
        ];
        for (NSString *uti in codeUtis) {
          if (bindUTIOnce(uti, bundleId, seen, &skippedCount)) {
            updatedCount++;
          }
        }
      }
    }

    printf("Aed default handlers: %lu newly requested, %lu already authorized (skipped).\n",
           (unsigned long)updatedCount,
           (unsigned long)skippedCount);
  }
  return 0;
}

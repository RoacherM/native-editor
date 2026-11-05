#import <CoreServices/CoreServices.h>
#import <Foundation/Foundation.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static void bindUTI(NSString *uti, NSString *bundleId) {
  if (!uti || [uti length] == 0) return;
  LSSetDefaultRoleHandlerForContentType(
      (__bridge CFStringRef)uti,
      kLSRolesAll,
      (__bridge CFStringRef)bundleId);
}

static void bindExtension(NSString *ext, NSString *bundleId) {
  UTType *type = [UTType typeWithFilenameExtension:ext];
  if (type && type.identifier) {
    bindUTI(type.identifier, bundleId);
  }
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *bundleId = @"dev.byronwayne.nativeeditor";

    NSArray<NSString *> *utis = @[
      @"net.daringfireball.markdown",
      @"public.markdown",
      @"public.plain-text",
      @"public.utf8-plain-text",
      @"public.text",
      @"public.json",
      @"public.comma-separated-values-text",
      @"public.tab-separated-values-text",
      @"public.yaml",
      @"org.yaml.yaml",
      @"org.toml.toml",
      @"public.xml",
      @"public.source-code",
      @"public.script",
      @"public.shell-script",
      @"public.zsh-script",
      @"public.bash-script",
      @"public.python-script",
      @"public.ruby-script",
      @"public.perl-script",
      @"public.php-script",
      @"public.c-source",
      @"public.c-header",
      @"public.c-plus-plus-source",
      @"public.c-plus-plus-header",
      @"public.objective-c-source",
      @"public.swift-source",
      @"com.sun.java-source",
      @"com.netscape.javascript-source",
      @"public.css",
      @"public.patch-file",
      @"public.log",
      @"dev.byronwayne.nativeeditor.mermaid",
      @"dev.byronwayne.nativeeditor.jsonl"
    ];

    for (NSString *uti in utis) {
      bindUTI(uti, bundleId);
    }

    NSArray<NSString *> *extensions = @[
      @"md", @"markdown", @"mdx", @"txt", @"text", @"log",
      @"mmd", @"mermaid",
      @"json", @"jsonl", @"ndjson", @"csv", @"tsv",
      @"yaml", @"yml", @"toml", @"ini", @"conf", @"cfg", @"env", @"xml",
      @"diff", @"patch",
      @"ts", @"tsx", @"js", @"jsx", @"mjs", @"cjs",
      @"py", @"rs", @"go", @"c", @"h", @"cpp", @"hpp", @"cc",
      @"swift", @"java", @"kt", @"rb", @"php", @"lua", @"zig",
      @"sql", @"graphql", @"gql", @"proto", @"css", @"scss", @"less",
      @"sh", @"bash", @"zsh", @"fish"
    ];

    for (NSString *ext in extensions) {
      bindExtension(ext, bundleId);
    }

    printf("Registered %s as default handler for %lu UTIs and %lu file extensions.\n",
           [bundleId UTF8String],
           (unsigned long)[utis count],
           (unsigned long)[extensions count]);
  }
  return 0;
}

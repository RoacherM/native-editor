#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void recordArgPath(const char *arg) {
  if (!arg || arg[0] == '-' || arg[0] == '\0') return;
  char resolved[PATH_MAX];
  if (!realpath(arg, resolved)) return;
  struct stat st;
  if (stat(resolved, &st) != 0) return;
  if (S_ISDIR(st.st_mode)) {
    setenv("NATIVE_EDITOR_ROOT", resolved, 1);
  } else if (S_ISREG(st.st_mode)) {
    setenv("NATIVE_EDITOR_OPEN_FILE", resolved, 1);
    FILE *fp = fopen("/tmp/native-editor-open.queue", "a");
    if (fp) {
      fprintf(fp, "%s\n", resolved);
      fclose(fp);
    }
  }
}

int main(int argc, char *argv[]) {
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--workspace") == 0 && i + 1 < argc) {
      setenv("NATIVE_EDITOR_ROOT", argv[i + 1], 1);
      i++;
    } else {
      recordArgPath(argv[i]);
    }
  }

  char exePath[PATH_MAX];
  uint32_t size = sizeof(exePath);
  if (_NSGetExecutablePath(exePath, &size) != 0) return 1;

  char realExe[PATH_MAX];
  if (!realpath(exePath, realExe)) strncpy(realExe, exePath, sizeof(realExe));

  char *lastSlash = strrchr(realExe, '/');
  if (!lastSlash) return 1;
  *lastSlash = '\0';

  char dylibPath[PATH_MAX];
  snprintf(dylibPath, sizeof(dylibPath), "%s/libFinderBridge.dylib", realExe);
  setenv("DYLD_INSERT_LIBRARIES", dylibPath, 1);

  char corePath[PATH_MAX];
  snprintf(corePath, sizeof(corePath), "%s/NativeEditorCore", realExe);

  char *newArgv[2] = {corePath, NULL};
  execv(corePath, newArgv);
  perror("execv NativeEditorCore");
  return 1;
}

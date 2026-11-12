#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "aed_paths.h"

#define MAX_OPEN_FILES 64

static int isDigitsOnly(const char *s) {
  if (!s || *s == '\0') return 0;
  for (; *s; s++) {
    if (*s < '0' || *s > '9') return 0;
  }
  return 1;
}

static int hexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* Decode %XX in place; a malformed escape, or %00 (which would cut the path short), stays as written. */
static void percentDecode(char *s) {
  char *out = s;
  for (char *in = s; *in; in++) {
    int hi = in[0] == '%' ? hexValue(in[1]) : -1;
    int lo = hi >= 0 ? hexValue(in[2]) : -1;
    if (lo >= 0 && (hi | lo) != 0) {
      *out++ = (char)(hi * 16 + lo);
      in += 2;
    } else {
      *out++ = *in;
    }
  }
  *out = '\0';
}

/*
 * Turn an argument into a path in `out`: `file://[localhost]/p%20q#L3` becomes
 * `/p q` (the fragment goes to `fragment`); a plain path is copied as is.
 */
static int argToPath(const char *arg, char *out, size_t size, char *fragment, size_t fragSize) {
  fragment[0] = '\0';
  if (strncmp(arg, "file://", 7) != 0) {
    return snprintf(out, size, "%s", arg) < (int)size ? 0 : -1;
  }
  const char *rest = arg + 7;
  if (strncmp(rest, "localhost/", 10) == 0) rest += 9;
  if (rest[0] != '/') return -1;
  if (snprintf(out, size, "%s", rest) >= (int)size) return -1;
  char *hash = strchr(out, '#');
  if (hash) {
    snprintf(fragment, fragSize, "%s", hash);
    *hash = '\0';
  }
  percentDecode(out);
  return 0;
}

/* Strip `#L<line>[C<col>|-L<n>]` from `buf` (at `buf` itself too: a URL fragment); 1 when stripped. */
static int stripHashLine(char *buf, long *line, long *col) {
  char *hashL = strstr(buf, "#L");
  if (!hashL || hashL[2] < '0' || hashL[2] > '9') return 0;
  char *end = NULL;
  *line = strtol(hashL + 2, &end, 10);
  if (end && *end == 'C') *col = strtol(end + 1, NULL, 10);
  *hashL = '\0';
  return 1;
}

/* Strip `#L<line>[C<col>|-L<n>]` and `:line(:col)` from the end of `buf`; report line/col (0 when absent). */
static void stripLineColSuffix(char *buf, long *line, long *col) {
  *line = 0;
  *col = 0;
  if (strstr(buf, "#L") != buf && stripHashLine(buf, line, col)) return;
  char *lastColon = strrchr(buf, ':');
  if (!lastColon || lastColon == buf || !isDigitsOnly(lastColon + 1)) return;
  long last = strtol(lastColon + 1, NULL, 10);
  *lastColon = '\0';
  char *prevColon = strrchr(buf, ':');
  if (prevColon && prevColon != buf && isDigitsOnly(prevColon + 1)) {
    *line = strtol(prevColon + 1, NULL, 10);
    *col = last;
    *prevColon = '\0';
  } else {
    *line = last;
  }
}

typedef struct {
  char *files[MAX_OPEN_FILES];
  int fileCount;
  char *root;
} OpenTargets;

/*
 * Resolve one argument. The literal path wins when it exists (a file may be
 * named `notes:12`); only otherwise is a line suffix stripped, and then the
 * line travels on as `:line(:col)` for the app to jump to.
 */
static void recordArgPath(const char *arg, OpenTargets *targets) {
  if (!arg || arg[0] == '-' || arg[0] == '\0') return;
  char candidate[PATH_MAX], fragment[64], resolved[PATH_MAX];
  if (argToPath(arg, candidate, sizeof candidate, fragment, sizeof fragment) != 0) return;
  long line = 0, col = 0;
  // A file URL's `#L3` is always a fragment: `#` in a name is written %23.
  stripHashLine(fragment, &line, &col);
  if (!realpath(candidate, resolved)) {
    long suffixLine = 0, suffixCol = 0;
    stripLineColSuffix(candidate, &suffixLine, &suffixCol);
    if (!realpath(candidate, resolved)) return;
    if (line == 0) {
      line = suffixLine;
      col = suffixCol;
    }
  }
  struct stat st;
  if (stat(resolved, &st) != 0) return;
  if (S_ISDIR(st.st_mode)) {
    if (!targets->root) targets->root = strdup(resolved);
    return;
  }
  if (!S_ISREG(st.st_mode) || targets->fileCount >= MAX_OPEN_FILES) return;
  char withLine[PATH_MAX + 48];
  if (line > 0 && col > 0) {
    snprintf(withLine, sizeof withLine, "%s:%ld:%ld", resolved, line, col);
  } else if (line > 0) {
    snprintf(withLine, sizeof withLine, "%s:%ld", resolved, line);
  } else {
    snprintf(withLine, sizeof withLine, "%s", resolved);
  }
  targets->files[targets->fileCount++] = strdup(withLine);
}

/*
 * Files win over folders: the first file opens via AED_OPEN_FILE, the rest go
 * into this process's own queue (same pid after execv), so one window opens
 * them all as tabs. Without files, the first folder becomes the workspace.
 */
static void exportTargets(const OpenTargets *targets) {
  if (targets->fileCount == 0) {
    if (targets->root) setenv("AED_ROOT", targets->root, 1);
    return;
  }
  unsetenv("AED_ROOT");
  unsetenv("NATIVE_EDITOR_ROOT");
  setenv("AED_OPEN_FILE", targets->files[0], 1);
  for (int i = 1; i < targets->fileCount; i++) {
    aedQueueAppend(getpid(), targets->files[i]);
  }
}

int main(int argc, char *argv[]) {
  pid_t self = getpid();
  aedPrepareQueue(self);
  char queueDir[PATH_MAX];
  if (aedQueueDir(self, queueDir, sizeof queueDir) == 0) setenv("AED_OPEN_QUEUE", queueDir, 1);

  OpenTargets targets = {{0}, 0, NULL};
  const char *workspace = NULL;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--workspace") == 0 && i + 1 < argc) {
      workspace = argv[++i];
    } else {
      recordArgPath(argv[i], &targets);
    }
  }
  if (workspace) setenv("AED_ROOT", workspace, 1);
  exportTargets(&targets);

  char exePath[PATH_MAX];
  uint32_t size = sizeof(exePath);
  if (_NSGetExecutablePath(exePath, &size) != 0) return 1;

  char realExe[PATH_MAX];
  if (!realpath(exePath, realExe)) {
    strncpy(realExe, exePath, sizeof(realExe) - 1);
    realExe[sizeof(realExe) - 1] = '\0';
  }

  char *lastSlash = strrchr(realExe, '/');
  if (!lastSlash) return 1;
  *lastSlash = '\0';

  char dylibPath[PATH_MAX];
  snprintf(dylibPath, sizeof(dylibPath), "%s/libFinderBridge.dylib", realExe);
  setenv("DYLD_INSERT_LIBRARIES", dylibPath, 1);

  char corePath[PATH_MAX];
  snprintf(corePath, sizeof(corePath), "%s/AedCore", realExe);

  char *newArgv[2] = {corePath, NULL};
  execv(corePath, newArgv);
  perror("execv AedCore");
  return 1;
}

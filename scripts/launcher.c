#include <ctype.h>
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
  char *query = strchr(out, '?');
  if (query) *query = '\0';
  percentDecode(out);
  return 0;
}

/* Parse `#L<line>`, `#L<line>C<col>` or `#L<line>-[L]<n>` starting at `s`; 1 when matched. */
static int parseHashLine(const char *s, long *line, long *col) {
  if (!s || s[0] != '#' || (s[1] != 'L' && s[1] != 'l') || !isdigit((unsigned char)s[2])) return 0;
  char *end = NULL;
  long l = strtol(s + 2, &end, 10), c = 0;
  if (l <= 0) return 0;
  if ((*end == 'C' || *end == 'c') && isdigit((unsigned char)end[1])) {
    c = strtol(end + 1, &end, 10);
  } else if (*end == '-') {
    const char *n = end + 1 + (end[1] == 'L' || end[1] == 'l');
    if (isdigit((unsigned char)*n)) strtol(n, &end, 10);
  }
  if (*end != '\0') return 0;
  *line = l;
  *col = c;
  return 1;
}

/*
 * Resolve `candidate` to an existing path in `resolved` (most literal first):
 * 1) `candidate` as written (a real file named `foo:10` wins)
 * 2) without a trailing `#L<line>[C<col>]`
 * 3) without one trailing `:<line>` (`foo:10:20` opens `foo:10` at line 20)
 * 4) without `:<line>:<col>` (`a.ts:12:3` opens `a.ts` at line 12, col 3)
 */
static int resolveCandidate(char *candidate, const char *fragment, char *resolved, long *line, long *col) {
  *line = 0;
  *col = 0;
  parseHashLine(fragment, line, col);
  if (realpath(candidate, resolved)) return 0;

  char *hash = strrchr(candidate, '#');
  long sLine = 0, sCol = 0;
  if (hash && hash > candidate && parseHashLine(hash, &sLine, &sCol)) {
    *hash = '\0';
    if (!realpath(candidate, resolved)) return -1;
    if (*line == 0) {
      *line = sLine;
      *col = sCol;
    }
    return 0;
  }

  char *lastColon = strrchr(candidate, ':');
  if (!lastColon || lastColon == candidate || !isDigitsOnly(lastColon + 1)) return -1;
  long last = strtol(lastColon + 1, NULL, 10);
  *lastColon = '\0';
  if (last > 0 && realpath(candidate, resolved)) {
    if (*line == 0) {
      *line = last;
      *col = 0;
    }
    return 0;
  }

  char *prevColon = strrchr(candidate, ':');
  if (!prevColon || prevColon == candidate || !isDigitsOnly(prevColon + 1)) return -1;
  long prev = strtol(prevColon + 1, NULL, 10);
  *prevColon = '\0';
  if (prev > 0 && realpath(candidate, resolved)) {
    if (*line == 0) {
      *line = prev;
      *col = last;
    }
    return 0;
  }
  return -1;
}

static int isUnescapedUriPathChar(unsigned char c) {
  return isalnum(c) || c == '/' || c == '-' || c == '_' || c == '.' || c == '~';
}

/*
 * Plain path when `line <= 0`; otherwise an unambiguous `file://<encoded>#L<line>[C<col>]`
 * URI so colons or `#` inside real filenames never collide with location suffixes.
 */
static int formatTargetRef(const char *resolved, long line, long col, char *out, size_t size) {
  if (line <= 0) {
    int n = snprintf(out, size, "%s", resolved);
    return (n > 0 && (size_t)n < size) ? 0 : -1;
  }
  if (size < 16) return -1;
  memcpy(out, "file://", 7);
  size_t pos = 7;
  static const char hex[] = "0123456789ABCDEF";
  for (const unsigned char *p = (const unsigned char *)resolved; *p; p++) {
    if (isUnescapedUriPathChar(*p)) {
      if (pos + 1 >= size) return -1;
      out[pos++] = (char)*p;
    } else {
      if (pos + 3 >= size) return -1;
      out[pos++] = '%';
      out[pos++] = hex[*p >> 4];
      out[pos++] = hex[*p & 0x0F];
    }
  }
  int tail = col > 0 ? snprintf(out + pos, size - pos, "#L%ldC%ld", line, col)
                     : snprintf(out + pos, size - pos, "#L%ld", line);
  return (tail > 0 && pos + (size_t)tail < size) ? 0 : -1;
}

typedef struct {
  char *files[MAX_OPEN_FILES];
  int fileCount;
  char *root;
} OpenTargets;

static void recordArgPath(const char *arg, OpenTargets *targets) {
  if (!arg || arg[0] == '-' || arg[0] == '\0') return;
  char candidate[PATH_MAX], fragment[64], resolved[PATH_MAX];
  if (argToPath(arg, candidate, sizeof candidate, fragment, sizeof fragment) != 0) return;
  long line = 0, col = 0;
  if (resolveCandidate(candidate, fragment, resolved, &line, &col) != 0) return;

  struct stat st;
  if (stat(resolved, &st) != 0) return;
  if (S_ISDIR(st.st_mode)) {
    if (!targets->root) targets->root = strdup(resolved);
    return;
  }
  if (!S_ISREG(st.st_mode) || targets->fileCount >= MAX_OPEN_FILES) return;
  char formatted[PATH_MAX * 3 + 64];
  if (formatTargetRef(resolved, line, col, formatted, sizeof formatted) != 0) return;
  targets->files[targets->fileCount++] = strdup(formatted);
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
  // Only this launch's arguments say what to open: a shell in an Aed terminal
  // (and `open -n` from finder_bridge.m) inherits the window's own values.
  static const char *const inherited[] = {"AED_OPEN_FILE", "AED_ROOT", "AED_OPEN_QUEUE",
                                          "NATIVE_EDITOR_OPEN_FILE", "NATIVE_EDITOR_ROOT"};
  for (size_t i = 0; i < sizeof inherited / sizeof *inherited; i++) unsetenv(inherited[i]);
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

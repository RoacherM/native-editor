#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int isDigitsOnly(const char *s) {
  if (!s || *s == '\0') return 0;
  for (; *s; s++) {
    if (*s < '0' || *s > '9') return 0;
  }
  return 1;
}

static void stripLineColSuffix(char *buf) {
  char *hashL = strstr(buf, "#L");
  if (hashL && hashL != buf && isDigitsOnly(hashL + 2)) {
    *hashL = '\0';
  }
  char *lastColon = strrchr(buf, ':');
  if (!lastColon || lastColon == buf) return;
  if (!isDigitsOnly(lastColon + 1)) return;
  *lastColon = '\0';
  char *prevColon = strrchr(buf, ':');
  if (prevColon && prevColon != buf && isDigitsOnly(prevColon + 1)) {
    *prevColon = '\0';
  }
}

static void recordArgPath(const char *arg) {
  if (!arg || arg[0] == '-' || arg[0] == '\0') return;
  if (strncmp(arg, "file://", 7) == 0) {
    arg += 7;
  }
  char resolved[PATH_MAX];
  if (!realpath(arg, resolved)) {
    char stripped[PATH_MAX];
    strncpy(stripped, arg, sizeof(stripped) - 1);
    stripped[sizeof(stripped) - 1] = '\0';
    stripLineColSuffix(stripped);
    if (!realpath(stripped, resolved)) return;
  }
  struct stat st;
  if (stat(resolved, &st) != 0) return;
  if (S_ISDIR(st.st_mode)) {
    setenv("AED_ROOT", resolved, 1);
  } else if (S_ISREG(st.st_mode)) {
    setenv("AED_OPEN_FILE", resolved, 1);
    FILE *fp = fopen("/tmp/aed-open.queue", "a");
    if (fp) {
      fprintf(fp, "%s\n", resolved);
      fclose(fp);
    }
  }
}

int main(int argc, char *argv[]) {
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--workspace") == 0 && i + 1 < argc) {
      setenv("AED_ROOT", argv[i + 1], 1);
      i++;
    } else {
      recordArgPath(argv[i]);
    }
  }

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

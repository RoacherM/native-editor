// Per-user cache directory and per-process Finder open queue, shared by
// launcher.c and finder_bridge.m. DESIGN.md「术语与边界」.
//
// Layout: ~/Library/Caches/dev.byronwayne.aed/open-<pid>/<seq>.path, one file
// per path to open, written as .<seq>.tmp (O_CREAT|O_EXCL|O_NOFOLLOW, 0600)
// and renamed into place with RENAME_EXCL so the reader never sees half a file.
// The app (src/workspace.ts consumeFinderOpenQueue) reads and deletes them.
#ifndef AED_PATHS_H
#define AED_PATHS_H

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pwd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define AED_BUNDLE_ID "dev.byronwayne.aed"
#define AED_QUEUE_PREFIX "open-"

static int aedFormat(char *out, size_t size, const char *fmt, const char *a, const char *b) {
  int n = snprintf(out, size, fmt, a, b);
  return (n > 0 && (size_t)n < size) ? 0 : -1;
}

/* ~/Library/Caches (HOME first, as the app's os.homedir() does). */
static int aedCachesRoot(char *out, size_t size) {
  const char *home = getenv("HOME");
  if (!home || home[0] != '/') {
    struct passwd *pw = getpwuid(getuid());
    home = pw ? pw->pw_dir : NULL;
  }
  if (!home || home[0] != '/') return -1;
  return aedFormat(out, size, "%s/%s", home, "Library/Caches");
}

static int aedCacheDir(char *out, size_t size) {
  char root[PATH_MAX];
  if (aedCachesRoot(root, sizeof root) != 0) return -1;
  return aedFormat(out, size, "%s/%s", root, AED_BUNDLE_ID);
}

static int aedQueueDir(pid_t pid, char *out, size_t size) {
  char cache[PATH_MAX];
  if (aedCacheDir(cache, sizeof cache) != 0) return -1;
  int n = snprintf(out, size, "%s/" AED_QUEUE_PREFIX "%d", cache, (int)pid);
  return (n > 0 && (size_t)n < size) ? 0 : -1;
}

/*
 * Open `dir` as a private directory: create it 0700 when missing; accept an
 * existing one only when it is a real directory (not a symlink) owned by this
 * user, and make it 0700. Returns an O_DIRECTORY fd or -1.
 */
static int aedOpenPrivateDir(const char *dir) {
  if (mkdir(dir, 0700) != 0 && errno != EEXIST) return -1;
  int fd = open(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != getuid() ||
      ((st.st_mode & 0777) != 0700 && fchmod(fd, 0700) != 0)) {
    close(fd);
    return -1;
  }
  return fd;
}

/* Create ~/Library/Caches/dev.byronwayne.aed (and ~/Library/Caches) privately. */
static int aedOpenCacheDir(void) {
  char root[PATH_MAX], cache[PATH_MAX];
  if (aedCachesRoot(root, sizeof root) != 0 || aedCacheDir(cache, sizeof cache) != 0) return -1;
  if (mkdir(root, 0700) != 0 && errno != EEXIST) return -1;
  return aedOpenPrivateDir(cache);
}

static int aedIsDotEntry(const char *name) {
  return name[0] == '.' && (name[1] == '\0' || (name[1] == '.' && name[2] == '\0'));
}

/* Unlink every entry of the directory `dirfd` (symlinks themselves; never followed). Closes dirfd. */
static void aedEmptyDir(int dirfd) {
  DIR *d = fdopendir(dirfd);
  if (!d) {
    close(dirfd);
    return;
  }
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (!aedIsDotEntry(e->d_name)) unlinkat(dirfd, e->d_name, 0);
  }
  closedir(d);
}

/* The pid in an `open-<pid>` name, or 0 when the name is not one. */
static pid_t aedQueuePid(const char *name) {
  size_t plen = strlen(AED_QUEUE_PREFIX);
  if (strncmp(name, AED_QUEUE_PREFIX, plen) != 0 || name[plen] == '\0') return 0;
  char *end = NULL;
  long pid = strtol(name + plen, &end, 10);
  if (!end || *end != '\0' || pid <= 0 || pid > INT_MAX) return 0;
  return (pid_t)pid;
}

static void aedRemoveQueueAt(int cachefd, const char *name) {
  int qfd = openat(cachefd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (qfd >= 0) aedEmptyDir(qfd);
  // Not a directory (a planted symlink): remove the link itself, never its target.
  if (unlinkat(cachefd, name, AT_REMOVEDIR) != 0 && errno == ENOTDIR) unlinkat(cachefd, name, 0);
}

/*
 * Launcher start: remove the queues of processes that no longer exist, and
 * empty this pid's queue (left by an earlier process with the same pid), so
 * a new window never opens another window's leftovers.
 */
__attribute__((unused)) static void aedPrepareQueue(pid_t self) {
  int cachefd = aedOpenCacheDir();
  if (cachefd < 0) return;
  int scanfd = dup(cachefd);
  DIR *d = scanfd >= 0 ? fdopendir(scanfd) : NULL;
  if (d) {
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
      pid_t pid = aedQueuePid(e->d_name);
      if (pid == 0) continue;
      if (pid == self || (kill(pid, 0) != 0 && errno == ESRCH)) aedRemoveQueueAt(cachefd, e->d_name);
    }
    closedir(d);
  } else if (scanfd >= 0) {
    close(scanfd);
  }
  close(cachefd);
}

static int aedWriteAll(int fd, const char *buf, size_t len) {
  while (len > 0) {
    ssize_t n = write(fd, buf, len);
    if (n < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    buf += n;
    len -= (size_t)n;
  }
  return 0;
}

/* Write one entry into the open queue directory `qfd`. 0 on success. */
static int aedQueueWriteEntry(int qfd, const char *path) {
  for (unsigned seq = 1; seq < 100000; seq++) {
    char tmp[32], dst[32];
    snprintf(tmp, sizeof tmp, ".%u.tmp", seq);
    snprintf(dst, sizeof dst, "%u.path", seq);
    int fd = openat(qfd, tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) {
      if (errno == EEXIST) continue;
      return -1;
    }
    int failed = aedWriteAll(fd, path, strlen(path));
    failed = close(fd) != 0 || failed;
    if (!failed && renameatx_np(qfd, tmp, qfd, dst, RENAME_EXCL) == 0) return 0;
    int err = errno;
    unlinkat(qfd, tmp, 0);
    if (failed || err != EEXIST) return -1;
  }
  return -1;
}

/* Append `path` to this process's queue (`<cache>/open-<pid>/`). 0 on success. */
static int aedQueueAppend(pid_t pid, const char *path) {
  if (!path || path[0] == '\0') return -1;
  char dir[PATH_MAX];
  if (aedQueueDir(pid, dir, sizeof dir) != 0) return -1;
  int cachefd = aedOpenCacheDir();
  if (cachefd < 0) return -1;
  close(cachefd);
  int qfd = aedOpenPrivateDir(dir);
  if (qfd < 0) return -1;
  int rc = aedQueueWriteEntry(qfd, path);
  close(qfd);
  return rc;
}

#endif

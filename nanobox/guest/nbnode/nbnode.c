/* nbnode.c — nanobox guest-side "node" shim ("system node on the browser's V8").
 *
 * Installed as /usr/local/bin/node inside the container.  It does NOT run JavaScript: it opens the
 * host channel (/dev/hvc1, a virtio console), announces itself with HELLO (argv, env, cwd, tty
 * geometry) and then serves the binary request/reply protocol defined in web/native/proto.js —
 * the host-side worker runs the JS on the browser's V8 and uses this process as its syscall arm
 * (fs, stdio, tty, child processes, signals).
 *
 * Wire format (little-endian):  u32 len | u8 op | u32 id | payload   (see proto.js for the ops).
 *
 * Build: ./build.sh            (static musl x86-64 via docker alpine  -> ./nbnode)
 *        ./build.sh host       (native gcc, for the socketpair unit test -> ./nbnode-host)
 * Env:   NBNODE_DEV=/dev/hvc1  channel device;  NBNODE_FD=N  use an already-open fd as the channel
 *        NBNODE_NO_STDIN=1  never read fd 0 (background service beside a foreground CLI)
 *        NBNODE_DEBUG=1 trace to the host as LOG frames, =2 trace to stderr, =0 off
 *        (compiling with -DNBNODE_DEBUG turns stderr tracing on by default).
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/signalfd.h>
#include <sys/stat.h>
#include <sys/wait.h>

enum {
  OP_HELLO = 0, OP_OPEN = 1, OP_CLOSE = 2, OP_READ = 3, OP_WRITE = 4, OP_STAT = 5, OP_LSTAT = 6, OP_FSTAT = 7,
  OP_READDIR = 8, OP_READLINK = 9, OP_MKDIR = 10, OP_UNLINK = 11, OP_RMDIR = 12, OP_RENAME = 13, OP_ACCESS = 14,
  OP_CHMOD = 15, OP_REALPATH = 16, OP_UTIMES = 17, OP_TRUNCATE = 18, OP_FTRUNCATE = 19, OP_SYMLINK = 20,
  OP_LINK = 21, OP_FSYNC = 22, OP_CHOWN = 23, OP_FCHMOD = 24,
  OP_STDOUT = 30, OP_STDERR = 31, OP_EXIT = 32, OP_TTY_RAW = 33, OP_TTY_SIZE = 34,
  OP_SPAWN = 40, OP_CHILD_STDIN = 41, OP_KILL = 42, OP_GETPID = 43, OP_HRTIME = 44, OP_CHILD_RESIZE = 45,
  OP_REPLY = 100, OP_STDIN = 101, OP_RESIZE = 102, OP_CHILD_OUT = 103, OP_CHILD_EXIT = 104,
  OP_SIGNAL = 105, OP_LOG = 106,
};

#define PROTO_VERSION 1
#define MAX_FRAME (64u * 1024u * 1024u) /* frames longer than this are a protocol error */
#define MAX_CHILDREN 256
#define IOBUF 65536

extern char **environ;

static int chan_fd = -1, sig_fd = -1;
static int trace_mode = 0; /* 0 off, 1 LOG frames to the host, 2 stderr */
static int stdin_on = 1;   /* still forwarding fd 0 to the host */
static int inherit_live = 0; /* children sharing our stdio (stdin forwarding pauses while > 0) */
static struct termios tty_orig;
static int tty_saved = 0, tty_is_raw = 0;

/* ------------------------------------------------------------------ tty + fatal exit */
static void tty_restore(void) {
  if (tty_saved && tty_is_raw) { tcsetattr(0, TCSANOW, &tty_orig); tty_is_raw = 0; }
}
static void die(const char *msg) {
  tty_restore();
  if (msg) fprintf(stderr, "nbnode: %s\n", msg);
  _exit(1);
}

/* ------------------------------------------------------------------ growable byte buffer + LE encoders */
typedef struct { uint8_t *p; size_t n, cap; } buf_t;
static void b_reserve(buf_t *b, size_t add) {
  if (b->n + add <= b->cap) return;
  size_t c = b->cap ? b->cap : 1024;
  while (c < b->n + add) c *= 2;
  b->p = realloc(b->p, c);
  if (!b->p) die("out of memory");
  b->cap = c;
}
static void b_put(buf_t *b, const void *d, size_t n) { b_reserve(b, n); if (n) memcpy(b->p + b->n, d, n); b->n += n; }
static void b_u8(buf_t *b, uint8_t v) { b_put(b, &v, 1); }
static void put_u32(uint8_t *p, uint32_t v) { p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24; }
static void b_u32(buf_t *b, uint32_t v) { uint8_t t[4]; put_u32(t, v); b_put(b, t, 4); }
static void b_i32(buf_t *b, int32_t v) { b_u32(b, (uint32_t) v); }
static void b_i64(buf_t *b, int64_t v) { uint64_t u = (uint64_t) v; uint8_t t[8]; for (int i = 0; i < 8; i++) t[i] = (uint8_t) (u >> (8 * i)); b_put(b, t, 8); }
static void b_bin(buf_t *b, const void *d, size_t n) { b_u32(b, (uint32_t) n); b_put(b, d, n); }
static void b_str(buf_t *b, const char *s) { b_bin(b, s, strlen(s)); }

/* ------------------------------------------------------------------ payload reader */
typedef struct { const uint8_t *p; size_t n, o; int bad; } rd_t;
static int r_need(rd_t *r, size_t k) { if (r->o + k > r->n) { r->bad = 1; return 0; } return 1; }
static uint32_t r_u32(rd_t *r) {
  if (!r_need(r, 4)) return 0;
  const uint8_t *p = r->p + r->o; r->o += 4;
  return (uint32_t) p[0] | (uint32_t) p[1] << 8 | (uint32_t) p[2] << 16 | (uint32_t) p[3] << 24;
}
static int32_t r_i32(rd_t *r) { return (int32_t) r_u32(r); }
static int64_t r_i64(rd_t *r) {
  if (!r_need(r, 8)) return 0;
  uint64_t v = 0; for (int i = 7; i >= 0; i--) v = v << 8 | r->p[r->o + i];
  r->o += 8; return (int64_t) v;
}
static char *r_str(rd_t *r) { /* NUL-terminated copy (caller frees); NULL when malformed */
  uint32_t n = r_u32(r);
  if (r->bad || !r_need(r, n)) { r->bad = 1; return NULL; }
  char *s = malloc((size_t) n + 1);
  if (!s) die("out of memory");
  memcpy(s, r->p + r->o, n); s[n] = 0; r->o += n;
  return s;
}
static const uint8_t *r_bin(rd_t *r, uint32_t *len) { /* pointer into the payload */
  uint32_t n = r_u32(r);
  if (r->bad || !r_need(r, n)) { r->bad = 1; *len = 0; return NULL; }
  const uint8_t *p = r->p + r->o; r->o += n; *len = n;
  return p;
}
static char **r_strlist(rd_t *r, uint32_t *count) { /* NULL-terminated argv-style array */
  uint32_t n = r_u32(r);
  if (r->bad || n > 65536) { r->bad = 1; *count = 0; return NULL; }
  char **v = calloc((size_t) n + 1, sizeof *v);
  if (!v) die("out of memory");
  for (uint32_t i = 0; i < n; i++) { v[i] = r_str(r); if (r->bad) break; }
  *count = n;
  return v;
}
static void free_strlist(char **v) { if (!v) return; for (char **q = v; *q; q++) free(*q); free(v); }

/* ------------------------------------------------------------------ complete writes */
/* Writes all n bytes (pwrite when off >= 0).  Returns n, or the partial count when a later chunk
 * failed, or -1 (errno set) when nothing could be written.  EAGAIN waits for POLLOUT. */
static ssize_t write_full(int fd, const uint8_t *p, size_t n, int64_t off) {
  size_t done = 0;
  while (done < n) {
    ssize_t k = off >= 0 ? pwrite(fd, p + done, n - done, off + (int64_t) done) : write(fd, p + done, n - done);
    if (k < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) { struct pollfd pf = { fd, POLLOUT, 0 }; poll(&pf, 1, -1); continue; }
      return done ? (ssize_t) done : -1;
    }
    done += (size_t) k;
  }
  return (ssize_t) done;
}

/* ------------------------------------------------------------------ frames */
static buf_t ob, eb, lb; /* reply / event / log frames (kept apart: events may fire while a reply is being built) */
static void frame_begin(buf_t *b, uint8_t op, uint32_t id) { b->n = 0; b_u32(b, 0); b_u8(b, op); b_u32(b, id); }
static void frame_send(buf_t *b) {
  put_u32(b->p, (uint32_t) (b->n - 4));
  if (write_full(chan_fd, b->p, b->n, -1) != (ssize_t) b->n) die("channel write failed");
}
static void reply_begin(uint32_t id, int err) { frame_begin(&ob, OP_REPLY, id); b_i32(&ob, err); }
static void reply_err(uint32_t id, int err) { reply_begin(id, err); frame_send(&ob); }
static void reply_i32(uint32_t id, int32_t v) { reply_begin(id, 0); b_i32(&ob, v); frame_send(&ob); }

static const char *opname(int op) {
  static const char *n[] = { "HELLO", "OPEN", "CLOSE", "READ", "WRITE", "STAT", "LSTAT", "FSTAT", "READDIR", "READLINK", "MKDIR",
    "UNLINK", "RMDIR", "RENAME", "ACCESS", "CHMOD", "REALPATH", "UTIMES", "TRUNCATE", "FTRUNCATE", "SYMLINK", "LINK", "FSYNC", "CHOWN", "FCHMOD" };
  if (op >= 0 && op <= 24) return n[op];
  switch (op) {
    case OP_STDOUT: return "STDOUT"; case OP_STDERR: return "STDERR"; case OP_EXIT: return "EXIT"; case OP_TTY_RAW: return "TTY_RAW";
    case OP_TTY_SIZE: return "TTY_SIZE"; case OP_SPAWN: return "SPAWN"; case OP_CHILD_STDIN: return "CHILD_STDIN"; case OP_KILL: return "KILL"; case OP_CHILD_RESIZE: return "CHILD_RESIZE";
    case OP_GETPID: return "GETPID"; case OP_HRTIME: return "HRTIME"; default: return "?";
  }
}
static void tracef(const char *fmt, ...) {
  if (!trace_mode) return;
  char m[512]; va_list ap; va_start(ap, fmt); vsnprintf(m, sizeof m, fmt, ap); va_end(ap);
  if (trace_mode == 2) { fprintf(stderr, "nbnode: %s\n", m); return; }
  frame_begin(&lb, OP_LOG, 0); b_str(&lb, m); frame_send(&lb);
}

/* ------------------------------------------------------------------ tty helpers */
static void get_winsz(int *cols, int *rows) {
  struct winsize ws;
  for (int fd = 0; fd < 3; fd++)
    if (ioctl(fd, TIOCGWINSZ, &ws) == 0) { *cols = ws.ws_col; *rows = ws.ws_row; return; }
  *cols = *rows = 0;
}
static int tty_set_raw(int on) {
  if (!isatty(0)) return ENOTTY;
  if (on) {
    if (!tty_saved) { if (tcgetattr(0, &tty_orig) < 0) return errno; tty_saved = 1; }
    struct termios t = tty_orig; cfmakeraw(&t);
    if (tcsetattr(0, TCSANOW, &t) < 0) return errno;
    tty_is_raw = 1;
  } else if (tty_saved) {
    if (tcsetattr(0, TCSANOW, &tty_orig) < 0) return errno;
    tty_is_raw = 0;
  }
  return 0;
}
static void set_nonblock(int fd) { int f = fcntl(fd, F_GETFL); if (f >= 0) fcntl(fd, F_SETFL, f | O_NONBLOCK); }

/* ------------------------------------------------------------------ children */
typedef struct {
  int used; uint32_t cid; pid_t pid;
  int in, out, err;      /* our ends (-1 = none/closed); pty: out = master, in = dup(master) */
  int reaped, inherit, pty, close_in;
  int winsz_pinned;      /* the host set this pty's size explicitly (CHILD_RESIZE): our own SIGWINCH must not overwrite it */
  buf_t inq; size_t inq_off; /* pending CHILD_STDIN bytes */
} child_t;
static child_t kids[MAX_CHILDREN];

static child_t *kid_find(uint32_t cid) { for (int i = 0; i < MAX_CHILDREN; i++) if (kids[i].used && kids[i].cid == cid) return &kids[i]; return NULL; }
static child_t *kid_by_pid(pid_t pid) { for (int i = 0; i < MAX_CHILDREN; i++) if (kids[i].used && kids[i].pid == pid) return &kids[i]; return NULL; }
static child_t *kid_alloc(void) {
  for (int i = 0; i < MAX_CHILDREN; i++) if (!kids[i].used) {
    child_t *c = &kids[i]; free(c->inq.p); memset(c, 0, sizeof *c); c->used = 1; c->in = c->out = c->err = -1; return c;
  }
  return NULL;
}
static void kid_free(child_t *c) {
  if (c->in >= 0) close(c->in);
  if (c->out >= 0) close(c->out);
  if (c->err >= 0) close(c->err);
  free(c->inq.p); memset(c, 0, sizeof *c);
}
static void kid_maybe_free(child_t *c) { if (c->used && c->reaped && c->out < 0 && c->err < 0) kid_free(c); }

/* drain one child output stream (until EAGAIN or EOF); emits CHILD_OUT frames, closes on EOF */
static void kid_read(child_t *c, int which) {
  int *fdp = which == 1 ? &c->out : &c->err;
  uint8_t tmp[IOBUF];
  while (*fdp >= 0) {
    ssize_t k = read(*fdp, tmp, sizeof tmp);
    if (k < 0 && errno == EINTR) continue;
    if (k < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
    frame_begin(&eb, OP_CHILD_OUT, 0); b_u32(&eb, c->cid); b_i32(&eb, which); b_bin(&eb, tmp, k > 0 ? (size_t) k : 0); frame_send(&eb);
    if (k <= 0) { close(*fdp); *fdp = -1; } /* EOF, or EIO (pty master after the slave went away) */
  }
}
/* push pending stdin bytes into the child (non-blocking); closes when asked and drained */
static void kid_flush_in(child_t *c) {
  while (c->in >= 0 && c->inq_off < c->inq.n) {
    ssize_t k = write(c->in, c->inq.p + c->inq_off, c->inq.n - c->inq_off);
    if (k < 0 && errno == EINTR) continue;
    if (k < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
    if (k < 0) { close(c->in); c->in = -1; break; } /* EPIPE etc: drop the queue */
    c->inq_off += (size_t) k;
  }
  c->inq.n = 0; c->inq_off = 0;
  if (c->close_in && c->in >= 0) { close(c->in); c->in = -1; }
}

static void reap(void) {
  for (;;) {
    int st; pid_t p = waitpid(-1, &st, WNOHANG);
    if (p < 0 && errno == EINTR) continue;
    if (p <= 0) break;
    child_t *c = kid_by_pid(p);
    if (!c) continue; /* e.g. an exec-failure child already reaped synchronously */
    kid_read(c, 1); kid_read(c, 2); /* deliver everything the child wrote before its exit event */
    c->reaped = 1;
    if (c->inherit) inherit_live--;
    int code = WIFEXITED(st) ? WEXITSTATUS(st) : -1, sig = WIFSIGNALED(st) ? WTERMSIG(st) : 0;
    tracef("child cid=%u pid=%d exit code=%d sig=%d", c->cid, (int) p, code, sig);
    frame_begin(&eb, OP_CHILD_EXIT, 0); b_u32(&eb, c->cid); b_i32(&eb, code); b_i32(&eb, sig); frame_send(&eb);
    kid_maybe_free(c);
  }
}

static void do_spawn(uint32_t id, rd_t *r) {
  uint32_t cid = r_u32(r), argc = 0, envc = 0;
  char **argv = r_strlist(r, &argc);
  char **envp = r_strlist(r, &envc);
  char *cwd = r_str(r);
  int32_t flags = r_i32(r);
  int err = 0, p_in[2] = { -1, -1 }, p_out[2] = { -1, -1 }, p_err[2] = { -1, -1 }, p_ex[2] = { -1, -1 }, master = -1;
  int use_pty = (flags & 2) != 0, use_pipe = !use_pty && (flags & 1);
  char sname[128] = "";
  child_t *c = NULL;

  if (r->bad || argc == 0 || !argv[0]) { err = EINVAL; goto out; }
  if (kid_find(cid)) { err = EEXIST; goto out; }
  if (!(c = kid_alloc())) { err = EAGAIN; goto out; }
  if (use_pty) {
    master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
    if (master < 0 || grantpt(master) < 0 || unlockpt(master) < 0 || ptsname_r(master, sname, sizeof sname) != 0) { err = errno ? errno : EIO; goto out; }
    struct winsize ws; int cols, rows; get_winsz(&cols, &rows);
    if (cols > 0) { memset(&ws, 0, sizeof ws); ws.ws_col = (unsigned short) cols; ws.ws_row = (unsigned short) rows; ioctl(master, TIOCSWINSZ, &ws); }
  } else if (use_pipe) {
    if (pipe2(p_in, O_CLOEXEC) < 0 || pipe2(p_out, O_CLOEXEC) < 0 || pipe2(p_err, O_CLOEXEC) < 0) { err = errno; goto out; }
  }
  if (pipe2(p_ex, O_CLOEXEC) < 0) { err = errno; goto out; }

  pid_t pid = fork();
  if (pid < 0) { err = errno; goto out; }
  if (pid == 0) { /* ---- child */
    sigset_t e; sigemptyset(&e); sigprocmask(SIG_SETMASK, &e, NULL);
    signal(SIGPIPE, SIG_DFL);
    if (use_pty) {
      setsid();
      int s = open(sname, O_RDWR);
      if (s < 0) goto fail;
      ioctl(s, TIOCSCTTY, 0);
      dup2(s, 0); dup2(s, 1); dup2(s, 2);
      if (s > 2) close(s);
    } else if (use_pipe) {
      dup2(p_in[0], 0); dup2(p_out[1], 1); dup2(p_err[1], 2);
    }
    if (cwd && *cwd && chdir(cwd) < 0) goto fail;
    if (envc) environ = envp; /* like libuv: PATH lookup uses the child's env */
    execvp(argv[0], argv);
  fail:
    { int e2 = errno; if (write(p_ex[1], &e2, sizeof e2) < 0) { } _exit(127); }
  }
  /* ---- parent */
  close(p_ex[1]); p_ex[1] = -1;
  if (use_pipe) { close(p_in[0]); close(p_out[1]); close(p_err[1]); p_in[0] = p_out[1] = p_err[1] = -1; }
  { int e2 = 0; ssize_t k; do k = read(p_ex[0], &e2, sizeof e2); while (k < 0 && errno == EINTR); close(p_ex[0]); p_ex[0] = -1;
    if (k == (ssize_t) sizeof e2) { /* exec/chdir failed: reap it now, never report it as a child */
      while (waitpid(pid, NULL, 0) < 0 && errno == EINTR) { }
      err = e2 ? e2 : EIO; goto out;
    } }
  c->cid = cid; c->pid = pid;
  if (use_pty) { c->pty = 1; c->out = master; c->in = dup(master); set_nonblock(master); master = -1; }
  else if (use_pipe) { c->in = p_in[1]; c->out = p_out[0]; c->err = p_err[0]; set_nonblock(c->in); set_nonblock(c->out); set_nonblock(c->err); p_in[1] = p_out[0] = p_err[0] = -1; }
  else { c->inherit = 1; inherit_live++; }
  tracef("spawn cid=%u pid=%d %s flags=%d", cid, (int) pid, argv[0], flags);
  reply_i32(id, (int32_t) pid);
  c = NULL;
out:
  if (err) { tracef("spawn cid=%u failed errno=%d", cid, err); reply_err(id, err); }
  if (c) kid_free(c);
  int *fds[] = { &p_in[0], &p_in[1], &p_out[0], &p_out[1], &p_err[0], &p_err[1], &p_ex[0], &p_ex[1], &master };
  for (size_t i = 0; i < sizeof fds / sizeof *fds; i++) if (*fds[i] >= 0) close(*fds[i]);
  free_strlist(argv); free_strlist(envp); free(cwd);
}

/* ------------------------------------------------------------------ request dispatch */
static void b_stat(buf_t *b, const struct stat *st) {
  b_i64(b, (int64_t) st->st_dev); b_i64(b, (int64_t) st->st_ino); b_i64(b, st->st_mode); b_i64(b, (int64_t) st->st_nlink);
  b_i64(b, st->st_uid); b_i64(b, st->st_gid); b_i64(b, (int64_t) st->st_rdev); b_i64(b, st->st_size);
  b_i64(b, st->st_blksize); b_i64(b, st->st_blocks);
  b_i64(b, (int64_t) st->st_atim.tv_sec * 1000000000LL + st->st_atim.tv_nsec);
  b_i64(b, (int64_t) st->st_mtim.tv_sec * 1000000000LL + st->st_mtim.tv_nsec);
  b_i64(b, (int64_t) st->st_ctim.tv_sec * 1000000000LL + st->st_ctim.tv_nsec);
}
static void reply_stat(uint32_t id, int rc, const struct stat *st) {
  if (rc < 0) { reply_err(id, errno); return; }
  reply_begin(id, 0); b_stat(&ob, st); frame_send(&ob);
}
static void reply_rc(uint32_t id, int rc) { reply_err(id, rc < 0 ? errno : 0); }
static struct timespec ns_to_ts(int64_t ns) { struct timespec t; t.tv_sec = ns / 1000000000LL; t.tv_nsec = ns % 1000000000LL; if (t.tv_nsec < 0) { t.tv_nsec += 1000000000LL; t.tv_sec--; } return t; }

static void dispatch(uint8_t op, uint32_t id, const uint8_t *pl, size_t n) {
  rd_t rr = { pl, n, 0, 0 }, *r = &rr;
  char *a = NULL, *b = NULL;
  tracef("<- %s id=%u len=%zu", opname(op), id, n);
  switch (op) {
    case OP_OPEN: { a = r_str(r); int32_t flags = r_i32(r), mode = r_i32(r); if (r->bad) goto bad;
      int fd = open(a, flags | O_CLOEXEC, mode); if (fd < 0) reply_err(id, errno); else reply_i32(id, fd); break; }
    case OP_CLOSE: { int32_t fd = r_i32(r); if (r->bad) goto bad; reply_rc(id, close(fd)); break; }
    case OP_READ: { int32_t fd = r_i32(r); uint32_t len = r_u32(r); int64_t off = r_i64(r);
      if (r->bad || len > MAX_FRAME - 64) goto bad;
      reply_begin(id, 0); b_u32(&ob, 0); size_t hdr = ob.n; b_reserve(&ob, len);
      ssize_t k; do k = off >= 0 ? pread(fd, ob.p + hdr, len, off) : read(fd, ob.p + hdr, len); while (k < 0 && errno == EINTR);
      if (k < 0) { reply_err(id, errno); break; }
      ob.n = hdr + (size_t) k; put_u32(ob.p + hdr - 4, (uint32_t) k); frame_send(&ob); break; }
    case OP_WRITE: { int32_t fd = r_i32(r); int64_t off = r_i64(r); uint32_t len; const uint8_t *d = r_bin(r, &len); if (r->bad) goto bad;
      ssize_t k = write_full(fd, d, len, off); if (k < 0) reply_err(id, errno); else reply_i32(id, (int32_t) k); break; }
    case OP_STAT: { struct stat st; a = r_str(r); if (r->bad) goto bad; reply_stat(id, stat(a, &st), &st); break; }
    case OP_LSTAT: { struct stat st; a = r_str(r); if (r->bad) goto bad; reply_stat(id, lstat(a, &st), &st); break; }
    case OP_FSTAT: { struct stat st; int32_t fd = r_i32(r); if (r->bad) goto bad; reply_stat(id, fstat(fd, &st), &st); break; }
    case OP_READDIR: { a = r_str(r); if (r->bad) goto bad;
      DIR *d = opendir(a); if (!d) { reply_err(id, errno); break; }
      buf_t items = { 0, 0, 0 }; uint32_t count = 0; struct dirent *e; int err = 0;
      for (;;) { errno = 0; e = readdir(d); if (!e) { err = errno; break; }
        if (e->d_name[0] == '.' && (!e->d_name[1] || (e->d_name[1] == '.' && !e->d_name[2]))) continue;
        b_str(&items, e->d_name); b_u8(&items, e->d_type); count++; }
      closedir(d);
      if (err) reply_err(id, err); else { reply_begin(id, 0); b_u32(&ob, count); b_put(&ob, items.p, items.n); frame_send(&ob); }
      free(items.p); break; }
    case OP_READLINK: { a = r_str(r); if (r->bad) goto bad;
      size_t cap = 4096; char *t = malloc(cap); ssize_t k;
      for (;;) { k = readlink(a, t, cap); if (k < 0 || (size_t) k < cap) break; cap *= 2; t = realloc(t, cap); if (!t) die("out of memory"); }
      if (k < 0) reply_err(id, errno); else { reply_begin(id, 0); b_bin(&ob, t, (size_t) k); frame_send(&ob); }
      free(t); break; }
    case OP_MKDIR: { a = r_str(r); int32_t mode = r_i32(r); if (r->bad) goto bad; reply_rc(id, mkdir(a, mode)); break; }
    case OP_UNLINK: { a = r_str(r); if (r->bad) goto bad; reply_rc(id, unlink(a)); break; }
    case OP_RMDIR: { a = r_str(r); if (r->bad) goto bad; reply_rc(id, rmdir(a)); break; }
    case OP_RENAME: { a = r_str(r); b = r_str(r); if (r->bad) goto bad; reply_rc(id, rename(a, b)); break; }
    case OP_ACCESS: { a = r_str(r); int32_t mode = r_i32(r); if (r->bad) goto bad; reply_rc(id, access(a, mode)); break; }
    case OP_CHMOD: { a = r_str(r); int32_t mode = r_i32(r); if (r->bad) goto bad; reply_rc(id, chmod(a, mode)); break; }
    case OP_REALPATH: { a = r_str(r); if (r->bad) goto bad; char *p = realpath(a, NULL);
      if (!p) reply_err(id, errno); else { reply_begin(id, 0); b_str(&ob, p); frame_send(&ob); free(p); } break; }
    case OP_UTIMES: { a = r_str(r); int64_t at = r_i64(r), mt = r_i64(r); if (r->bad) goto bad;
      struct timespec ts[2] = { ns_to_ts(at), ns_to_ts(mt) }; reply_rc(id, utimensat(AT_FDCWD, a, ts, 0)); break; }
    case OP_TRUNCATE: { a = r_str(r); int64_t len = r_i64(r); if (r->bad) goto bad; reply_rc(id, truncate(a, len)); break; }
    case OP_FTRUNCATE: { int32_t fd = r_i32(r); int64_t len = r_i64(r); if (r->bad) goto bad; reply_rc(id, ftruncate(fd, len)); break; }
    case OP_SYMLINK: { a = r_str(r); b = r_str(r); if (r->bad) goto bad; reply_rc(id, symlink(a, b)); break; }
    case OP_LINK: { a = r_str(r); b = r_str(r); if (r->bad) goto bad; reply_rc(id, link(a, b)); break; }
    case OP_FSYNC: { int32_t fd = r_i32(r); if (r->bad) goto bad; reply_rc(id, fsync(fd)); break; }
    case OP_CHOWN: { a = r_str(r); int32_t uid = r_i32(r), gid = r_i32(r); if (r->bad) goto bad; reply_rc(id, chown(a, (uid_t) uid, (gid_t) gid)); break; }
    case OP_FCHMOD: { int32_t fd = r_i32(r), mode = r_i32(r); if (r->bad) goto bad; reply_rc(id, fchmod(fd, mode)); break; }

    case OP_STDOUT: case OP_STDERR: { uint32_t len; const uint8_t *d = r_bin(r, &len); if (r->bad) goto bad;
      ssize_t k = write_full(op == OP_STDOUT ? 1 : 2, d, len, -1); reply_err(id, k == (ssize_t) len ? 0 : errno); break; }
    case OP_EXIT: { int32_t code = r_i32(r); if (r->bad) code = 1; tracef("exit %d", code); fsync(1); tty_restore(); _exit(code & 255); }
    case OP_TTY_RAW: { int32_t on = r_i32(r); if (r->bad) goto bad; reply_err(id, tty_set_raw(on != 0)); break; }
    case OP_TTY_SIZE: { int cols, rows; get_winsz(&cols, &rows);
      if (!isatty(0) && !isatty(1) && !isatty(2)) { reply_err(id, ENOTTY); break; }
      reply_begin(id, 0); b_i32(&ob, cols); b_i32(&ob, rows); frame_send(&ob); break; }

    case OP_SPAWN: do_spawn(id, r); break;
    case OP_CHILD_STDIN: { uint32_t cid = r_u32(r), len; const uint8_t *d = r_bin(r, &len); if (r->bad) goto bad;
      child_t *c = kid_find(cid);
      if (!c) { reply_err(id, ESRCH); break; }
      if (c->in < 0) { reply_err(id, EPIPE); break; }
      if (len == 0) c->close_in = 1; else b_put(&c->inq, d, len);
      kid_flush_in(c); reply_err(id, 0); break; }
    case OP_CHILD_RESIZE: { uint32_t cid = r_u32(r); int32_t cols = r_i32(r), rows = r_i32(r); if (r->bad) goto bad;
      child_t *c = kid_find(cid); if (!c) { reply_err(id, ESRCH); break; }
      if (!c->pty || c->out < 0) { reply_err(id, ENOTTY); break; }
      struct winsize ws; memset(&ws, 0, sizeof ws);
      ws.ws_col = (unsigned short) (cols > 0 ? cols : 80); ws.ws_row = (unsigned short) (rows > 0 ? rows : 24);
      c->winsz_pinned = 1;
      reply_rc(id, ioctl(c->out, TIOCSWINSZ, &ws)); break; }
    case OP_KILL: { uint32_t cid = r_u32(r); int32_t sig = r_i32(r); if (r->bad) goto bad;
      child_t *c = kid_find(cid); if (!c || c->reaped) { reply_err(id, ESRCH); break; }
      reply_rc(id, kill(c->pid, sig)); break; }
    case OP_GETPID: reply_i32(id, (int32_t) getpid()); break;
    case OP_HRTIME: { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
      reply_begin(id, 0); b_i64(&ob, (int64_t) t.tv_sec * 1000000000LL + t.tv_nsec); frame_send(&ob); break; }
    default: tracef("unknown op %d", op); reply_err(id, ENOSYS); break;
  }
  free(a); free(b);
  return;
bad:
  tracef("malformed %s id=%u", opname(op), id);
  free(a); free(b);
  reply_err(id, EINVAL);
}

/* ------------------------------------------------------------------ channel input: framing */
static buf_t ib; static size_t ib_off;
static void chan_read(void) {
  b_reserve(&ib, IOBUF);
  ssize_t k; do k = read(chan_fd, ib.p + ib.n, ib.cap - ib.n); while (k < 0 && errno == EINTR);
  if (k == 0) die("channel closed");
  if (k < 0) { if (errno == EAGAIN || errno == EWOULDBLOCK) return; die("channel read error"); }
  ib.n += (size_t) k;
  for (;;) {
    size_t avail = ib.n - ib_off;
    if (avail < 4) break;
    const uint8_t *h = ib.p + ib_off;
    uint32_t len = (uint32_t) h[0] | (uint32_t) h[1] << 8 | (uint32_t) h[2] << 16 | (uint32_t) h[3] << 24;
    if (len < 5 || len > MAX_FRAME) die("bad frame length");
    if (avail < 4 + (size_t) len) { b_reserve(&ib, 4 + (size_t) len - avail); break; }
    uint8_t op = h[4];
    uint32_t id = (uint32_t) h[5] | (uint32_t) h[6] << 8 | (uint32_t) h[7] << 16 | (uint32_t) h[8] << 24;
    ib_off += 4 + (size_t) len; /* advance first: dispatch may not return (EXIT) */
    dispatch(op, id, h + 9, len - 5);
  }
  if (ib_off) { memmove(ib.p, ib.p + ib_off, ib.n - ib_off); ib.n -= ib_off; ib_off = 0; }
}

/* ------------------------------------------------------------------ stdin + signals */
static void read_stdin(void) {
  uint8_t tmp[IOBUF]; ssize_t k;
  do k = read(0, tmp, sizeof tmp); while (k < 0 && errno == EINTR);
  if (k < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
  frame_begin(&eb, OP_STDIN, 0); b_bin(&eb, tmp, k > 0 ? (size_t) k : 0); frame_send(&eb);
  if (k <= 0) stdin_on = 0; /* EOF (or EIO on tty hangup): announced once */
}
static void send_resize(void) {
  int cols, rows; get_winsz(&cols, &rows);
  struct winsize ws; memset(&ws, 0, sizeof ws); ws.ws_col = (unsigned short) cols; ws.ws_row = (unsigned short) rows;
  for (int i = 0; i < MAX_CHILDREN; i++) /* propagate to pty children */
    if (kids[i].used && kids[i].pty && kids[i].out >= 0 && !kids[i].winsz_pinned) ioctl(kids[i].out, TIOCSWINSZ, &ws);
  frame_begin(&eb, OP_RESIZE, 0); b_i32(&eb, cols); b_i32(&eb, rows); frame_send(&eb);
}
static void handle_signals(void) {
  struct signalfd_siginfo si;
  for (;;) {
    ssize_t k = read(sig_fd, &si, sizeof si);
    if (k < 0 && errno == EINTR) continue;
    if (k != (ssize_t) sizeof si) break;
    switch (si.ssi_signo) {
      case SIGCHLD: reap(); break;
      case SIGWINCH: send_resize(); break;
      case SIGINT: case SIGTERM: case SIGHUP:
        tracef("signal %d", (int) si.ssi_signo);
        frame_begin(&eb, OP_SIGNAL, 0); b_i32(&eb, (int32_t) si.ssi_signo); frame_send(&eb); break;
    }
  }
}

/* ------------------------------------------------------------------ main */
static void send_hello(int argc, char **argv) {
  char cwd[4096]; if (!getcwd(cwd, sizeof cwd)) strcpy(cwd, "/");
  int cols, rows; get_winsz(&cols, &rows);
  int envc = 0; for (char **e = environ; e && *e; e++) envc++;
  frame_begin(&eb, OP_HELLO, 0);
  b_u32(&eb, PROTO_VERSION);
  b_u32(&eb, (uint32_t) argc); for (int i = 0; i < argc; i++) b_str(&eb, argv[i]);
  b_u32(&eb, (uint32_t) envc); for (char **e = environ; e && *e; e++) b_str(&eb, *e);
  b_str(&eb, cwd);
  b_i32(&eb, (int32_t) getpid());
  b_i32(&eb, cols); b_i32(&eb, rows);
  b_i32(&eb, (isatty(0) ? 1 : 0) | (isatty(1) ? 2 : 0) | (isatty(2) ? 4 : 0));
  frame_send(&eb);
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
#ifdef NBNODE_DEBUG
  trace_mode = 2;
#endif
  const char *dbg = getenv("NBNODE_DEBUG");
  if (dbg) trace_mode = atoi(dbg);

  const char *fdenv = getenv("NBNODE_FD");
  if (fdenv && *fdenv) {
    chan_fd = atoi(fdenv);
    if (fcntl(chan_fd, F_GETFD) < 0) die("NBNODE_FD is not an open fd");
    fcntl(chan_fd, F_SETFD, FD_CLOEXEC);
  } else {
    const char *dev = getenv("NBNODE_DEV"); if (!dev || !*dev) dev = "/dev/hvc1";
    do chan_fd = open(dev, O_RDWR | O_NOCTTY | O_CLOEXEC); while (chan_fd < 0 && errno == EINTR);
    if (chan_fd < 0) { fprintf(stderr, "nbnode: cannot open channel %s: %s\n", dev, strerror(errno)); return 1; }
    struct termios t; if (tcgetattr(chan_fd, &t) == 0) { cfmakeraw(&t); tcsetattr(chan_fd, TCSANOW, &t); }
    ioctl(chan_fd, TIOCEXCL); /* exclusive: no other guest process can open the host channel and forge frames while we run */
  }
  set_nonblock(chan_fd);
  { struct stat st; if (fstat(0, &st) < 0) stdin_on = 0; }
  /* NBNODE_NO_STDIN=1: never read fd 0. Used when the shim runs as a BACKGROUND service next to
     another foreground program (codex/agy own the container console) — it must not compete for the
     tty's input, and its /dev/null stdin must not produce a spurious EOF frame either. */
  { const char *ns = getenv("NBNODE_NO_STDIN"); if (ns && *ns && *ns != '0') stdin_on = 0; }

  sigset_t m; sigemptyset(&m);
  sigaddset(&m, SIGINT); sigaddset(&m, SIGTERM); sigaddset(&m, SIGHUP); sigaddset(&m, SIGWINCH); sigaddset(&m, SIGCHLD);
  sigprocmask(SIG_BLOCK, &m, NULL);
  sig_fd = signalfd(-1, &m, SFD_NONBLOCK | SFD_CLOEXEC);
  if (sig_fd < 0) die("signalfd failed");

  send_hello(argc, argv);
  tracef("hello sent (pid %d)", (int) getpid());

  enum { K_CHAN, K_SIG, K_STDIN, K_OUT, K_ERR, K_IN };
  static struct pollfd pf[3 + 3 * MAX_CHILDREN];
  static int kind[3 + 3 * MAX_CHILDREN];
  static child_t *own[3 + 3 * MAX_CHILDREN];
  for (;;) {
    int n = 0;
    pf[n].fd = chan_fd; pf[n].events = POLLIN; kind[n] = K_CHAN; own[n++] = NULL;
    pf[n].fd = sig_fd; pf[n].events = POLLIN; kind[n] = K_SIG; own[n++] = NULL;
    if (stdin_on && !inherit_live) { pf[n].fd = 0; pf[n].events = POLLIN; kind[n] = K_STDIN; own[n++] = NULL; }
    for (int i = 0; i < MAX_CHILDREN; i++) {
      child_t *c = &kids[i]; if (!c->used) continue;
      if (c->out >= 0) { pf[n].fd = c->out; pf[n].events = POLLIN; kind[n] = K_OUT; own[n++] = c; }
      if (c->err >= 0) { pf[n].fd = c->err; pf[n].events = POLLIN; kind[n] = K_ERR; own[n++] = c; }
      if (c->in >= 0 && (c->inq_off < c->inq.n || c->close_in)) { pf[n].fd = c->in; pf[n].events = POLLOUT; kind[n] = K_IN; own[n++] = c; }
    }
    for (int i = 0; i < n; i++) pf[i].revents = 0;
    /* durability: the guest's 9p client (cache=loose) writes dirty pages back lazily; the host journals
       them only when they arrive, so force a writeback every 3 s (cheap when nothing is dirty) — a
       tab closed right after a save then loses at most 3 s of state */
    int rc = poll(pf, (nfds_t) n, 3000);
    if (rc == 0) { sync(); continue; }
    if (rc < 0) { if (errno == EINTR) continue; die("poll failed"); }
    for (int i = 0; i < n; i++) {
      if (!pf[i].revents) continue;
      child_t *c = own[i];
      switch (kind[i]) {
        case K_CHAN: chan_read(); break;
        case K_SIG: handle_signals(); break;
        case K_STDIN: read_stdin(); break;
        case K_OUT: if (c->used && c->out == pf[i].fd) kid_read(c, 1); break;  /* guard: dispatch above may have freed/reused the slot */
        case K_ERR: if (c->used && c->err == pf[i].fd) kid_read(c, 2); break;
        case K_IN: if (c->used && c->in == pf[i].fd) kid_flush_in(c); break;
      }
    }
    for (int i = 0; i < MAX_CHILDREN; i++) if (kids[i].used) kid_maybe_free(&kids[i]);
  }
}

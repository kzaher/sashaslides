# nbnode — the guest-side `node` shim ("system node on the browser's V8")

`nbnode` is what runs inside the nanobox VM when something execs `node`. It contains no JavaScript
engine: it opens the host channel (`/dev/hvc1`, a virtio console wired to the host worker), sends
`HELLO` (argv, environ, cwd, pid, tty size, isatty bits) and then acts as the host's syscall arm:
the host runs the JS (`cli.js`) on the browser's V8 and sends binary requests for files, stdio,
tty modes, child processes and signals, which the shim executes 1:1 with Linux syscalls.

Files:

| file | what |
|---|---|
| `nbnode.c` | the shim (single file, ~550 lines, C11, Linux only: signalfd, pipe2, pty) |
| `build.sh` | `./build.sh` static musl x86-64 → `./nbnode` (docker alpine, same recipe as `hctest`); `./build.sh host` → `./nbnode-host` (native gcc); `./build.sh test` |
| `test.mjs` | unit test: drives a real binary over a socketpair with the host's own `web/native/proto.js` |
| `hctest.c` | the older channel smoke test (`--hc-echo`) — unchanged |
| `../../web/native/proto.js` | THE protocol definition; `nbnode.c` mirrors it byte for byte |

## Protocol summary (see proto.js for the authoritative list)

Frames are `u32 len | u8 op | u32 id | payload`, little-endian, `len` counts everything after
itself. Frames longer than 64 MB are a protocol error (the shim exits 1). Every host→guest request
except `EXIT` gets exactly one `REPLY(100)` with the same `id`: `i32 errno` (0 = ok) followed by the
op's result payload (absent when errno ≠ 0). Guest→host events use `id = 0`.

Behaviour details worth knowing when writing the host side:

* `OPEN` ORs `O_CLOEXEC` into the flags so spawned children never inherit host-owned fds.
* `READ` is a single `read`/`pread` (returns up to `len` bytes; empty = EOF). `WRITE`, `STDOUT`,
  `STDERR` are complete writes (loop on partial / `EAGAIN`).
* `STAT`/`LSTAT`/`FSTAT` reply 13 × i64: dev ino mode nlink uid gid rdev size blksize blocks
  atime_ns mtime_ns ctime_ns.
* `READDIR` skips `.` and `..` (like `fs.readdir`) and returns `d_type` (`DT_REG`=8, `DT_DIR`=4,
  `DT_LNK`=10, `DT_UNKNOWN`=0 on filesystems that don't fill it — the host should fall back to `LSTAT`).
* `TTY_RAW` / `TTY_SIZE` operate on the shim's own tty (fd 0; size probes 0,1,2). Without a tty they
  reply `ENOTTY`. Raw mode is `cfmakeraw` (so `^C` arrives as byte 3 on `STDIN` instead of a `SIGNAL`
  event) and is restored on `EXIT`, on channel loss and on any fatal error.
* `SPAWN` flags: bit0 = pipe stdin/stdout/stderr (`CHILD_OUT fd 1|2`, `CHILD_STDIN`), bit1 = pty
  (child gets a controlling pty, its output arrives as `CHILD_OUT fd 1`, stderr merged, window size
  follows `SIGWINCH`), neither = inherit the shim's stdio (while such a child lives the shim stops
  reading fd 0 so the child gets the keystrokes). `argv[0]` is resolved with `execvp` using the
  child's env (like libuv); an empty env list means "inherit". exec/chdir failure is reported as the
  `SPAWN` reply errno (`ENOENT`, …) — no `CHILD_EXIT` follows. Reply = pid.
* `CHILD_EXIT`: `code` = exit status, or `-1` when killed by a signal (`signal` = the signal number).
  Before the exit event the shim drains whatever the child still had in its pipes, so all
  `CHILD_OUT` data precedes `CHILD_EXIT`; the two `CHILD_OUT` EOFs (empty payload) may come before or
  after it (e.g. when a grandchild keeps the pipe open).
* `CHILD_STDIN` bytes are queued and written non-blocking (`POLLOUT`), so a child that does not read
  cannot stall the shim; empty payload closes the child's stdin once the queue drained.
* `KILL` on an unknown / already reaped cid → `ESRCH`.
* `SIGNAL` events for `SIGINT`/`SIGTERM`/`SIGHUP` — the shim never dies on them; the host decides
  (`EXIT` or ignore). `RESIZE` on `SIGWINCH`. `STDIN` empty payload = EOF, sent once.
* Malformed payload → `EINVAL`, unknown op → `ENOSYS`; the channel closing (EOF / `EIO`) → tty
  restored, exit 1.
* `LOG(106)` frames carry tracing when `NBNODE_DEBUG=1`; `NBNODE_DEBUG=2` traces to stderr instead;
  building with `-DNBNODE_DEBUG` makes stderr tracing the default.

Env: `NBNODE_DEV` (default `/dev/hvc1`, opened `O_RDWR|O_NOCTTY` and put in raw mode when it is a
tty), or `NBNODE_FD=N` to use an already-open fd as the channel (what the test uses).

## Installation in the guest image

Plan (`guest/claude-npm/Dockerfile`, built by `build-claude-npm.sh`): the image currently copies the
official Node.js binary to `/usr/local/bin/node`; `/usr/local/bin/claude` is a symlink to
`.../@anthropic-ai/claude-code/cli.js` (`#!/usr/bin/env node`). Either

* **replace** it — `COPY guest/nbnode/nbnode /usr/local/bin/node` instead of the node:22 binary
  (saves ~100 MB of rootfs and everything the guest would spend booting V8), or
* **shadow** it — put `nbnode` first in `PATH` (e.g. `/opt/nbnode/bin/node` with
  `ENV PATH=/opt/nbnode/bin:...`) and keep the real node under a different name for fallback.

`nbnode` is static (musl), so it needs nothing from the rootfs; the guest kernel must expose the
second virtio console as `/dev/hvc1` (already true — `hctest` uses it). When `claude` is started
the guest exec chain is `busybox env node cli.js …` → `nbnode cli.js …` → `HELLO(argv =
["/usr/local/bin/node", "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", …])`;
the host worker loads `argv[1]` and runs it.

## Building

```sh
cd nanobox/guest/nbnode
./build.sh              # static musl x86-64 -> ./nbnode (≈63 KB); needs the rootless docker on
                        # DOCKER_HOST=unix:///tmp/xdgrt-1000/docker.sock
./build.sh host         # native glibc build -> ./nbnode-host (only for the unit test)
```

## Testing

No VM needed: `test.mjs` spawns the binary with an extra socketpair on fd 3 (`NBNODE_FD=3`) and
talks to it with the very same `NanoboxProto` encoder/decoder the host uses, so a mismatch in the
framing on either side shows up here. It covers HELLO framing, GETPID/HRTIME/TTY_* without a tty,
OPEN/WRITE/pwrite/FSYNC/FSTAT/CLOSE/STAT/READ/pread/READDIR/MKDIR/SYMLINK/READLINK/LSTAT/REALPATH/
RENAME/ACCESS/CHMOD/UTIMES/TRUNCATE/LINK/UNLINK/RMDIR round trips on a temp dir, errno paths
(ENOENT/EBADF/EINVAL/ENOSYS), split + coalesced frames, STDOUT/STDERR, SPAWN of `/bin/echo hi`
with piped stdio (CHILD_OUT data + EOFs + CHILD_EXIT), CHILD_STDIN + close into `cat` with env/cwd,
SPAWN failure, KILL, a pty SPAWN, SIGNAL/RESIZE forwarding, STDIN forwarding + EOF, LOG tracing
and EXIT.

```sh
./build.sh test                 # native build + test  (70/70 checks)
node test.mjs ./nbnode          # the static musl binary runs natively on this x86-64 host too
```

Manual check of the tty paths under a real pty (isatty bits = 7, TTY_RAW turning `^C` into a
STDIN byte vs. a SIGNAL event): run the shim under `script -qfec ./nbnode /dev/null` with
`NBNODE_FD=3` — see the session notes; it behaves as expected.

Inside the VM the end-to-end test is the harness once the host worker lands: boot `claude-npm`,
run `claude --version`, expect the host to receive `HELLO` and to drive `cli.js` to completion.

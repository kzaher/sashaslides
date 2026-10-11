# "System node" on the browser's V8 (track B) — design and status

Goal (user direction): do not touch Claude Code; install it the official way (`npm install -g
@anthropic-ai/claude-code`, system Node.js) and optimize *node*: its JavaScript runs on the browser's
own V8 (no x86 emulation of the JS engine), while everything Linux-specific (files, tty, child
processes: git, ripgrep, shells) still happens inside the guest kernel. Memory identity is not a goal
of this track (the JS heap lives outside the guest).

## Pieces

| piece | where | status |
|---|---|---|
| second virtio console `/dev/hvc1` = host channel | `bochs/wasm.cc` `nanoboxVirtioConsole` (PCI function 1 of the console's slot — the i440fx's 5 slots were all taken; the stdio console header is marked multi-function so Linux scans function 1 *after* hvc0), hooks `nanobox_hc_hook_slot(0)=write(ptr,len)`, `(1)=read(ptr,max)` | done, smoke-tested (`guest/nbnode/hctest.c`, harness `--hc-echo`) |
| host-side byte stream | `web/native/hostchan.js` (harness + worker), `web/native/hcring.js` (SharedArrayBuffer ring: runtime worker → VM worker, drained by the engine's rx-timer hook because the VM loop never yields) | done |
| wire protocol | `web/native/proto.js` (binary frames: OPEN/READ/WRITE/STAT/READDIR/…/SPAWN/CHILD_*/STDOUT/EXIT/HELLO/STDIN/RESIZE) | done |
| runtime-side client (syscall backend #2) | `web/native/guest.js` `NanoboxGuest.connect({ringSab, inSab})` → async `g.open/…` AND synchronous `g.sync.*` (Atomics.wait on the guest→host ring; the Node-compat layer's sync fs API needs it), events `onHello/onStdin/onChildOut/…` | done, tested in the VM (`harness/run.mjs --nbnode-test`): 0.85 ms per sync round trip, 20–28 MB/s file reads, spawn/child output/exit OK |
| guest shim `nbnode` (first in PATH via the bundle share: `/bundle/nb/node`, spec `config-vm.json`) | `guest/nbnode/nbnode.c` (static musl, 63 KB): HELLO with argv/env/cwd/tty, poll loop serving requests with real syscalls, fork/exec for SPAWN, tty raw mode, signals; 70/70 unit checks | done |
| Node-compat layer (require('fs') & co over a pluggable backend) | `web/native/*` (agent), backend #1 = in-memory rootfs + gateway, backend #2 = `guest.js` | in progress (agent) |
| image | `guest/claude-npm/Dockerfile` (node:22 binary + npm claude-code on the nanobox base), spec `web/images/claude-npm/config.json` (+ `/dev/hvc1` device entry) | in progress (agent) |
| page | `web/claude-native.html`: VM worker (opt-worker.js, direct mode, `cfg.hostChan={sab,port}`) + runtime worker | pending |

Found on the way: `ls /` inside the container was always empty — the 9p server treated an open as a directory only with `O_DIRECTORY`, and overlayfs opens the lower dir without it (`fs_open` now checks `S_ISDIR`). Gate re-run clean.

## Channel throughput (harness, `guest/nbnode/hcbench.c`)

host → guest 4 MB: 0.8 MB/s of *guest* time (the hvc/tty rx path is per-descriptor + tty flip
buffers; guest time runs ~10× faster than wall time under the JIT, so ≈ 8 MB/s wall); guest → host
1 MB: 9.7 MB/s guest time. Fine for RPC; bulk file content of the *image* (cli.js, node_modules,
~15 MB) should not go over the channel at all — the runtime worker already holds the unpacked OCI
rootfs, so the fs backend serves image files from host memory and uses the guest only for writes and
for paths outside the image (home dir, /tmp, /proc, sockets), and for child processes.

## Track A for comparison

The same `claude-npm` image booted on the emulated engine (system node's V8 as x86 under our trace
JIT) — measured separately; plus V8 flags friendlier to the trace JIT (`--jitless`: Ignition's
small stable dispatch loop compiles well; `--single-threaded`, `--max-lazy`).

## Track C: the NATIVE build (Bun) on the browser's V8

Claude Code's native installer ships a **Bun standalone executable** (324 MB, Bun 1.4.0 + JavaScriptCore),
so there is no `node` process to shadow — but the program's JavaScript is inside it as plain text:
Bun stores every embedded file in the ELF section `.bun` as `\0/$bunfs/<name>\0<contents>\0` records,
and the entry is already wrapped the way a CommonJS loader wants it:

```
\0/$bunfs/root/cli\0// @bun @bytecode @bun-cjs
(function(exports, require, module, __filename, __dirname) { …26.6 MB… })
```

(The `@bytecode` blob next to it is JavaScriptCore's cache — useless off JSC, and unnecessary: the
source beside it is complete.) `web/native/bunfs.js` reads those records (`tools/bun-extract.mjs` is
the same parser as a CLI, `test/bunfs-unit.mjs` covers it), so the sandbox can install the native
build's JS and run it on the browser's V8 exactly like the npm build — same guest, same shim, same
syscalls in Linux. Claude Code itself is not modified: the entry is stored and executed verbatim,
the runtime just calls the wrapper with its module context (`bundle-bun-cjs` in the page log).

Measured on 2.1.233: 12 embedded files — the 26.6 MB entry, `mermaid.min.js` (3.3 MB),
`hljsBundle.generated.min.js` (1.0 MB), `chart.umd.min.js`, `payload.template.html.asset` (2.2 MB)
and three `.node` addons; V8 parses+compiles the entry in 373 ms (lazy). The bundle reads its assets
by their literal `/$bunfs/root/...` path, so the installer writes them at exactly that path in the
guest. `downloads.claude.ai` serves the binary with `accept-ranges: bytes` and no CORS header, so
the installer range-fetches only the last 64 MB (where the sources live) through the relay — or
directly with the proxy extension.

What that build needs beyond Node: a `Bun` global (`web/native/src/bun-globals.js`). The 2.1.233
bundle calls, unconditionally, `Bun.stringWidth` / `wrapAnsi` / `stripANSI` (every TUI frame),
`Bun.hash`, `Bun.which`, `Bun.semver.order`, `Bun.YAML`, `Bun.TOML`, `Bun.deepEquals`, `Bun.spawn`,
`Bun.file`, `Bun.isStandaloneExecutable`, and — feature-gated — `Bun.Terminal`, `listen`, `connect`,
`serve`, `SQL`, `WebView`, `Transpiler`, `gc`, `ant.memoryPressureLevel`. Everything with a side
effect goes through the same syscall backend as the Node shims; anything not implemented is recorded
and surfaces in the page's missing-API list and the server error log.

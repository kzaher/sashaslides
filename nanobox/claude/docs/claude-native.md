# claude-npm (system Node.js image) and the native-V8 page

Two things, both from 2026-08-16, both about running Claude Code *as JavaScript* instead of as the
Bun executable:

1. **`claude-npm`** — a container image in which Claude Code is installed the official npm way on a
   system Node.js, booted in the emulated engine like the other images (`vm.html`).
2. **`web/claude-native.html`** — the *same* `cli.js` executed directly on the browser's V8 in a Web
   Worker behind a Node-compat layer (`web/native/`): no x86 emulation, no memory identity — a
   separate track that measures how fast the sign-in screen can appear when only the JavaScript runs.

## 1. The claude-npm image

`guest/claude-npm/Dockerfile` + `./build-claude-npm.sh` (log: `work/build-claude-npm.log`):

* rootfs = the same minimal glibc Ubuntu 24.04 recipe as `nanobox-base` (busybox + certs + libc)
  plus `libstdc++.so.6` (node needs it);
* `/usr/local/bin/node` = the official Node.js **22.23.2** binary (copied from `node:22-bookworm-slim`);
* `npm install -g @anthropic-ai/claude-code@2.1.112` done in the node image, the package copied to
  `/usr/local/lib/node_modules/@anthropic-ai/claude-code` (ripgrep pruned to `x64-linux`; 40 MB);
* `/usr/local/bin/claude -> ../lib/node_modules/@anthropic-ai/claude-code/cli.js` (`#!/usr/bin/env node`),
  `CMD ["/usr/local/bin/claude"]`, same ENV/WORKDIR as the other images.

Published like the others: OCI layout (docker save, layers gzip-recompressed by `vm-build/oci-gzip.mjs`)
at `../public/c2w/images/claude-npm/` → `/c2w/images/claude-npm/` (63 MB: base 3.9 + node 45.0 +
claude-code 16.4), runtime spec `web/images/claude-npm/{config.json,imageconfig.json}` written by
`tools/genspec.mjs` (the imagemounter genspec rule: image Env + `TERM=xterm`, args = Entrypoint+Cmd,
cwd = WorkingDir).

**Why 2.1.112.** The npm package stopped shipping JavaScript at 2.1.113: from there on
`@anthropic-ai/claude-code` is a 7-file wrapper whose postinstall downloads the platform-native Bun
executable (`optionalDependencies: @anthropic-ai/claude-code-linux-x64 …`, `bin/claude.exe`), i.e.
"npm install" gives exactly the binary the `claude` image already runs (2.1.233). 2.1.112 is the last
release with `bin: {claude: "cli.js"}` (13.7 MB ESM, `engines.node >= 18`; probed with `npm view`
across the version list). So the "system node" experiment is pinned to 2.1.112; the code the native
page runs is taken from this image (SHA-256 in `web/native/cli.json`), not from the Bun binary.

### Emulated result (optimized engine, `test/e2e-claude-npm.mjs`)

`vm.html?engine=opt&image=claude-npm&cmd=/bin/env NODE_EXTRA_CA_CERTS=/.wasmenv/proxy.crt /usr/local/bin/claude`
(vm.html has no SIGNIN/PROMPTS entry for this image and is not touched, so the driver reads the
terminal itself, answers the theme prompt and stops on the claude regexp):

| | claude (Bun 2.1.233, `web/results/claude-compare.json`) | claude-npm (node 22 + cli.js 2.1.112) |
|---|---|---|
| sign-in screen, optimized engine, JIT 2:2000 | 49.3–52.6 s | **84.4 s** (load 2.2 s + run 82.1 s) |
| guest instructions to sign-in | 17.9–19.3 G (68 % in one 4 KiB page: JSC GC sweep) | **7.84 G** in the browser run; 7.15 G in the harness (dead network) |
| profile (`harness --pages`, `work/prof/claude-npm-pages.txt`) | 4 % kernel / 96 % user, 50 % of user in **1** page | 7 % kernel / 93 % user, 50 % of user in **34** pages, 90 % in 281 |

So node executes **2.3× fewer instructions** than Bun for the same screen but the wall time is 1.65×
*longer*: Bun's instructions were one tiny GC loop the trace JIT runs at 2.5×, node's are a flat
V8/ICU/OpenSSL profile at ~100 MIPS with no single hot spot to compile — the same lesson as the
kernel-heavy codex/agy startups. Screenshot + JSON: `web/results/claude-npm-opt.{png,json}`
(`icount` there is the engine's live counter at the sign-in instant).

## 2. The native page

```
web/claude-native.html          the page (xterm.js, timer, prompt auto-answer, window.nanobox accessor)
web/native/runtime.js           the worker (built by web/native/build.mjs from web/native/src/*.js, 2.0 MB)
web/native/claude-cli.js        cli.js from the image, ESM->CJS transformed (tools/native-prepare.mjs, gitignored, 14 MB)
web/native/cli.json             provenance: version 2.1.112, image, layer, SHA-256 of the original cli.js
test/e2e-native.mjs             headless-Chrome driver -> web/results/claude-native.{json,png}
test/native-probe.mjs           open, wait for sign-in, send keys, print the screen (post-sign-in probing)
test/native-eval.mjs            evaluate JS inside the running worker (debugging)
```

Build: `cd web/native && npm install && node build.mjs`; `node tools/native-prepare.mjs`
(after `./build-claude-npm.sh`); open `http://localhost:8093/claude-native.html`; measure with
`node test/e2e-native.mjs`.

**Loading Claude Code's own code.** `cli.js` (2.1.112) is a single-file ESM with static imports of
Node builtins (`import{createRequire}from"node:module"`, `import*as W9 from"fs"`, `path/win32`, …).
Web Workers cannot resolve bare specifiers (no import maps in workers), so `tools/native-prepare.mjs`
runs esbuild's *transform* (not bundle) with `format=cjs`: `import x from "fs"` becomes
`require("fs")`, `import.meta.url` becomes the `file:///usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js`
literal, whitespace-only minification, no renaming, no other change (14.07 MB vs 13.71 MB original).
The worker installs `require`, `module`, `exports`, `__filename`, `__dirname`, `process`, `Buffer` on
its global and `importScripts()` the file — a classic script, so V8's code cache applies on repeat
loads (bundle load 390 ms cold, 240–270 ms warm, ~1 ms in the harness later would need a snapshot).

**Rootfs.** The worker unpacks the claude-npm image itself (`web/oci.js` `gunzip`+`applyLayer`,
`web/wasifs.js` tree, Cache API by digest via `web/cachefetch.js`) — but skips the layer whose
history entry is `COPY … /usr/local/bin/node` (120 MB of x86 code that has no purpose here; the
`skipNodeLayer` config, `?node=1` loads it): 20 MB compressed → 365 files, 320 ms cold / 65 ms from
the Cache API. `/dev/{null,tty,urandom,…}`, `/proc/self`, `/tmp`, `/root` are added. The tree is
mutable, so `~/.claude`, `~/.claude.json`, lock files etc. are simply written into it (writable
overlay = the tree; the image files themselves stay views into the layer tars).

### The syscall backend interface (`web/native/src/backend.js`)

The Node shims never touch the tree: every file/tty/process/socket operation is one call on ONE
object, so a different backend can slot in unchanged:

```
B.call(op, ...args)      synchronous: result or throws {__errno, syscall, path}  (-> Node errno Error)
B.callAsync(op, ...args) Promise of the same
B.on(kind, fn)           events pushed by the backend: "tty" {data|resize|eof}, "proc" {pid, stream, data}|{pid, exit, signal}, "net" {id, data|end|error|connected}

info() chdir(path)
stat(path, follow) fstat(fd) readdir(path)->[{name,type}] readlink realpath access(path, mode)
open(path, flags, mode)->fd close(fd) read(fd, len, pos|null)->bytes write(fd, bytes, pos|null)->n
readFile(pathOrFd)->bytes writeFile(path, bytes, flags, mode) mkdir(path, recursive, mode) rmdir unlink
rename symlink link chmod chown utimes truncate copyFile rm(path, recursive, force) mkdtemp fsync
ttySize()->{cols,rows} ttyWrite(fd, bytes) ttySetRaw(bool) isatty(fd)
spawn({file,args,cwd,env,stdio})->{pid}|{error} spawnSync(spec)->{status,signal,stdout,stderr}|{error} procInput(pid, bytes|null) procKill(pid, sig)
netConnect({host,port,tls})->{id}|{error} netWrite(id, bytes) netEnd(id)
```

* **Backend #1 — `MemBackend`** (this track): the in-memory tree; tty = the page's xterm through the
  worker port; `spawn`/`spawnSync` → `{error:"ENOENT"}` (recorded, see the list below);
  `netConnect` → `ECONNREFUSED` (recorded). HTTP is not a backend op: `http`/`https`/global `fetch`
  end in the worker's `fetch`, which routes every cross-origin request through the server's
  `POST /net/fetch` gateway (same encoding as `vm.html`'s override, `x-nanobox-target`).
* **Backend #2 — the VM track's guest-side `node` shim** (the coordinator's, in progress): the same
  operations executed inside the emulated Linux guest. It lives in another worker, so
  `SyncChannel` (client) / `serveSync` (responder) in `backend.js` carry `{id, op, args}` over a
  MessagePort and the reply back through a SharedArrayBuffer with `Atomics.wait/notify` (chunked for
  big payloads), which turns the asynchronous responder into the synchronous contract that
  `readFileSync`, `statSync`, `spawnSync` need. Events (`tty`, `proc`, `net`) are plain messages.
  Nothing in `fs.js`/`process.js`/`procnet.js` changes when the object behind `B` is swapped.

### What the layer implements

Own code (`web/native/src/`): `fs` (sync + callback + promises + `ReadStream`/`WriteStream` +
`Dir`/`Dirent`/`Stats`/`FileHandle`/constants/`watch` stubs) over `B`; `process` (env/argv/cwd from
the image spec, `hrtime`, `nextTick`, `exit` → worker `exit` event, `emitWarning`, `report`,
`getBuiltinModule`, …); `tty` (`WriteStream` with columns/rows/`getColorDepth`/cursor ops → `ttyWrite`,
`ReadStream` with `setRawMode` fed by the page's xterm `onData`, SIGWINCH via `resize` events); `os`;
`child_process` (`spawn`/`spawnSync`/`exec*`/`fork` shapes, `ChildProcess` streams wired to backend
`proc` events); `net`/`tls` (`Socket`/`TLSSocket`/`Server` shapes, `BlockList`, `SocketAddress`);
`dns`; `http`/`https` (`request`/`get` → `fetch`, `IncomingMessage` readable, `Agent`, `Server` that
"listens"); `http2` (refuses); `vm`, `v8`, `worker_threads` (no `Worker`), `perf_hooks`, `timers` +
`timers/promises` (`setImmediate` via `MessageChannel`), `module` (`createRequire` → our loader,
`builtinModules`), `async_hooks` (`AsyncLocalStorage`, `AsyncResource`), `inspector`, `readline`
(`createInterface`, `emitKeypressEvents`, `promises`), `querystring`/`url` additions
(`fileURLToPath`, `pathToFileURL`, `urlToHttpOptions`), `stream/web|promises|consumers`,
`diagnostics_channel`, `punycode`, `constants`, `cluster`/`dgram`/`domain`/`repl`/`wasi` stubs, and the
non-builtins Bun resolves natively: `undici` (fetch-backed) and `ws` (browser WebSocket).
npm polyfills bundled by esbuild: `buffer`, `events`, `readable-stream` (as `stream`), `util`,
`path-browserify`, `assert`, `string_decoder`, `browserify-zlib` (pako; brotli/zstd refuse),
`crypto-browserify` (+ WebCrypto: `webcrypto`, `randomUUID`, `hash`, `hkdfSync`, `timingSafeEqual`, …),
`url`, `querystring-es3` — each extended with the Node 22 additions they lack (`util.parseArgs`,
`stripVTControlCharacters`, `styleText`, `events.once/on`, `Readable.fromWeb/toWeb`, …).
`XMLHttpRequest` is removed from the worker global: with it present axios chooses its XHR adapter
(CORS-bound, cannot set `User-Agent`); without it, `[object process]` makes it take the http adapter
→ our `http` → `fetch` → gateway. `console.*` writes go to `process.stdout/stderr` (mirrored to
DevTools); uncaught errors/rejections go to `process.on(...)` listeners or stderr like node.

**Recording proxies.** Every module object handed to `require()` and `process` itself are `Proxy`
objects (`record.js`): a read of a property we do not have is logged once (key + first bundle frame),
stub functions log their calls; the worker posts them as `missing` events and `window.nanobox.dump()`
returns the full record (missing keys, spawn attempts, network requests, backend op counts, the
`require()` histogram). This is what "the API list" below is.

### The recorded API list (startup → sign-in screen, 2.1.112)

`require()`d by the bundle (calls): path 284, fs/promises 159, crypto 113, os 77, fs 74, child_process 44,
url 29, process 27, util 25, stream 22, http 16, net 13, https 10, events 9, async_hooks 8, buffer 7,
tty 6, assert 6, module 5, zlib 4, tls 3, path/posix 3, vm 3, readline 2, http2 1, path/win32 1,
timers/promises 1, stream/consumers 1, stream/promises 1, v8 1, dns 1, perf_hooks 1, inspector 1,
constants 1 (all served; `node:` prefixes stripped).

Backend operations executed: stat 38, readdir 27, mkdir 26, readFile 26, realpath 13, isatty 9,
writeFile 9, rename 8, readlink 8, utimes 8, chmod 7, rmdir 8, open 4, copyFile 1, ttyWrite 9,
ttySize 2, ttySetRaw 2, spawn 11, info 5 (~200 calls in total — the sign-in screen needs almost no
filesystem: `~/.claude.json`, `~/.claude/*`, settings dirs, lock files, `/etc/os-release`-style probes).

Properties read that we do not implement (the whole "missing" list): `process.type`,
`process.__nwjs` (Electron/nw.js detection — correctly undefined), `process.__signal_exit_emitter__`
(signal-exit's marker — correctly undefined), `fs.watch`, `fs.watchFile` (both return a stub watcher
that never fires; a real watcher would need backend #2). Requests to `require()` non-builtins seen
in the bundle (`ajv/*`, `sharp`, `@img/*`, `.node` addons) did not occur before sign-in.

Child processes attempted (all answered ENOENT by backend #1, Claude Code degrades gracefully):
`which npm|bun|yarn|deno|pnpm|node`, `vendor/ripgrep/x64-linux/rg --version`, `rg --files … --glob *.md`
over `/etc/claude-code/.claude/{commands,agents}` and `/root/.claude/{commands,agents}` (4×), and —
after choosing "Claude account" — `xdg-open <oauth url>`. Network before sign-in (all through the
gateway): `HEAD https://api.anthropic.com/`, `GET …/CHANGELOG.md` (raw.githubusercontent.com),
`GET https://api.anthropic.com/api/hello`, `GET https://platform.claude.com/v1/oauth/hello`
(the last two via axios → http adapter), then `/api/hello` again every ~5 s.

### Measured

Headless Chrome 151 (`test/e2e-native.mjs`, `web/results/claude-native.json`), page load → the
"Select login method" screen (the theme prompt in between is auto-answered like on the VM pages):

| | total | load (rootfs + bundle) | run |
|---|---|---|---|
| warm (Cache API layers + V8 code cache) | **1.0–1.3 s** | 0.39–0.45 s (rootfs 65 ms + bundle 240–270 ms) | 0.62–0.86 s |
| cold (`?cache=0`, HTTP cache disabled; `claude-native-cold.json`) | **1.8 s** | 0.90 s (rootfs 320 ms + bundle 390 ms) | 0.87 s |
| emulated claude-npm (same cli.js, node 22 in the VM) | 84.4 s | 2.2 s | 82.1 s |
| emulated claude (Bun 2.1.233) | 49.3–52.6 s | ~2 s | ~48 s |

Pressing Enter on the sign-in screen goes on to the real OAuth flow: `xdg-open` fails (recorded),
Claude Code prints "Browser didn't open? Use the url below to sign in" + the authorize URL and
"Paste code here if prompted >" — the manual paste-code exchange would run through the gateway
(`test/native-probe.mjs '\r'`, `web/results/claude-native-probe.png`).

### What is stubbed / what is needed beyond the sign-in screen

* **Child processes** — the big one: `rg` (file search, custom commands/agents discovery), `git`
  (repo detection, status, diffs), `which`, `xdg-open`, shells for the Bash tool, `claude` itself
  as an MCP subprocess. Backend #1 says ENOENT to all; backend #2 forwards `spawn`/`spawnSync` +
  `proc` events into the guest, where these programs exist and run for real. `spawnSync` needs the
  synchronous channel (Atomics.wait) — that is why the interface is RPC-shaped with a sync mode.
* **fs.watch / watchFile** (settings, `.claude` dirs) — stubbed watchers that never fire; backend #2
  can push change events (`fs` kind) if it runs inotify in the guest.
* **net.Server** — the OAuth callback server (`listen(57001)`) pretends to listen; nothing can connect
  to it from the real browser, so the paste-code path is the one that completes. Real inbound
  connections would need the page to bridge a local port (or the guest's network stack).
* **Raw sockets / TLS / DNS** — `net.connect`/`tls.connect` refuse (ECONNREFUSED), `dns.lookup`
  resolves only literals; everything HTTP goes through fetch → gateway, which is what the API client,
  telemetry and OAuth use. Redirect responses come back to the worker as 30x from `/net/fetch`, and
  the browser's fetch would follow them cross-origin (CORS): a gateway option to return them
  opaquely (or a `redirect: manual` flag in the target spec) is a small server-side addition when needed.
* **worker_threads.Worker** — none (Claude Code uses it optionally); could be a second Web Worker
  sharing the backend port.
* **Native addons** (`sharp`, `.node` files, keychain) — MODULE_NOT_FOUND like on a node without them.
* **zlib brotli/zstd** — refuse (pako covers deflate/gzip; the gateway strips upstream
  `content-encoding` so responses arrive decoded).
* **process.binding / dlopen / report internals** — throw / static.
* **Signals** — `process.on("SIGINT")` etc. register but nothing raises them (Ctrl-C reaches the CLI as
  bytes in raw mode, which is what Ink wants).
* Not touched by design: Claude Code's code (mechanical ESM→CJS transform only), `vm.html`,
  `compare.js`, `opt-worker.js`, harness, bochs, build, `serve.mjs`.

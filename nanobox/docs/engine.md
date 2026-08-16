# nanobox engine — a faster x86-64 browser VM, byte-identical to the Bochs engine

The engine track (formerly `nanobox/claude`, now the top level of `nanobox/`): sources, scripts,
harness, pages. Big build trees / toolchains / wasm outputs / images are gitignored and reproduced
by `build-all.sh` / the `npm run build:*` scripts; `npm run pack` assembles a self-contained `dist/`.
See the top-level README for the npm script index and `docs/sandbox.md`, `docs/system-node.md`,
`docs/claude-native.md`, `docs/hotpaths-codex.md`, `docs/jit-examples.md` for the later rounds.

## The plan (and why)

The reference is the container2wasm **WASI/Bochs** engine (`public/c2w/wasi/out.wasm.gzip`):
Bochs (ktock fork @ a88d1f6) built with wasi-sdk 19, `-O2`, `--enable-handlers-chaining`, an
**Asyncify-based setjmp/longjmp** shim (every guest fault unwinds/rewinds the whole wasm stack and
every function pays Asyncify instrumentation), pre-booted with **Wizer**, packed with wasi-vfs.

The user's constraints: the optimised engine must reach the sign-in screens of claude/codex/agy
≥10× faster **and produce byte-identical guest memory** to what the Bochs engine produces. Only a
Bochs-derived engine can satisfy the second part: memory identity requires the same devices, the
same BIOS/kernel/rootfs, the same instruction-count-driven timer model, the same trace boundaries
(Bochs syncs the clock and delivers interrupts only at iCache-trace ends, and RDTSC reads the tick
count of the last sync). So:

1. **Keep Bochs as the machine model** (memory block table, devices, timers, iCache traces).
2. **Make it deterministic** so identity is testable at all: fixed CMOS `time0`, fixed RDRAND seed,
   frozen host clock in the harness, no network in tier-1 tests. (Verified: two runs of the
   reference engine give identical icount / ticks / SHA-256 of all 1 GiB of guest RAM at every
   checkpoint.)
3. **Remove the Asyncify tax**: rebuild with wasi-sdk 33 + native wasm exception-handling
   setjmp/longjmp (`-mllvm -wasm-enable-sjlj`). Zero cost when no fault; a fault is a wasm throw.
4. **Add a trace JIT inside Bochs**: for each iCache trace, emit a wasm function (bytecode built in
   C++, instantiated by the JS host, called through the function table) that executes the trace
   with the *exact* chaining semantics (`RIP += ilen; exec; prev_rip=RIP; icount++; async_event
   check; ...`), inlining the hot instruction templates (ALU/mov/lea/branches/TLB-fast-path memory
   ops, lazy flags kept in Bochs' own representation) and single-stepping any other instruction
   through Bochs' own handler. Guest registers/RIP/icount live in wasm locals for the duration of a
   trace; a `try/catch_all` around the trace spills them (and prev_rip/RIP/icount of the faulting
   instruction) before rethrowing, so faults see the architectural state Bochs expects.
5. **Verify continuously** with the differential harness (below) — reference vs optimised must
   match (label, icount, ticks, sha256) at every checkpoint. Any divergence bisects to the first
   differing trace.

## The sandbox (Linux-only image + first-run installer + persistent tree) — `docs/sandbox.md`

`web/sandbox.html?cli=claude|codex|agy`: the VM boots `linux-base` (busybox + glibc + libstdc++, 3.9 MB — no
node, no CLI) while an installer on the browser's V8 (`web/native/installer.js`) fetches node 22 + npm and
the CLI from the vendors' servers (registry.npmjs.org directly, Google's agy tarball through the relay),
verifies sha512, lays them out like `npm install -g` in ONE persistent tree (OPFS `nanobox-persist/`,
shared by every page on the origin) that the container bind-mounts over `/usr/local /root /home /var`
(`web/sandbox-worker.js` = `opt-worker.js` + a writable `bundle/persist` subtree; `wasifs.js` grew the
WASI write ops; guest writes are journaled back to OPFS). Second visit: nothing downloaded. Sign-in
(headless Chrome, cold → warm): claude 5.5 → 4.8 s, codex 11.3 → 8.0 s, agy 22.5 → 20.3 s; bytes from our
origin cold ≈ 47–49 MB (engine 29.8 + kernel bundle 12.8 + image 3.9 + pages), warm ≈ 0; from the vendors
cold 73 / 177 / 110 MB (node 54.6 + the CLI). `./build-linux-base.sh`, `test/sandbox-matrix.sh`,
`tools/sandbox-report.mjs`, results in `web/results/sandbox-*.json`.

## The browser artifact (the deliverable)

```sh
node serve.mjs                # http://localhost:8093/   (needs ../public/c2w = the shipped runtime + images)
```
`index.html` links to `claude.html`, `codex.html`, `agy.html`. Each page boots the same container image on
two engines **at the same moment**: the **original** container2wasm/Bochs engine exactly as shipped
(`public/c2w/wasi/out.wasm.gzip`, stock worker, network-9p rootfs) in the top frame, and the
**optimized** engine (`build/eh-nb`) below; a timer under each stops when that CLI's sign-in screen is
on the terminal — that is the reported number. `vm.html?engine=orig|opt&image=…&jit=L:T` runs one
engine alone. `test/e2e.mjs <image> [--engine opt|orig] [--jit L:T]` drives the pages in headless
Chrome (CDP :9222) and prints the timers, an activity profile and screenshots.

Measured in headless Chrome 151 (this devcontainer, 8 cores shared with the other bots' runs, so
absolute numbers are noisy; each row = one run):

| image (compare page: both engines booted at once) | original engine (shipped) | optimized engine (this track) | speedup |
|---|---|---|---|
| **codex** | **54.6–59.3 s** | **6.8 s** | **8.0–8.7×** |
| **agy** | **77.1 s** | **13.8–15.0 s** | **5.1–5.6×** |
| **claude** (JIT 2:2000; live API via the gateway) | **244.1 s** | **49.3–52.6 s** | **4.6–4.9×** |
| codex, engines run alone | 51–56 s | 7.0 s (bundle) / 7.5 s | ~7.5× |
| earlier today (before regions/templates/batching/bundles) | codex 52.6 s, agy 75.1 s, claude 291.6 s | 8.3 s, 16.8 s, 54.3 s | 6.3×, 4.5×, 5.4× |

Screenshots + JSON of the compare-page runs: `web/results/`. The 10× target is not reached — see
"Where the instructions are" for why the trace JIT gains little on kernel-heavy startups.

Where the 5× comes from: only ~1.4× is CPU (native wasm-EH build) — the rest is the runtime. The
shipped runtime serves the container rootfs to the guest over **guest TCP → SharedArrayBuffer ring →
network stack worker → imagemounter's 9p server**, thousands of `poll_oneoff` round trips per second
at 50–98 % of wall time; the same guest work takes ~7 s in the node harness. The optimized page
unpacks the OCI layers in the VM worker and serves them through Bochs' built-in virtio-9p as a WASI
preopen (512 KiB reads, `cache=loose`), so `runc` starts the CLI 1.0 s after the engine starts.

## Signing in for real (egress), load/run split, browser cache (2026-08-16, fourth round)

* **codex "Sign in with Device Code" failed** with `error sending request for url (https://auth.openai.com/...)`
  while claude's preflight worked. Diagnosis (in-guest `RUST_LOG=trace codex login --device-auth`,
  see `test/codex-login-probe.mjs` / `test/vm-cmd-probe.mjs`): the guest→proxy path was fine (busybox
  `wget` over http reached the gateway), codex loaded the proxy CA from `SSL_CERT_FILE`, the TLS
  handshake ran — and rustls dropped the connection after the server certificate. The MITM
  certificates container2wasm's in-browser proxy (imagemounter.wasm / c2w-net-proxy, Go) issues
  have **no `NotBefore`** → Go's zero time, year 1 → webpki rejects it (`BadDerTime`); OpenSSL /
  BoringSSL clients (Bun, Node) accept it, which is why claude never noticed. Fix:
  `patches/c2w-imagemounter-notbefore.patch` + `build-imagemounter.sh` → `build/imagemounter-nb.wasm.gzip`,
  served at `/engine/imagemounter.wasm.gzip` and used by `vm.html` for both engines (`?mounter=stock`
  = the shipped one). Second bug behind it: the `/net/fetch` gateway forwarded the upstream
  `content-encoding: gzip` after node's fetch had already decoded the body → the browser failed to
  decode → empty body → codex "EOF while parsing a value" (the same `ERR_CONTENT_DECODING_FAILED`
  was in claude's console). Now stripped. Result: codex shows the device link + one-time code.
* **Load / run split**: every timer now reads `total (load L + run R)` — load = engine download +
  compile, image unpack, bundle compile; run = VM start → sign-in (`run-start` event; results JSON
  carries `loadMs`/`runMs`). On this container: 6.8 s = 2.7 load + 4.1 run cold.
* **Browser-side cache** (`web/cachefetch.js`, Cache API): engine (ETag-validated by a HEAD, so a
  rebuilt engine is picked up), decompressed OCI layers (content-addressed), JIT bundles. serve.mjs
  answers HEAD and `If-None-Match` → 304. Reload: load 2.7 → 1.0 s. `?cache=0` bypasses.
  Through a port-forward tunnel the first load is dominated by ~170 MB of downloads (that is the
  "35 s" seen remotely); after one visit it is gone.
* Compare pages default to the recorded original time (`?orig=live` boots it), `vm.html` accepts
  quoted `cmd=` arguments, `?netlog=1` logs the network stack's messages.

## Regions, batching, pre-computed bundles (2026-08-16, second round)

Built after the profile showed where the time goes (`TASKS.md` is the live task list):

* **Region compiler** (`nanobox_jit.cc`: `nanobox_form_region`, `TraceCompiler` region mode). A hot
  entry trace plus every trace it reaches through direct JMP/Jcc/CALL/fall-through *inside the
  same physical page* is compiled into ONE wasm function with a dispatch loop; blocks are copied
  out of the iCache (no lifetime dependency); block-to-block transitions do exactly what `cpu_loop`
  does between traces (commit RIP/prev_rip/icount, BX_SYNC_TIME fast path, async_event and
  prefetch-window checks) but branch instead of returning. Invalidation needs no registry: the
  region widens its entry's SMC `traceMask` to the union of its blocks, so a write to any block
  flushes the entry through Bochs' own `flushSMC`. Modules are position independent (the region
  descriptor travels in the call argument `entry->jitarg`), so the content cache and bundles serve
  regions too. The divergence finder covers regions (transitions call the fingerprint hook at
  every trace boundary; `nanobox_dbg_cur_entry` keeps the logged entry precise).
* **Batching**: hot traces are compiled into a shared module (≤32 functions, flushed by size or
  after 20 K traces) and installed through hook slot 5 (`install_batch`), with the ~600-byte
  linking epilogue moved into ONE shared function; V8's per-module cost amortises 20×.
* **Clean decode slots**: the decoder only writes the fields an instruction uses, so the JIT's
  content keys (a hash of the decoded `bxInstruction_c`) depended on execution history and the
  same code was recompiled under many keys. `serveICacheMiss` now zeroes the slot first: distinct
  compiles for the codex boot at threshold 500 dropped from 23 K to 4.1 K.
* **Pre-computed bundles** (`web/jit-bundle.js`, `web/jit-host.js`, harness `--jit-bundle-out` /
  `--jit-bundle`, hook slots 3 `lookup` / 4 `note`): every installed module is dumped keyed by
  content hash; the browser fetches `kernel.nbjb` (shared by all images: same kernel) + the image's
  bundle in parallel with the engine, `WebAssembly.compile`s them before the VM starts and answers
  the engine's `lookup` from them (instantiate only). `test/bundle-roundtrip.sh`: record → replay →
  RAM identical; replay at the recording threshold: 0 compiles.
* **Templates** for the top dynamic fallbacks (16/8-bit shifts, ROL/ROR, indirect CALL/JMP, PUSHF,
  ADC/SBB, XADD, CMPXCHG, BTS/BTR/BTC, SSE 128-bit moves/XOR, PREFETCH): handler steps on the codex
  boot 4.46 M → 1.07 M.

Third round (same day): regions became function-shaped (entry → next call/ret, all branch arms)
and may span one adjacent page (second physical page recorded per attach, ITLB-verified at the
cross-page transition, page→entry registry for SMC); measured neutral-to-slightly-negative on the
CLI startups until A3 lands, so they are opt-in (`--jit-region 24` / `?region=24`). Two
determinism findings on the way: kernel/user text is frozen after boot (723 SMC events on kernel
code pages during boot, 3 after; user 0), and guest RAM was uninitialised at first touch (Bochs
carves blocks from a `new`-allocated arena) — fixed by zeroing blocks on allocation.

**`--jit L:T`** — L is the JIT level (0 off, 1 handler-only, 2 templates + linking (normal), 3 = 2 plus
profiling counters), T is the hotness threshold: a trace is compiled once it has executed T times.
The default 2:2000 is where compile cost and coverage balance on these startups (see below);
with a pre-computed bundle, T only gates the on-the-fly compiles of content the bundle lacks.

What the named CPU profile (`build/eh-prof`, `--cpu-prof` + `harness/profsummary.mjs`) says about
the remaining gap: Bochs' handlers-chaining interpreter already runs the kernel-heavy startup at
~52 ns per trace (5–8 instructions), and a JIT'd short trace pays an indirect entry (48 locals),
spill/reload and the link function (~22 ns) — so lukewarm kernel traces don't gain, which is why
lower thresholds cost more than they give even at zero compile cost. The lever is A3 in TASKS.md:
keep registers/flags in locals across in-region transitions and turn in-region back-edges into
loops (as the single-trace self-loop already does — that is where Claude's 2.5× comes from).

**Memoized baselines (dev loop).** `test/identity.sh` caches the reference engine's DUMP lines per
reference build under `work/identity/ref-cache/` (a run is ~10 s instead of ~22 s; `--fresh`
re-records). The compare pages accept `?orig=recorded` (what `test/e2e.mjs` uses by default when
`web/results/<image>-orig.json` exists) to show the recorded original sign-in time instead of
booting the original; `node test/e2e.mjs <image> --engine orig --record` refreshes a recording.
The pages linked from the index still boot both engines live.

**Harness caches (dev loop, 2026-08-16).** `run.mjs --oci-cache DIR` keeps every *decompressed* layer
tar under `DIR/<digest>.tar` (`web/oci.js` cache hook; only the node harness uses it): the OCI step
drops from ~2.5 s (fetch + gunzip 100 MB) to ~0.15 s (read + untar, contents stay views into the tar).
`--checkpoint-out FILE --checkpoint-at LABEL` (JIT off) writes the engine's whole state — the wasm
linear memory (~1.15 GB raw, or ~106 MB with `--checkpoint-gz`) plus the JS-side wasifs fd table
(fds re-resolved by canonical path), netstub queues and console state — when the guest prints
`@@NANOBOX-DUMP:LABEL@@` (or at `--expect` with LABEL `expect`); the memory is captured at the *next
trace boundary* through the engine's dbg hook, never inside the fd_write that carries the marker
(that would drop the device continuation on the wasm stack). `--checkpoint FILE` grows a fresh
instance's memory, copies the image in, restores the JS state and lets `_start` (`wizer.resume` →
`main` → `bx_begin_simulation` → `cpu_loop`) resume the guest; `--jit L:T` may be added at restore.
`test/checkpoint-roundtrip.sh`: record at `s1` (JIT off) → restore with `--jit 2:2000` → straight
`--jit 2:2000`: DUMP lines identical (ticks + RAM SHA-256). A restore costs ~0.5 s (raw read) + ~0.45 s
verification hash (skipped with `--no-hash`); a checkpoint at codex' sign-in screen saves ~6 s per
iteration on what follows (e.g. `--type '\r@0' --expect auth.openai.com`).

## claude-npm (system Node.js) and the native-V8 page (2026-08-16, fifth round)

Full write-up: `docs/claude-native.md`. In short:

* **`claude-npm` image** (`guest/claude-npm/Dockerfile`, `./build-claude-npm.sh` → `/c2w/images/claude-npm/`
  + `web/images/claude-npm/`): Claude Code installed with `npm install -g @anthropic-ai/claude-code@2.1.112`
  on the official Node.js 22.23.2 binary, over the same minimal Ubuntu rootfs (63 MB compressed).
  2.1.112 is the last npm release that ships `cli.js`; from 2.1.113 the npm package only downloads the
  Bun executable. Emulated (optimized engine, `node test/e2e-claude-npm.mjs`, `web/results/claude-npm-opt.*`):
  **sign-in at 84.4 s** (load 2.2 + run 82.1) after **7.84 G guest instructions** — 2.3× fewer instructions
  than the Bun image (17.9 G) yet 1.65× slower, because Bun's instructions were one JIT-friendly GC loop
  and node's are a flat V8/ICU profile (50 % of user time in 34 pages instead of 1; `work/prof/claude-npm-pages.txt`).
* **`web/claude-native.html`** (+ `web/native/`): the same `cli.js` (taken from the image, mechanical
  ESM→CJS transform, `web/native/cli.json` records the SHA-256) executed on the browser's V8 in a Web
  Worker behind a Node-compat layer whose every file/tty/process/socket operation goes through one
  RPC-shaped **syscall backend** object (`web/native/src/backend.js`; backend #1 = in-memory rootfs from
  the OCI layers + `/net/fetch` gateway; a `SyncChannel` lets a guest-side backend in another worker
  answer synchronous calls through `Atomics.wait`). **Sign-in screen in 1.0–1.3 s** warm (rootfs 65 ms +
  bundle 250 ms + run 0.6–0.9 s), 1.8 s cold (`node test/e2e-native.mjs`, `web/results/claude-native.*`);
  the recorded missing-API list is 5 properties (`fs.watch/watchFile`, three environment probes), 11
  child processes (`which`, `rg`) and 4 HTTP requests before the screen. **`?backend=vm`** plugs in
  backend #2 (`web/native/src/backend-guest.js` over the VM track's `nbnode` shim + `guest.js`/`proto.js`/
  `hcring.js`, `docs/system-node.md`): the emulated guest does files, tty and child processes for real
  while the JS runs on V8 — **sign-in in 4.0–4.3 s** (VM boot to the shim's HELLO 2.1–2.4 s + run 1.6 s,
  0.59 G guest instructions; `web/results/claude-native-vm.*`), 20× the fully emulated node. No memory
  identity by construction — a separate track. Beyond sign-in: pty children, xdg-open, a real OAuth
  callback listener (the paste-code path works), watchers — see the doc.

## Memory identity (the second requirement)

`test/identity.sh [codex|agy|both]` boots the image to its sign-in screen on the **reference**
engine (`build/ref-nb`: this Bochs tree built with the upstream toolchain — wasi-sdk 19, Asyncify
setjmp/longjmp, wizer 3, wasi-vfs 0.3 — interpreter only) and on the **optimized** engine
(`build/eh-nb`: wasi-sdk 33 + native wasm EH + the trace JIT), under the deterministic harness
(frozen host clock, scripted console, in-memory OCI rootfs, `netstub.js` network), snapshots all
guest RAM the instant the sign-in text reaches the console and compares ticks + RIP + SHA-256 of
every RAM block:

```
codex: identical ticks=1461301689 sha=7590aec27691…  (8097 JIT-compiled traces live)
agy:   identical ticks=2053098194 sha=8ad37c8f3f0e… (11955 JIT-compiled traces live)
```
The same holds for JIT-on vs JIT-off of the optimized engine. What had to change to make identity
*testable* at all (all under `NANOBOX_DETERMINISTIC`, in both builds): fixed CMOS `time0`, fixed
`srand`, deterministic 9p metadata (path-hash inodes, fixed timestamps, zeroed stat padding), and —
found today — the **slowdown timer** re-armed itself with a host-time-dependent period (MAX×Q vs Q),
which moves `BX_SYNC_TIME` points, hence trace boundaries, hence the instruction at which interrupts
are taken: every Wizer pre-boot snapshotted a slightly different guest (ticks 787.2 M … 788.6 M
between rebuilds). Now the period is fixed and the engine never sleeps on the guest's behalf, so the
guest schedule is a pure function of its own instruction stream — in the harness, in wizer and in
the browser. `claude` is excluded from the identity test because Claude Code's preflight needs a live
`https://api.anthropic.com` (with a dead network it exits with ENOTFOUND before any prompt). In the
browser it does reach its sign-in screen on both engines: Claude Code is a Bun binary that ignores
the `SSL_CERT_FILE` the runtime sets for its in-browser TLS proxy, so both engines launch it as
`/bin/env NODE_EXTRA_CA_CERTS=/.wasmenv/proxy.crt /usr/local/bin/claude` (found today: the 9p root
also gave every host share the same qid, so with two shares — `.wasmenv` + `bundle` — the guest
merged them into one inode; shares now get distinct qids).
`icount` is *not* part of the criteria: Bochs' fast-string chunking makes it host-dependent while
being guest-invisible (it differs by ~20 in these runs).

## Debugging: the divergence bisector

`harness/bisect.mjs A.wasm B.wasm [--a-args ..] [--b-args ..] [--every N] -- <run.mjs args>` finds
the first trace at which two runs diverge. Level 1: both engines log a chained hash of the full CPU
state (GPRs, RIP, prev_rip, lazy flags, eflags, icount, ticks, async_event) every N traces — the
"snapshot every N instructions" stream, nearly free; the first differing block bounds the divergence
to N traces, all earlier blocks are provably identical. Level 2: both rerun with per-trace detail
only inside that window (registers, flags, ticks, physical address, decoded opcode list) and the
first differing line is printed with a field-level diff and the opcode list of the trace that
produced it — i.e. the x86 instruction (template) that went wrong. Two levels cost 2 runs per side
instead of log2(N); the old `finddiv.sh` is the shell prototype of the same idea. It found every JIT
bug so far (repeat-icount rebase, CL-count shift flag caching, zero-count 32-bit shifts, stale
loop-header registers, async-event entry, …). Run on reference-vs-optimized(JIT) over the whole codex
boot it reports the first difference at trace #73,220,983, a `REP MOVSD`, where only `icount`
differs by 3 (the fast-string chunking) and every register/flag/tick is equal — `--ignore-icount`
drops that field from the fingerprint (engine dbg mode bit 4) and then finds no divergence at all.

**Unattended gate.** `test/gate.sh` runs the whole correctness story without anyone in the loop:
identity (codex + agy, reference vs optimized+JIT) and the bisector on codex (interpreter vs
`--jit 2:200`, chained fingerprints every 100 K traces, per-trace detail on the first differing
block) and writes `work/gate/latest.md` (+ raw logs) ending in `GATE-DONE rc=…`. Launch it detached
after every engine build (env flags such as `NANOBOX_JIT_MERGE=1` are inherited by every run) and
read the report. `test/record-bundles.sh [all|"kernel codex"]` is the matching unattended
re-recording of the pre-computed bundles (kernel / codex / agy / claude, page-eager) that every
engine rebuild needs (bundles are engine-tag keyed) — `work/prof/record-bundles.log`, ends with
`RECORD-DONE`. The gate caught the first version of the merged push/pop runs (below): the fast-path
failure deopted to the interpreter mid-trace, which is memory-identical but inserts an extra trace
boundary → the bisector reported the trace at 0x589009 (`PUSH PUSH LEA PUSH …`) with `ic +1, rsp −8`
on the JIT side; the fix keeps the slow path inside the trace.

## Stack peepholes / register file experiments (2026-08-16, third round)

* **Merged stack runs** (`NANOBOX_JIT_MERGE=1` → `nanobox_set_jit_merge(1)`; off by default): a run of
  2–8 register/immediate PUSHes (or POPs not into RSP) becomes ONE span-in-page + alignment check,
  ONE TLB probe (write or read permission on the page holding the whole span), one "page carries no
  code marks" check, N plain `i64.store`/`i64.load` at fixed offsets from the probed host address and
  a single RSP update; when any condition fails the run executes instruction by instruction through
  Bochs' `stack_write_qword`/`stack_read_qword` with RIP/icount committed before each one (exact
  #PF/#SS/SMC semantics), still inside the trace. Both paths leave the same compile-time register
  cache state (checked at compile time). Identity holds (codex `ad36511e3f31`, agy `9526e94cefe9`,
  ticks equal), gate clean.
* **Register file in wasm globals** — tried (sub-agent, `-DNANOBOX_JIT_GLOBALS`), correct, +4 %
  slower, removed. The JIT already keeps registers in wasm locals inside a trace/region; imported
  mutable globals only made the JIT↔C++ boundaries copy all 18 registers in and out.
* Impact (harness, codex boot → sign-in, OCI cache, no bundle, `--jit 2:2000`, 3 runs each, serial on
  an idle container; run-to-run noise is ±0.4 s):

  | engine | runs (s) | vs baseline |
  |---|---|---|
  | eh-nb (baseline) | 7.46 / 7.30 / 7.12 | — |
  | eh-nb + `NANOBOX_JIT_MERGE=1` | 7.32 / 6.99 / 7.13 | ≈ −2 % (noise-level; agy unchanged) |
  | registers in wasm globals (removed) | 7.56 / 7.49 / 7.69 | ≈ +4 % (net loss) |

  `docs/jit-examples.md` shows the SAME guest trace compiled with and without the peephole, annotated
  (`tools/jit-diff-example.mjs` pulls a trace by content key out of two recorded bundles;
  `tools/wasm2wat.mjs` disassembles a dumped module).
  Neither moves the needle: register traffic between traces is already dirty-only at constant
  addresses, and V8 reaches imported mutable globals through an indirection, so the globals build
  only adds the 18-element sync at every cpu_loop/handler boundary; merged stack runs save a probe
  per extra push/pop but pushes are ~5 % of executed instructions. Both stay behind their flags
  (details in TASKS.md H1/H2). The counters point at the real remaining lever: 10 M returns to
  cpu_loop per boot because the NEXT trace is not compiled (`linkFail[4]`) and 21.9 M fetch-window
  refills (`linkFail[2]`).

## Where the instructions are (per-address profile)

`run.mjs --pages FILE` + `pages.mjs FILE`: the engine counts retired instructions per 4 KiB page of
linear address space (Bochs traces never cross a page, so one increment per trace with the icount
delta is exact) with the physical page behind it and the CPL. Findings for the three CLIs, boot →
sign-in (or exit for claude), see `work/prof/*`:

| | instructions | kernel / user | pages for 50 % / 90 % of kernel | of user | avg trace len K / U |
|---|---|---|---|---|---|
| codex | 0.63 G | 38 % / 62 % | 15 / 73 pages | 10 / 142 pages | 5.3 / 7.8 |
| agy | 1.24 G | 27 % / 73 % | 12 / 56 | 10 / 132 | 5.5 / 8.8 |
| claude (Bun) | 19.3 G | 4 % / 96 % | 14 / 51 | **1 / 7** | 4.9 / 9.9 |

So: extremely concentrated. Codex' hottest page (6 % of everything) is a base64 decoder; Claude
Code spends **68 % of all its instructions in ONE 4 KiB page** (84 % in two) of the Bun binary.
`--focus 0x46a9000:FILE` (per-offset histogram inside that page) + `--save-phys` + objdump show what
it is: two JavaScriptCore garbage-collector sweep loops (`0x46a93c0`: set-bit loop `shl %cl,%rdx;
or %rdx,0xa8(%rax,%rsi,8)` over 1024-cell blocks — 5.3 G instructions; `0x46a9410`: the sweep that
clears cells `movl $0,(%rsi); movl $2,8(%rsi)` and their bitmap bit `rol %cl,%r9; and %r9,…` —
6.0 G). 11.7 G of Claude Code's 19 G instructions are ~40 bytes of GC code (Bun's JSC heap churning
while it loads its 100 MB bundle) — a tight user-mode loop, the ideal JIT target: with `--jit 2:2000`
the harness reaches Claude Code's first screen in **59.5 s instead of 148.5 s (2.5×)**; the
remaining cost is the `ROL`/`SHL-by-CL`-to-memory forms that still take the handler path.
Kernel code is 4–5 instructions per trace on average (branchy, interrupt-heavy), user code 8–10:
that is why the trace JIT (which pays a fixed per-trace cost for linking, sync and async checks)
gains little on kernel-heavy startups and a lot on user loops. Yes, virtual memory is fully
emulated: every guest memory access is linear→physical through Bochs' page walker/TLB (with the
JIT's inlined DTLB fast path) and then physical→host through the block table — two indirections;
the profile also records pages whose physical backing changed during the run (123–224 per CLI).

## Research: WasmLinux / linux-wasm / wasm-native runtimes

`docs/wasm-linux-research.md` — verdict: not worth it for this use case (both wasm kernels are
NOMMU proofs of concept without fork/mmap/signals; a user-mode x86-64 DBT would still have to be
written; Node-in-wasm exists only as interpreter builds; 2 of the 3 CLIs must stay x86-64).

## Layout

```
serve.mjs             static server for the artifact (+ /net/fetch egress gateway, COOP/COEP)
web/                  index.html, {claude,codex,agy}.html (compare pages), vm.html (one engine),
                      opt-worker.js (VM worker: JIT host, heartbeat, direct rootfs), jit-host.js,
                      wasifs.js (in-memory WASI fs with symlinks/modes), oci.js (OCI layout →
                      rootfs tree), netstub.js (deterministic ARP/DHCP/DNS/TCP-RST peer),
                      src/nb-worker-util.js (fork of container2wasm's worker-util; esbuild → dist/),
                      images/<image>/{config.json,imageconfig.json} (runtime spec, generated by
                      work/c2w-src/extras/imagemounter/genspec)
test/e2e.mjs          drive the pages in headless Chrome, print timers/profile, screenshots
test/e2e-claude-npm.mjs   claude-npm in the emulated engine (prompts + sign-in read from the terminal)
test/e2e-native.mjs   claude-native.html: time to sign-in + the recorded missing-API list
web/claude-native.html, web/native/   Claude Code's cli.js on the browser's V8 (Node-compat layer, syscall backend)
guest/claude-npm/, build-claude-npm.sh, tools/genspec.mjs, tools/native-prepare.mjs   the claude-npm image + cli.js prep
test/identity.sh      memory-identity E2E (reference vs optimized engine, RAM SHA-256 at sign-in)
test/checkpoint-roundtrip.sh  record a checkpoint at s1 (JIT off) -> restore with JIT -> identical to a straight run
build-bochs.sh        build ./bochs -> build/<name>/out.wasm  (--legacy = upstream toolchain)
work/build-pack-nb.sh guest pack (kernel+init+rootfs) with the patched init -> work/pack-out-nb
bochs/                ktock/Bochs @ a88d1f6 + this track's changes (gitignored clone; see nanobox*.{cc,h},
                      cpu/cpu.cc hook, wasm.cc/wasm.h, iodev/slowdown_timer.cc)
harness/run.mjs       node driver: deterministic host, scripted console (--reply/--expect[-re]),
                      --oci/--spec (in-memory rootfs, --oci-cache), --net (netstub), --jit, --pages, --dbg,
                      RAM dumps + SHA-256, --save-phys, --checkpoint-out/--checkpoint (memory snapshots)
harness/bisect.mjs    divergence bisector;  harness/pages.mjs  profile analysis;  compare.mjs
docs/                 research notes, docs/jit-examples.md (annotated JIT output with/without the experiments)
work/                 toolchains, c2w sources, packs, profiles (gitignored)
```

## Status log

- 2026-08-15: reproduced the upstream engine build natively (`build/ref`); tier-1 harness works;
  determinism verified (identical dumps run-to-run). Baseline: ~30–80 MIPS on the cputest phases,
  ~18 MIPS on SSE/AVX2 code (V8, Ryzen 7950X). Profile: flat over Bochs handlers (interpreter
  dispatch), i.e. a JIT is the lever; hashing dumps is a harness cost only.
- 2026-08-15 (cont.): wasi-sdk 33 + native wasm-EH setjmp/longjmp build (`build/eh-*`): ~1.4× over
  Asyncify. Trace JIT (`bochs/bochs/nanobox_jit.cc`, host side `harness/run.mjs` / `web/jit-host.js`):
  identity holds on boot/cputest/loops (ticks + RAM sha); 4–10× on user-mode loops, but a net loss
  on the kernel/9p-heavy CLI startups (tiny linked traces, handler steps) — the JIT is opt-in
  (`--jit L:T`) until that is solved. Measured the ORIGINAL engine in Chrome: codex sign-in at
  ~51–56 s, of which the node harness needs ~13 s for the same guest work → the browser runtime,
  not the CPU, is the bottleneck: the container rootfs is served over guest-TCP → stack worker →
  imagemounter (SharedArrayBuffer polling), ~3000 poll_oneoff/s at 50–98 % wall.
- 2026-08-16: **direct rootfs path** for the optimized engine. The OCI layers are fetched and
  unpacked in the VM worker (`web/oci.js`) into an in-memory tree with symlinks + modes
  (`web/wasifs.js`, answers the WASI calls for one extra preopen in front of the shim; modes ride
  in the filestat `dev` field, tagged `0x6e62`, and the engine's 9p server honours them) and served
  to the guest through Bochs' built-in virtio-9p (`--external-bundle=9p=virtio:bundle`, patched
  guest `init`: mounts wasi0 with `msize=524288,cache=loose`, resolves the bundle under
  `/mnt/wasi0/<name>`; patched wasi-vfs 0.6.3 skips container2wasm's non-directory socket-fd
  prestats). Guest pack rebuilt → `work/pack-out-nb`, engine `build/eh-nb`. Deterministic network
  stub `web/netstub.js` (ARP/DHCP answered, DNS→NXDOMAIN, TCP→RST) so `--net` boots without a
  stack worker (harness `--net`/`--oci`/`--spec`). Result in the harness: `runc` execs the
  container command **1.0 s** after start (was ~8 s to the shell prompt + a 100 MB copy before).
- 2026-08-16 (later): all three compare pages measured (codex 52.6→8.3 s, agy 75.1→16.8 s, claude
  291.6→54.3 s); memory identity proven at the sign-in screen for codex/agy (reference vs
  optimized+JIT, ticks + RAM SHA-256; the bisector finds no divergence over 168 M traces); found and
  fixed two more determinism leaks (slowdown-timer host-time coupling, `time0=local` in the pack)
  and two runtime bugs (virtqueue too small for msize=512K, identical qids for host shares); added
  the per-page instruction profiler (+focus histogram), `bisect.mjs`, `netstub.js`,
  `--reply/--expect-re/--save-phys/--pages/--focus` in the harness; research notes in `docs/`;
  patches exported to `patches/`.
- 2026-08-16 (round 2, "build this and test E2E"): region compiler + SMC-mask invalidation, batching
  with a shared link function, clean decode slots (content-key stability), pre-computed bundles
  (kernel + per image, browser preload), 20-odd new templates, bisector improvements; identity
  re-verified (codex `ad36511e3f31`, agy `9526e94cefe9`, reference vs optimized+JIT; bundle
  round trip identical); compare pages: codex 54.6→6.8 s (8.0×), agy 77.1→13.8 s (5.6×), [re-measured
  16:41 after the third-round rebuild + bundle re-recording: 6.8 s / 15.0 s / 52.6 s]
  claude 244.1→49.3 s (4.9×). Found: an out-of-range register write in the CMPXCHG memory form
  (bisector caught it), the batch-hook detection comparing a table index instead of probing.
- 2026-08-16 (round 3): function-shaped two-page regions (opt-in), SMC-after-boot measurement,
  uninitialised-RAM fix (blocks zeroed on allocation), harness `--smc/--watch/--dump-start/
  --init-only`; identity re-verified (codex `ad36511e3f31`, agy `9526e94cefe9`); compare page
  codex 59.3→7.6 s (7.8×) with the final engine + bundles.
- 2026-08-16 (round 4): A3 (registers/flags live across in-region transitions, per-block region
  entry points), regions on by default (function-shaped, two pages, kernel-text mapping trusted at
  cross-page transitions), page-eager sweep for bundle recordings (`NANOBOX_JIT_EAGER=1`), memoized
  reference dumps + recorded original sign-in times, harness memory checkpoints (`--checkpoint-out/
  --checkpoint`, restore identical, ~6.5 s saved per iteration) and an on-disk OCI layer cache
  (`--oci-cache`, 2.6 s → 0.15 s); identity re-verified (codex `ad36511e3f31`, agy `9526e94cefe9`).
  30-second discipline for every foreground command; the harness `--timeout` now fires from inside
  the VM's poll (a JS timer never could) and the bisector defaults to a 30 s watchdog per run.
- 2026-08-16 (fifth round): `claude-npm` image (npm-installed Claude Code 2.1.112 on Node 22; emulated
  sign-in 84.4 s / 7.84 G instructions vs Bun 49–53 s / 17.9 G) and the native-V8 page (`claude-native.html`,
  sign-in in ~1.0–1.3 s with the in-memory backend, 4.0–4.3 s with `?backend=vm` = files/tty/processes in
  the emulated guest through the nbnode shim) — `docs/claude-native.md`.
- 2026-08-16 (third round): two register/stack experiments behind flags, run serially (see "Stack
  peepholes / register file experiments"): merged push/pop runs (`NANOBOX_JIT_MERGE=1`) ≈ −2 %, in
  the noise; registers in wasm globals ≈ +4 %, a negative result — removed again (the JIT already keeps
  registers in wasm locals inside a trace). Both were gate-clean. New `test/gate.sh`: identity + bisect end-to-end without interaction, report in
  `work/gate/latest.md`; it caught the first (deopting) version of the merge peephole through the
  extra trace boundary it introduced.

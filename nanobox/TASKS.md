# nanobox — open tasks & investigations (goal list)

Status legend: [ ] todo · [~] in progress · [x] done. Everything is E2E-gated: `test/identity.sh`
(RAM identity vs the reference engine), `harness/bisect.mjs` (first divergent trace), `test/e2e.mjs`
(browser timers on the three compare pages).

## A. Region compiler ("whole functions", O(1) re-entry, stamp invalidation)
- [x] A1 Region formation: hot entry trace + statically reachable traces (direct JMP/Jcc/CALL targets,
      fall-through) within the same physical page; blocks copied out of the iCache (no iCache
      lifetime dependency); one wasm function per region with a dispatch loop; block-to-block
      transitions replicate the interpreter's trace-boundary semantics inline (commit RIP/icount,
      BX_SYNC_TIME fast path, async_event check, prefetch-window check).
- [x] A2 Invalidation (done without a registry: the region widens its entry's `traceMask` to the
      union of its blocks and marks the page's write-stamp chunks, so Bochs' own `flushSMC` drops
      the entry — and with it the region — on a write to any block; region content stays in the
      content-keyed cache and is re-attached when the same bytes come back).
- [x] A3 Registers/flags stay in wasm locals across in-region transitions: each block has a fixed
      entry state D_j (registers/flags it touches, found in a dry-run pass); transitions store what
      the target does not track, load what it lacks, and jump; only paths that LEAVE the region
      commit+spill. Every block is now an entry point (per-block entry descriptor in `jitarg`:
      {region, block, RIP delta}; all member iCache entries get the translation, SMC masks widened
      per member, page registry per member) — links into region middles no longer fall back to
      the interpreter. Regions are on by default again (two pages, function-shaped).
- [ ] A4 Mirror map: per physical code page a lazily allocated shadow array offset → (fn, block) so
      cross-region CALL/JMP/RET dispatch is two loads instead of the iCache hash+compare; RET via a
      return-address stack cache.
- [x] A5 (two-page form) Regions may span the entry's page + one adjacent linear page (functions
      straddling a boundary): the second page's physical frame is recorded per attach in the region
      descriptor, cross-page transitions verify it through the ITLB and switch the fetch window like
      prefetch(); writes to the second page reach the region through a page→entry registry consulted
      from handleSMC. Regions are now function-shaped (entry → next call/ret, all branch arms).
      Measured on codex boot: regions ≈ 0.4 s slower than plain traces (transitions still spill/
      reload) → region formation is OPT-IN by default (`--jit-region 24`, page `?region=24`) until A3.
- [x] E4 Guest RAM was uninitialised at first touch (Bochs carves blocks from a `new`-allocated
      arena whose first bytes are recycled heap) → guest low memory started with host-heap garbage that
      depended on the engine's own allocation history (found by RAM-diff + an in-engine watchpoint
      during the wizer boot: byte 0x6fcc). Blocks are now zeroed on allocation.
- [x] E5 SMC measurement (codex boot → sign-in): kernel code pages: 723 write events during boot,
      **3 after** it; user code pages: 0 after boot → kernel/user text is effectively frozen after
      boot; the SMC hook stays as the safety net (static-key flips).

## B. Pre-computed translations ("fire the precomputations")
- [x] B1 Engine hooks: `lookup(keyLo,keyHi) -> fn` before compiling, `note(fn,keyLo,keyHi)` after
      install; content key = hash of the region's decoded instructions (position-independent code
      already: L_base-relative addressing).
- [x] B2 Harness: `--jit-bundle-out FILE` dumps every installed module keyed by content hash;
      `--jit-bundle FILE` preloads (identity/bisect must still pass with a bundle).
- [x] B3 Browser: fetch the bundle(s) with the image, `WebAssembly.compile` them asynchronously before
      the VM starts, answer `lookup` from the precompiled set (instantiate only). Kernel bundle is
      shared by all images (same kernel) and injected at engine start; per-image bundle for the CLI.
      Preloaded kernel translations don't count against the runtime cache budget.
- [~] B4 Threshold policy: with a bundle present, on-the-fly compile only after ≥2 executions
      (`--jit L:2`); without, keep the current threshold; measure both.
- [x] B5 Page-eager sweep for recordings (`NANOBOX_JIT_EAGER=1` in the harness): when a trace gets
      hot, decode + compile every trace statically reachable in its page (branches, fall-throughs,
      callees, call continuations) so a recorded bundle covers whole pages ("JIT for all program
      pages"). Kernel: recorded from the boot (`/bin/true`) and preloaded at engine start.

## C. Templates the profiles point at
- [~] C1 done: 16/8-bit shifts, ROL/ROR imm, CALL/JMP indirect, PUSHF, PUSH imm8, ADC/SBB (all
      forms), XADD, CMPXCHG (reg+mem), BTS/BTR/BTC imm, SSE 128-bit moves (MOVUPS/MOVAPS/MOVDQU/
      MOVDQA/MOVUPD/MOVAPD, XORPS/XORPD/PXOR reg, MOVQ), PREFETCH*. Handler steps on codex boot
      4.46 M → 1.07 M. Still open: memory-operand shifts/rotates/BT*, MUL/DIV, REP string fast paths.
- [ ] C2 SSE moves (MOVUPS/MOVDQU/VMOVSD), REP STOS/MOVS fast paths, PUSHF/CLI/STI, CALL_Eq/JMP_Eq.

## H. Register file / stack peepholes (experiments behind flags, measured serially)
- [x] H1 Merged stack runs (`NANOBOX_JIT_MERGE=1` in the harness → `nanobox_set_jit_merge(1)`): runs of
      2–8 register/immediate PUSHes (or POPs, dst ≠ RSP) compile to ONE span-in-page + alignment check,
      ONE TLB probe, ONE "page carries no code marks" check, N plain stores/loads at fixed offsets and a
      single RSP update; otherwise the run executes instruction by instruction through Bochs' stack
      accessors INSIDE the trace (v1 deopted to the interpreter: memory-identical but the extra trace
      boundary showed up in the bisector as `ic+1, rsp−8` at 0x589009 — fixed). Gate clean with the
      flag on (identity codex/agy identical, bisect 958 blocks no divergence). Impact, serial on an
      idle container (codex boot → sign-in, OCI cache, no bundle, --jit 2:2000, 3 runs):
      off 7.46/7.30/7.12 s, on 7.32/6.99/7.13 s → ≈ −2 %, inside the ±0.4 s run-to-run noise; agy no
      change (10.67 vs 10.82 s). Kept OFF by default (flag stays for later stacking).
- [x] H2 Register file in wasm globals — built (`-DNANOBOX_JIT_GLOBALS`, sub-agent), correct (bisect +
      identity clean), measured serially: 7.56/7.49/7.69 s vs 7.46/7.30/7.12 s baseline (+4 %) →
      REMOVED (source tree, build, patch, host `g.*` plumbing). Reason: the JIT already keeps registers
      in wasm locals inside a trace/region (one load per register read, one store per register
      written); imported mutable globals are not cheaper than those constant-address moves (V8 reaches
      them through an indirection) and every JIT↔C++ boundary had to copy all 18 in and out. Do not
      retry; the lever is elsewhere (see D5: `linkFail[4]` 10 M cpu_loop returns for "next trace not
      compiled", `linkFail[2]` 21.9 M fetch-window refills).

## I. Hot-path work from docs/hotpaths-codex.md (2026-08-16, agent-measured)
- [~] I1 iCache thrash: 64 K direct-mapped entries + 576 K pool flushed wholesale on wrap re-decoded
      hot traces ~124x per boot and reset the hotness counters (lukewarm code never reached T=2000).
      Now: 256 K entries with a mixing hash, 2304 K pool, per-slot `hot[]` side table that survives
      alloc_trace/flush (a re-decoded trace inherits its counter). Gate + measure.
- [ ] I2 Cheap short traces so T can drop to ~200 (successor cache in the link epilogue, out-of-line
      full DTLB probe, multi-entry probe cache across blocks, trimmed prologue) — the report's −1.0…1.5 s.
- [ ] I3 Cross-page hop refill through the successor cache (`linkFail[2]` 21.9 M).
- [~] I4 Claude: `ROL/ROR r,CL` (JSC GC sweep: 168 M handler steps per 24 s) and `TZCNT/LZCNT` (82 M)
      templates. Gate + measure.

## D. Measurements / investigations
- [x] D1 Per-page instruction profile (kernel/user split, concentration) for the three CLIs.
- [x] D2 Focus histogram inside the hottest page (Claude = JSC GC sweep loops).
- [x] D3 WasmLinux / linux-wasm / wasm-native runtimes research (docs/).
- [ ] D4 Re-measure the compare pages after A/B/C land; report per-image speedups.
- [ ] D5 Where does the remaining time go with regions (per-trace overhead vs handler steps vs
      memory paths) — `--jit 3:*` profiling counters + a per-region hit histogram.

## F. Batching / compile cost (done)
- [x] F1 Multi-function modules (`install_batch`, slot 5; ≤32 functions per module, flushed by size
      or after 20 K traces), shared link function (was ~600 bytes duplicated per trace).
- [x] F2 Decoder slot cleared before decode: content keys no longer depend on execution history
      (compiles for codex boot at threshold 500: 23 K → 4.1 K).

## G. Dev loop
- [x] G3 Harness memory checkpoints (`--checkpoint-out FILE --checkpoint-at LABEL`, `--checkpoint FILE`;
      restore verified IDENTICAL; `test/checkpoint-roundtrip.sh`) and OCI layer cache (`--oci-cache DIR`).
- [x] G4 30 s watchdog: `--timeout` fires inside poll_oneoff; bisect `--run-timeout` (default 30).
- [x] G1 Reference identity dumps memoized per reference build (`test/identity.sh`, `--fresh`).
- [x] G2 Original engine sign-in time recorded per image (`web/results/<image>-orig.json`,
      `test/e2e.mjs --engine orig --record`); compare pages take `?orig=recorded` (e2e default).

## E. Determinism / harness
- [x] E1 Slowdown timer host-time coupling; `time0=local`; distinct qids per host share; virtqueue 256.
- [x] E2 `bisect.mjs` (--ignore-icount), `netstub.js`, `--reply/--expect-re/--save-phys/--pages/--focus`.
- [x] E3 Bisect must exercise regions: in dbg mode transitions call the fingerprint hook at every
      trace boundary (like the self-loop does) instead of disabling linking.

## J. Trace boundaries and frozen code (2026-08-17, measured on the codex sandbox)

Baseline this section is judged against (level-3 codex run, boot + typing, ~15 s): **107.3 M** links
(trace -> trace tail calls), **35.4 M** cross-page fetch-window refills, **5.59 M** hops whose target
was not compiled, epilogue ~35 wasm ops/hop ~= **3.7 G ops** against ~2.5 G guest instructions
emulated. Regions average **2.3 blocks** (formed 980 / blocks 2270) because the former follows only
direct targets already decoded on the same or one adjacent page, so calls and returns always end a
region -- turning regions off costs just 9 %. The in-trace loopback path is the shape to copy: it
keeps registers in locals, skips the hash/lookup/tail call, re-checks async_event and the fetch
window every iteration (which is why identity holds), and costs ~10-12 ops against the epilogue's 35.

- [ ] J1 State in tail-call parameters: pass the hot guest registers AND the icount/countdown pair as
      parameters of the linking tail call instead of committing them to the CPU struct, spilling only
      on paths that can fault or leave to the interpreter. This is the loopback's trick across a
      function boundary; the wasm type system is what forces it into parameters. Changes the trace
      function signature -> re-record every bundle, re-run the gate. Expect the spill/reload and the
      per-hop memory bookkeeping to go; ~10 of ~35 ops.
- [ ] J2 Caller-side successor cache: the trace tail-calls the link epilogue with its own site id, the
      epilogue keeps (pAddr -> iCache entry, jitfn, jitarg) per site and revalidates against the entry
      (entry->pAddr == pAddr, jitfn != 0) so SMC and evictions stay correct. Removes the hash and, on
      the ~67 % of hops that stay on the same page, the fetch-window refill.
- [ ] J3 Frozen code pages. A page that has been decoded as code and survived startup is marked frozen
      in the table the TLB probe already consults; stores to a frozen page skip the write stamp
      entirely AND stop forcing `needAsyncCheck` (today any trace with a store must check async_event
      because handleSMC signals through BX_ASYNC_EVENT_STOP_TRACE). Precedent: `regionKernel` already
      assumes kernel text is fixed after boot ("3 SMC events after boot"). Wasm has no page
      permissions, so a violation is a software test, not a trap: hard error for workloads declared
      static (codex is a static musl binary), deopt-and-unfreeze for guests that legitimately emit
      code (kernel module load, ftrace, a JIT inside the guest).
- [ ] J4 The payoff of J3: with code known frozen, decode and compile AHEAD of execution across
      boundaries -- superblocks with inlined direct calls -- instead of discovering successors only
      once they have been decoded. This is the only item that removes boundaries rather than making
      each one cheaper, and the .nbjb bundles are already the AOT delivery mechanism for it.
- [ ] J5 Not to be done: checking async_event/timers only every Nth hop. The decision must stay at
      every boundary or interrupts land on a different instruction than the interpreter picks and
      guest RAM diverges -- that is exactly what test/identity.sh asserts. Worth at most ~6 % (the
      per-hop bookkeeping), all of which J1 gets soundly.

### J results (2026-08-17, four variants built and measured in parallel, integrated in sequence)

Machine noise, established over 6 interleaved baseline runs: **±4 % MIPS, ±8 % boot, ±8 % keystroke**.
Anything below ~5 % is unresolvable here, so every number under that is reported as noise, not as a win.

- **J5 (ceiling, throwaway build `build/j5`) — the epilogue is not where the time is.** Deleting ~30-40 %
  of its ops moves throughput by −6 %…+3 %. Deleting every statistics store from generated code: −0.4 %.
  A sound successor cache: −1.6 % ± 5 %. **Checking async/timer every Nth hop is NEGATIVE** (−6.3 % at
  N=8, −3.2 % at N=32) — the hop counter costs what the skipped checks cost and the deferred
  BX_SYNC_TIME makes the epilogue bail to cpu_loop more often, with the guest doing identical work
  (icount to prompt 1.184 G vs 1.186 G). J5's earlier "worth at most ~6 %" is revised to **≤ 0 %**.
  Also: an unrevalidated successor cache WEDGES the guest — not from RET/indirect targets (a RIP compare
  guards those) but from user-space RIP aliasing across address spaces and a cached jitarg going stale
  when an entry is re-decoded at the same pAddr (the trace pool wraps every ~600 K instructions).
  Note the 107.3 M links/15 s baseline was measured under level-3 profiling, which is itself ~9 % slower
  than the shipping configuration.
- **J3 (frozen pages, `build/j3`) — correct, cheap, and buys nothing on its own.** The JIT store fast
  path **never once** reaches a page carrying code marks in this workload (`link_fail[6] == 0`): `C_free`
  already short-circuits it 100 % of the time, so the fine-granularity lookup J3 removes was never
  executing. `needAsyncCheck` cannot be dropped soundly — a store's target page is unknown at compile
  time, and a private SMC flag would change which instruction an interrupt lands on. **The census is the
  real product: 5,238 code pages frozen at the prompt, ZERO violating stores across boot + typing.**
  Guest code is genuinely immutable after startup, which is what J4 needs. The permissive unfreeze path
  is untested precisely because nothing ever violated.
- **J2 (successor cache, `build/j2`) — no win, but it produced the number J4 needs.** Speed: slower in 6
  of 7 paired runs by 4-10 %, i.e. no win and possibly a small regression (the 196 KB side table is
  extra D-cache pressure, and validating the memo costs about what the ~9-op hash cost). **Successor
  predictability: 79.5 % / 79.1 % hit rate over two runs (80.4 M hit / 20.7 M miss), and that is a
  LOWER bound** — the site id was per compiled module, not per iCache entry, so ~46 % slot collisions
  and ~6 entries per module all counted as misses. Trace successors are highly stable, which is what
  makes J4's compile-time resolution plausible. Correctness note worth keeping: the cache memoises
  `get_entry(pAddr, fetchModeMask)` (a pure function) and never caches `jitfn`/`jitarg`/`ilen` — they
  are re-read from the live entry — which structurally excludes the stale-jitarg hazard that wedged
  J5's oracle.
- **Second measurement trap**: with `--jit-bundle` the shared link epilogue is itself served from the
  bundle, recorded at level 2 where the profiling stores do not exist. A bundled level-3 run therefore
  reads ~11 M links instead of 107 M. **All level-3 counter runs must be bundle-free on both sides.**
- **J1 (timer accounting in tail-call parameters, `build/j1`) — correct, and the only item integrated
  and gated end to end.** `delta`/`countdown` become wasm parameters mutated in place and passed on
  through the tail call, written back only where the interpreter's values can be observed; the pair is
  a cache of memory values at the last boundary, never a deferred decision, so `delta >= countdown` is
  still tested at every boundary at the same instruction. Applied to the main tree it **passed the
  identity gate: RESULT IDENTICAL for codex and agy**. Measured against the engine it replaced (3
  interleaved pairs): keystroke 176 vs 179 ms, boot 7.88 vs 7.45 s, MIPS 95.7 vs 99.1 — better on
  keystrokes, worse on boot, all inside noise. **Reverted from the tree** because the signature change
  invalidates every recorded .nbjb bundle (they would be silently rejected and every user would boot
  with a cold JIT) in exchange for no measurable win. The patch is kept at
  `work/prof/j1-nanobox_jit{,_h}.diff`; re-apply it if J4 needs registers/counters living in locals.
  Gotcha for whoever re-applies it: the Makefile has no header dependency tracking, so reverting
  `nanobox_jit.h` leaves `cpu/cpu.o` referencing `nanobox_countdown_ptr` and the link fails — delete
  the stale object first.
- **Region formation is the bottleneck, not the epilogue.** `nanobox_form_region()` BFSes over direct
  branch targets only, and skips any successor not already decoded (`se->tlen == 0`) or off-page, so
  calls and returns always end a region: 2.3 blocks per region, and disabling regions costs only 9 %.
  **J4 (decode ahead across boundaries, inline direct calls) is the only item left with headroom.**
- **Measurement trap for anyone comparing engines**: `.nbjb` bundles are engine-tag keyed and are
  silently REFUSED by any other build, so passing `build/eh-nb/jit/*.nbjb` to a variant gives the
  baseline precompiled code and the variant none. Record per-engine bundles, or run both with none
  (costs ~0.3 s of boot, nothing in steady state).

### J4 result (2026-08-17): the premise was wrong, and inlining calls regresses

A census of **why** region formation stops (6408 attempts over a codex boot + typing) corrects what this
section previously assumed:

| reason a region stopped growing | count |
|---|---|
| block ended in a direct CALL | **2894** |
| block ended in RET / indirect / syscall | **2088** |
| successor not decoded yet | 1017 |
| successor outside entry page +/-1 | 329 |
| block budget (24) full | **0** |
| instruction budget (320) full | **0** |

So "only accepts a successor already decoded" was the wrong diagnosis by ~5:1 — calls and returns are
what end regions — and **raising NB_REGION_MAX_BLOCKS / NB_REGION_MAX_INSTR is a no-op**: those budgets
never bind. Measured effects:

* decode-ahead alone: blocks/region 2.33 -> 2.52, external links −4.8 %;
* inlining direct CALL targets + continuations: blocks/region -> 3.74; both together **4.65 (2.0x)**,
  external links **−15.6 %** — the mechanism does exactly what it promises statically;
* end to end it **regresses**: boot +17 %, keystroke +19 %, MIPS −8.8 %, every pair regressing and boot
  outside the +/-8 % noise in all three. **Cause is code explosion, not hop count**: the same callee is
  copied into every caller's region, installed wasm goes 24.9 -> 61.2 MB (2.5x), and the region cache
  hit rate collapses (29,466 -> 17,789). The per-hop saving is ~25 ops on 15 % of hops, ~0.4 % of the
  epilogue's ops — it cannot pay for 2.5x the code. Consistent with J1/J5: the machine is not
  op-count-bound.
* a RET guard (compare the popped return address against inlined continuations) converts 1.3-1.6 M
  returns into in-region transitions but costs ~8 % MIPS: it is a linear chain of compares per RET.

The binding constraint for any future superblock work is the region's **single-adjacent-page window**:
11,056 successors rejected for landing outside entry page +/-1, versus 3,537 not-decoded and 53 budget.
Multi-page regions need a per-block page frame, an ITLB check per cross-page edge, a per-page SMC/attach
registry and a deopt when a frame moves — and callee SHARING rather than copying, which is a different
design from a superblock. J4's code is behind runtime flags that default OFF (`NANOBOX_J4_AHEAD`,
`_INCALL`, `_RETGUARD`, `_INSTR`), so the build with no env set is bit-for-bit the baseline.

### Why none of J1-J5 could have helped: the JIT is not where the time is

CPU profile of a full codex boot + typing run (`node --cpu-prof`, 15.6 s, analysed with
`harness/profwindow.mjs`):

| window | engine (Bochs interpreter + dispatch) | JIT'd trace code | JS |
|---|---|---|---|
| whole run | **64.5 %** (10.06 s) | 31.0 % (4.84 s) | 4.0 % |
| steady state (last 5 s, typing) | **83.4 %** (4.17 s) | **15.8 %** (0.79 s) | 0.7 % |

A single engine function is **45.8 % of the whole run and 78.7 % of the steady state**. And the coverage
counters explain it: a level-3 no-bundle run executes **238 M trace executions of which 112 M
(47.1 %) run as JIT'd code** — the interpreted half costs ~5x more per instruction, so it eats ~83 % of
the time.

Every J item optimises the trace BOUNDARY, which lives inside the 16 % slice. J5 measured the ceiling
of that slice directly (delete 30-40 % of the epilogue: −6 %…+3 %), and the profile says why that
ceiling exists. So:

* **J1** (6 memory accesses per hop removed, x107 M hops) — inside the 16 %; measured wash.
* **J2** (79 % predictable successors, but the hash is ~9 of ~35 epilogue ops) — inside the 16 %.
* **J3** (store-path bookkeeping) — its target path never executed at all: `link_fail[6] == 0`.
* **J4** (fewer boundaries: −15.6 % external links) — inside the 16 %, and it pays 2.5x the compiled
  code for it, which lands in the 64 % engine/compile side: net −8.8 % MIPS.
* **J5** (skip the checks) — negative, and the guest executes identical work either way.

**Raising coverage does not work either, and that is measured too.** Bundles do not raise coverage —
they only make compilation free for traces that already cross the hotness threshold. Lowering the
threshold raises coverage but costs more compile time than it saves, *even with a deep precomputed
bundle* (kernel + codex-deep, 30,750 keys):

| threshold (with the deep bundle) | boot | keystroke | MIPS | traces compiled at runtime |
|---|---|---|---|---|
| 2000 | 8.33 s | 204 ms | 92.8 | 5,095 |
| 200 | 11.31 s | 213 ms | 77.7 | 16,533 |
| 50 | 14.01 s | 197 ms | 67.6 | 28,394 |

The bundle does not contain the traces a low threshold wants (they are cold code the recording never
compiled), so they are generated from scratch. A cache recorded at the SAME low threshold is the only
untested version of "JIT everything from cache" — and J4's code-size result (61 MB of generated wasm
cost −8.8 % MIPS) warns that it runs into V8 compile/code-cache cost from the other side.

**The next real lever is therefore the interpreted half, not the JIT'd half**: either the interpreter's
per-instruction cost, or a way to raise coverage whose compile cost is genuinely zero at run time.

### "Precompile everything at a low threshold and load it next time" — tested, and it loses

Recorded a cache AT threshold 50 (so it contains the cold traces a low threshold wants): 128.5 MB,
`--jit-bundle-out`. Then replayed it:

| config | boot | keystroke | MIPS | compiled at runtime | codegen |
|---|---|---|---|---|---|
| threshold 2000 + normal cache (33 MB) | 7.83 s | 179 ms | 99.0 | 1,061 | 54 ms |
| **threshold 50 + cache recorded at 50 (128 MB)** | **12.82 s** | 184 ms | **72.1** | **80** | **4 ms** |
| threshold 2000 + the same 128 MB cache | 7.31 s | 201 ms | 100.8 | 31 | 3 ms |

The mechanism works perfectly — runtime compilation collapses 1,061 -> 80 traces and codegen 54 -> 4 ms
— and the run is still 5 s slower to boot at 27 % lower throughput. Row 3 isolates the cause: the same
128 MB cache at the normal threshold is fine, so it is not the cache size or the load (488 ms vs 173 ms
of load+instantiate, only 0.3 s of the 5 s gap). What differs is how many traces end up **installed and
executing** as wasm functions: ~30 k instead of ~5 k. Execution itself gets slower (72 vs 100 MIPS) —
thousands of distinct indirect-call targets, i-cache pressure, and V8 leaving rarely-run functions in
the baseline tier. Same wall J4 hit from the other side (61 MB of generated code, −8.8 % MIPS).

**Conclusion: the engine is neither compile-bound nor op-count-bound. It is bound by the interpreted
half (83 % of steady-state time) and, as soon as you try to shrink that half by compiling more, by the
volume of live compiled code.** The untried variant is selective caching — pick traces by the
*interpreted cost they actually save* (executed-instruction weight), keeping the live code set small,
rather than everything above a threshold.

### What the JIT is actually worth, and why in-place code replacement is impossible

Interleaved, identical scenario, `build/eh-nb`:

| run | JIT on: boot / keystroke | JIT off (`--jit 0`): boot / keystroke |
|---|---|---|
| 1 | 7.25 s / **185 ms** | 7.16 s / **290 ms** |
| 2 | 7.21 s / **171 ms** | 7.05 s / **281 ms** |

**The JIT is a 1.6x win on the interactive path and neutral on boot.** (An earlier 123 MIPS reading for
the interpreter came from a SHORTER scenario and is not comparable — do not repeat that mistake; MIPS
over a wall-clock-driven scenario is dominated by boot.) Boot is cold one-shot code that never crosses
any threshold, which is the same long tail that holds coverage at 46.7 %; typing re-executes hot redraw
loops, which are compiled, hence the 1.6x.

Coverage versus threshold, no bundles, level 3 (the tail is why no policy helps):

| threshold | JIT coverage of trace executions | installed functions | MIPS |
|---|---|---|---|
| 2000 | **46.7 %** | 5,079 | 95.3 |
| 500 | 51.1 % | 10,483 | 78.0 |
| 200 | 53.0 % | 16,487 | 75.6 |
| 50 | **54.9 %** | 28,323 | 64.3 |

40x lower threshold buys 8 points of coverage for 5.6x the installed functions and a third of the
throughput. The uncovered half is not "not yet hot", it is code that never repeats.

**Why the translation cannot live in guest memory.** WebAssembly separates code from data absolutely:
linear memory is data only, there is no executable bit to mark, no instruction jumps into linear
memory, and a `WebAssembly.Module` is immutable once instantiated. Translated code therefore MUST
become module functions reached through an indirect call table — the "separate cache" is not a design
choice, it is the only shape wasm allows, and it is why more compiled code costs table growth,
indirect-call target diversity and V8 compile time (measured: J4's 61 MB of generated code, −8.8 %
MIPS; 28 k installed functions, −33 % MIPS).

**The expressible version of the same idea, and the most promising direction left**: keep the
translation in linear memory as DATA — a dense pre-decoded IR — and run one tight dispatch loop over
it (threaded code). Contiguous, no module per trace, no compile cost, and it targets exactly the long
tail the JIT can never reach, which is where ~half of all execution and most of the steady-state time
sits.

### The counters (JC build, level 3, no bundle, 18.2 s codex run, 82.01 G executed wasm ops)

Two corrections to this section first:

* **The link epilogue is 92 wasm ops / 19 loads / 3 stores per hop, not the ~35 assumed above** (159
  static; 25 ops are the timer+async check, 40 the iCache hash+lookup, and the fetch-window refill arm
  adds 63 more on 34.2 M of the hops). So the trace boundary is a **17.6 %** target, not ~5 %.
* **The stated reason J5's loose checking was slower is wrong.** `link_fail[0]` (countdown expiry ->
  cpu_loop) goes DOWN, not up: 17.1 k per G icount (off) vs 15.7 k (N=8) vs 13.3 k (N=32), and
  mechanically it must — `currCountdown` is decremented by the accumulated delta, so decrements are
  conserved. The −6.3 % belongs to the hop-counter read-modify-write and cache effects.

| bucket | executed wasm ops | share |
|---|---|---|
| instruction templates | 67.09 G | **81.8 %** |
| link epilogue | 11.12 G | 13.6 % |
| trace exits (commit + spill) | 2.60 G | 3.2 % |
| in-region transitions | 0.72 G | 0.9 % |
| in-trace loopbacks | 0.47 G | 0.6 % |
| **boundary total** | **14.45 G** | **17.6 %** (stable 17.6/18.6/18.8 across runs) |

Memory accesses in JIT'd code: 8.59 G total, of which the epilogue is 2.55 G (**29.7 %**).

| item | what it removes | counter | share of executed work |
|---|---|---|---|
| J1 | 7 memory accesses + ~15 ops per boundary x 112.2 M | 785 M accesses / 1.68 G ops | **2.05 %** (9.2 % of memory traffic) |
| J2 | iCache hash+lookup, 40 ops x 92.85 M hops | 3.71 G ops gross | 4.53 % gross, 3.60 % at the 79.5 % hit rate, **~2.7 % net** |
| J3 | store-path bookkeeping | **100.41 M stores executed, 0** reached the arm it optimises | **0 %** |
| J5 | timer+async check skipped 7 of 8, minus the hop counter | ~11 ops/hop | **1.24 %** |

Each is at or below the ±4 % measurement floor — which is exactly what the latency runs showed.

### Why the JIT itself is only worth 1.3x, and what that implies

A fully hot guest loop (identical 3,319 M instructions in every arm):

| | wall | MIPS | coverage |
|---|---|---|---|
| JIT on | 20.84 s | **161.4** | 80.2 % |
| JIT off (`--jit 0`) | 26.97 s | **124.3** | 0 % |

**JIT'd code is only ~1.3x the Bochs interpreter on code it fully covers.** Bochs' interpreter is
already fast — it dispatches pre-decoded instructions from its iCache, so the JIT's win is limited to
removing that dispatch, while the emitted templates still reproduce every Bochs semantic (lazy flags,
per-access TLB probe + SMC stamp, icount bookkeeping). That is the ceiling behind every result in this
section: with a 1.3x engine advantage, raising coverage (max +8 points) or trimming the 17.6 %
boundary cannot produce a step change.

**The lever is code QUALITY, not code quantity**: make the templates cheaper than the interpreter's
handlers (flag liveness across instructions — partially there; hoisting TLB probes out of loops;
dropping per-instruction icount/RIP bookkeeping where no exit can observe it), rather than compiling
more traces or linking them faster.

### J4 regresses even with no idle path — it is code volume, not wasted work

Hypothesis tested: maybe joining functions only hurts because the guest has a hot idle/poll loop and
bigger regions do wasteful work instead of jumping to useful work. Same j4 engine, runtime flags on
vs off, on a tight guest loop (`while i < 200000`) where there is no idle, no polling and nothing to
wait for:

| run | flags off | ahead + inlined calls |
|---|---|---|
| 1 | 152.71 MIPS, 2.31 blocks/region, 6.3 MB | **133.03 MIPS**, 4.47 blocks/region, **15.9 MB** |
| 2 | 149.12 MIPS, 2.31 blocks/region, 6.3 MB | **131.16 MIPS**, 4.47 blocks/region, 15.9 MB |

Joining works (blocks/region nearly doubles) and still costs **~12 %** where every executed instruction
is useful work. So the regression is **code volume**, not misdirected execution: 2.5x the compiled wasm
for the same instructions. Third independent confirmation of the same wall, after J4 on codex (−8.8 %)
and the 28 k-installed-function cache (−33 %).

**Rule for anything proposed here: a change that adds emitted code starts ~12 % behind.**

(Method note: the stock harness does not plumb J4's knobs — a first attempt measured 2.31 blocks/region
in both arms, i.e. nothing. Use `work/prof/j4-run.mjs`, which reads NANOBOX_J4_* and calls the setters.)

## K. The AOT probe result: the floor is the TRACE, not Bochs' semantics (2026-08-17)

One real guest function (`EVP_DecodeUpdate`, OpenSSL base64 decode — 28.8 M instructions, 72.7 % of the
hottest user page; exact bounds from `.symtab`, hot region 41 guest instructions / 12 basic blocks) was
translated as a SINGLE wasm function with internal control flow, registers in locals across the region,
flags computed directly, per-site TLB page tags in locals, and boundary work only at the branches the
interpreter also takes. Identical guest bytes on both arms (extracted into a driver), verified against a
JS model (identical output, registers and icount), and the loop is >99.94 % JIT-linked so this is JIT'd
code vs AOT code, not JIT vs interpreter.

| | code bytes / guest instr | MIPS (3 runs) | vs current JIT |
|---|---|---|---|
| Bochs interpreter (`--jit 0`) | – | **172.7** | 0.42x |
| current trace JIT | **341** | **414.6** | 1.00x |
| **AOT, one function, strict** | **22** | **3734** | **9.0x** |
| AOT + full register/RIP commit at every boundary | 36 | 1956 | **4.7x** |
| AOT, checks only on the back edge | 19 | 3967 | 9.6x |

Spreads 0.5-4 %, all far outside the +/-4 % floor. Ops per guest instruction: current JIT **144 static**
(the boundary alone is 5 x 92 = 460 executed ops per iteration = **18.4 per guest instruction**); AOT
**11 static, ~8.3 executed**, everything included.

**It is faster AND 15.7x denser** — so it attacks the code-volume wall (J4, the 28 k-function cache, the
no-idle loop test: ~12 % per 2.5x of code) from the good side. Where the win comes from:

* **not** from skipping interrupt checks: strict vs back-edge-only is ~6 %, at the noise edge —
  independently re-confirming J5 that the timer/async *decision* is nearly free and the trace-boundary
  *mechanism* is what costs;
* **~half is store bookkeeping**: committing 12 registers + RIP + icount at each of 5 boundaries is 70
  stores per iteration and costs **1.9x** (3734 -> 1956). This is the measured price of the `i64.store`
  6:1-over-loads anomaly in the emitted code;
* the rest is direct condition computation instead of lazy-flag materialisation (~30 ops per `cmp`
  consumed by the next branch), plus TLB page tags kept in locals across the function.

**Payback list (what a real implementation owes):** precise exception state (a wasm-PC -> guest-instruction
side table with deopt, or the commit-at-boundary scheme — the 4.7x row is the full-payback bound); an
unfreeze/deopt path for SMC (J3's census supports the assumption: 5238 code pages, zero violating
stores); TLB tag invalidation on CR3 writes / INVLPG; and one honest caveat — the AOT arm is a ~900-byte
module in a fresh V8 while the engine arm lives inside a 130 MB module, so treat **9.0x as the ceiling
and 4.7x as the defensible floor**.

**Verdict: the 1.3x-over-interpreter ceiling is not Bochs' per-instruction semantics — it is the TRACE
as the unit of translation.** Function boundaries are a solved input (321,958 `STT_FUNC` in codex's
`.symtab`, 294,541 from `.eh_frame_hdr` even stripped; our kernel is our own build). AOT of the executed
subset is the plan; section J's boundary work stays shelved.

## L. Template work: the first measurable win (2026-08-17, integrated and gated)

The hot opcodes are all memory operations (`MOV_EqGq` 77.0 M, `MOV_GqEq` 41.8 M, `PUSH_Eq` 33.8 M,
`POP_Eq` 33.3 M), and the inlined DTLB probe's HIT path was four separate tests plus a write-stamp test
— about 26 of the ~50 wasm ops a `MOV [mem],reg` costs. Folded into two i64 tags per probe-cache entry
(`C_tagR`/`C_tagW`), each holding `la & LPF_MASK` only when the direction is permitted at the current
CPL, `alignment_check_mask == 0` and (write tag) the page carries no iCache write stamps, else `-1`.
A hit is then one `i64.ne` plus the span check; everything else falls through to the untouched full
probe. `la & LPF_MASK` has 12 zero low bits, so the `-1` poison is unsatisfiable.

Also: the write-stamp test moved to the fill arm (a tag hit proves the page is stamp-free); the
duplicate `async_event` test after the last instruction of a trace removed (the very next thing was the
same exit, testing the same state in the same order); a no-op `laLocal()` copy dropped for segments
without a base; `alignment_check_mask` now loaded eagerly, which also fixes a latent bug where a
compile-time `acmLoaded` flag could leave the local uninitialised on a path whose probe was compiled
second; plus size-only encoding wins (`i64.const 0xffffffff; i64.and` -> `i32.wrap_i64;
i64.extend_i32_u`, run-length-grouped local declarations).

| measurement | result |
|---|---|
| hot loop, in-build A/B (6 interleaved pairs) | **+12.0 %** (spread +7.7…+15.2 %) |
| hot loop, cross-build vs the engine it replaced (3 pairs, mine) | **+8.0 % median** (+6.6…+15.0 %), `ticks` identical every pair |
| codex keystroke median (agent, 3 pairs) | −15.7 % |
| codex keystroke median (mine, 3 pairs) | −4.4 % (better in 2 of 3; codex is coverage-limited at 46.7 %) |
| emitted bytes per instruction | 242.0 -> 231.9 (encoding wins) / 235.8 (with the fold) |
| `br_if` in dumped modules | **−40 %** (four hit-path branches became one) |
| **gate** | **IDENTITY identical (codex + agy) AND BISECT no divergence** |

Note the fold is 1.7 % BIGGER than the same tree without it and still wins — it moves ~19 ops off the
executed hit path onto the rarely-executed fill path. So "smaller is always better" is not the rule;
"fewer ops on the executed path" is, and code size is the tie-breaker.

**Next item, already located: register-spill triples (`i32.const 0` / `local.get` / `i64.store`) are
213 k stores ~ 1.9 MB = 35 % of all emitted bytes**, nearly all of it duplicated cold epilogue
(`spillAll` at every trace exit, `syncBefore` on every memory slow path — about two copies per
memory-access site). Collapsing them into one shared per-function exit epilogue is the next ~30 % of
bytes; it needs the spill set to become a compile-time union with those registers force-loaded in the
prologue and reloaded after handler steps.

Rejected on correctness grounds (worth recording): merging the span check into the tag compare with a
subtract/XOR range test would save ~7 more ops per access, but every single-compare "within 4 KB of X"
form poisons one full guest page and no poison value is provably unreachable.

## M. AOT plan (2026-08-18): translate the platform, detect the runtimes

Decision: AOT-translate the **kernel and native userland binaries** (codex: Rust/musl static; agy: Go
PIE) — binary translation of the platform, the same category as QEMU/Rosetta, no program modified —
and keep the existing runtime detection for **Bun and Node**, whose JS runs on the browser's V8 (the
installer already detects a Bun standalone / node script; AOT skips those binaries).

Inputs are all in hand: kernel function boundaries from our own build (`System.map`; boot with
`nokaslr` so text addresses are fixed), codex `.symtab` (321,958 functions) or `.eh_frame_hdr`
(294,541), agy `.eh_frame_hdr` (~17,400 functions; no `.symtab`).

Phases, each gated by `test/gate.sh` and measured on the section-J scenario + the hot loop:
- **Phase 0 — static function-scope regions inside the engine.** The region compiler already installs
  one wasm function reachable from many entry points (`jitfn`/`jitarg` per iCache entry) with
  invalidation on the SMC/eviction paths; feed the region former from a static CFG (decode forward
  through direct branches, fall-through and call CONTINUATIONS — never callee inlining, J4 proved that
  explodes code) instead of the runtime BFS that stops at every CALL/RET (2.33 blocks/region). Kernel
  first (`regionKernel`: fixed mapping). Decides: do links and wall time follow blocks/region?
- **Phase 1 — emitter quality (what the probe exploited).** One shared exit epilogue per function
  instead of spill sequences duplicated at every exit and slow path (35 % of emitted bytes); spill only
  dirty registers; then flags computed directly across blocks and TLB tags per site in locals.
- **Phase 2 — the artifacts.** Kernel AOT module produced once at image build and shipped with the
  image (Docker rebuild; keep `System.map`; `CONFIG_JUMP_LABEL=n`, `CONFIG_BPF_JIT=n`,
  `CONFIG_KPROBES=n` so nothing patches text after boot); codex/agy translated at install time from
  their unwind tables and cached like the JIT bundle; installer detects Bun/Node and skips them.
- **Phase 3 — direct calls to known callees, guarded returns.**

Expectations stated up front: the probe's 9.0x is a ceiling on hot, fully covered code and 4.7x the
floor with precise state paid back; AOT's larger effect is COVERAGE — it reaches the cold half the JIT
never can (46.7-54.9 %), which is 83 % of steady-state time. What is unknown until Phase 0/1 measure
is how much survives inside the real engine (indirect control flow, precise exceptions).

### The invariant (2026-08-18): the guest generates no code — the only code generators run in the browser

Decision: **everything in the guest is AOT-translated, and nothing in the guest may generate code.** The
only code-generating engines in the picture are Node and Bun (V8 / JavaScriptCore), and those already run
on the browser's V8 through the runtime detection path; every other program is a fixed binary and the
kernel is a fixed image. That turns "translate everything once" from a hope into an invariant we check:

* **Kernel config** (`work/c2w-src/config/bochs/linux_x86_config`, applied to the pack rebuild):
  `JUMP_LABEL=n` (static keys patched NOP<->JMP at runtime), `BPF_JIT=n` (eBPF stays as the kernel's
  INTERPRETER: `BPF_SYSCALL=y` is required by runc — `bpf_prog_query(BPF_CGROUP_DEVICE)` fails container
  init without it, measured — but interpreted BPF is data, not machine code), `KPROBES=n`,
  `OPTPROBES=n`, `UPROBES=n`, `LIVEPATCH=n`, `FUNCTION_TRACER=n`, `DYNAMIC_FTRACE=n`, `RANDOMIZE_BASE=n`
  (fixed text addresses, so one AOT artifact fits every boot); `KALLSYMS=y` (symbols, not codegen);
  `STRICT_KERNEL_RWX=y` kept (kernel text mapped read-only: the guest itself faults on a stray write).
  `MODULES` and `FTRACE` were already off. Alternatives/retpoline patching runs once at boot, before any
  freeze point.
* **Kernel cmdline** (`grub.cfg.template`): `nokaslr pti=off mitigations=off` — no relocation, and no
  CR3 double-switch per syscall (each `mov cr3` is a JIT fallback and a TLB flush; measured 87 k handler
  steps per window).
* **Image build keeps `System.map` + `vmlinux`** (exported next to `/pack`, not packed into the engine),
  which is what the AOT translator and `guest-symbolize` read.
* **Userland policy is enforced by the engine, not the kernel**: a page executed after being written, or
  written after being executed, is a **policy violation** — J3's strict mode (reports pAddr/RIP, stops)
  becomes the shipping policy instead of the permissive unfreeze. codex (Rust) and agy (Go) do not JIT;
  the JS runtimes are detected and never run in the guest.

### Phase 0 result: function-shaped regions are bit-identical and do not pay — boundaries are worth ≤ 2 %

Built (`work/j/aot0`, patches `work/prof/aot0-*.diff`): the region former as a static CFG walk (direct
targets, fall-through, the CONTINUATION after a direct CALL — never the callee), decode-ahead of undecoded
successors with the pool/page guards, kernel regions spanning arbitrary pages (per-page descriptor,
`ppf[page]` check for user regions), and a per-(page -> region) attach registry so any write into a
member page drops the whole region (`pending[j]` + `nanobox_region_first` keep a running region from
entering a not-yet-run block of a dead region). The non-obvious identity piece — decoding ahead marks
pages earlier than the reference interpreter would, and `handleSMC` stops the trace on any marked-chunk
write, which would move interrupt boundaries — is solved with a second table `refMapping` holding exactly
the marks the reference would hold; ahead decodes mark only the private map until their first execution.
**identity: codex IDENTICAL, agy IDENTICAL; hot-loop ticks identical in every variant.**

| variant | blocks/region | ext links / 1000 instr | code | MIPS |
|---|---|---|---|---|
| legacy former (same build) | 2.29 | 62.1-62.8 | 24 MB | 98-104 |
| **static function-scope regions** | **4.32** | **54.4 (−12.8 %)** | **56 MB (2.3x)** | **86-93** |
| no decode-ahead | 3.37 | 59.7 (−4 %) | 45 MB | 92-96 |
| min-hotness 200 | 3.00 | 58 (−7 %) | 36.5 MB | 97-100 |
| dedupe translated successors | 3.96 | 59 (−4 %) | 46.6 MB | 78-95 |

Hot loop: external links −7.7 %, code 6.2 -> 15.3 MB, wall **−6…−13 % in 4/4 pairs**; the shared
mechanism (registry, pending checks, refMapping) costs nothing measurable — the regression is the former.
Census: budgets never bind (block 15, instr 2, page 0 of ~7000 attempts); the remaining ~54 hops/1000
instructions are RET/indirect/syscall and hops into not-hot code; kernel multi-page regions remove only
~6 % of cross-page refills. Regions dropped by writes: 3 per run (the kernel's post-boot SMC events).

**Verdict:** ~13 % of links = ~0.7 executed ops per guest instruction = ~2 % of executed work, against
2.3x the code. Section K's 4.7-9x came from registers-in-locals / direct flags / TLB tags INSIDE one
function, not from fewer boundaries. **Phase 1 (codegen inside the region) carries the whole load; the
Phase 0 mechanism is kept as substrate (it is what lets a region span a function safely) but not adopted.**

## N. Phase 1 shipped: shared exit epilogue, live-only spills, XCHG templates (2026-08-18, gate green)

What landed (`patches/bochs-nanobox.patch`): every trace exit used to emit `spillAll` + RIP/prev_rip/icount
stores + `br`; the body is now wrapped in a chain of nested blocks, registers get a chain position the
first time they are dirty at an exit, an exit sets RIP/icount and does one `br` to its position, and a
common tail stores RIP/prev_rip/icount and tail-calls the link function — each exit executes exactly the
stores of its own dirty set. Loop headers and region block entries spill only registers the code WRITES
(fixpoint over pass-1 transitions instead of "everything the block touches"). Two missing templates found
by the counters (`XCHG_RRXRAX` 51 M + `XCHG_ERXEAX` 9 M handler steps on the hot loop) added — handler
steps 124 M -> 64 M. A latent bug fixed on the way: `emitHandlerStep` loaded `alignment_check_mask` and
poisoned the probe tags BEFORE the handler call, so a POPF flipping EFLAGS.AC left it stale.

| | before | after |
|---|---|---|
| bytes / guest instruction | 235.8 | **187.0 (−20.7 %)** |
| spill triples | 158,998 | **62,133 (−61 %)** |
| `i64.store` : `i64.load` | 6.05 : 1 | **3.13 : 1** (stores −52 %) |
| codex installed wasm at boot | 17.1 MB | 13.4 MB |
| hot loop, quiet machine, cross-build (4 pairs) | | **+5.4 % median** (2.7 / 5.8 / −9.9 / 17.0), ticks identical |
| codex keystroke / boot / MIPS (3 pairs) | 226 ms / 8.74 s / 89.9 | 219 ms / 8.53 s / 91.2 (inside noise, all three ahead) |
| **gate** | | **IDENTITY identical (codex + agy), BISECT no divergence**; every runtime mode IDENTICAL |

Why `syncBefore`'s pre-call spill must stay (recorded so nobody retries it): `exception()` reads
RIP/prev_rip/RSP from the CPU struct BEFORE it longjmps, so the commit cannot move into a catch handler.

Remaining handler steps on the hot loop are the next hot-path item: AVX/SSE string ops (`VPCMPEQB`
8.1 M, `PCMPISTRI` 6.4 M, `PSHUFB` 5.8 M, `VPMOVMSKB` 4.8 M, `VPXOR`/`VZEROUPPER` 4.6 M each), `REP
STOSB/MOVSB` 1.6 M each, `LEAVE` 1.2 M.

### The no-codegen kernel image boots the real workload
Engine built from `work/pack-out-aot/pack` (JUMP_LABEL/BPF_JIT/kprobes/uprobes/ftrace/livepatch/KASLR
off, KALLSYMS on, `nokaslr pti=off mitigations=off`, System.map with 13,947 text symbols + vmlinux
exported): **codex reaches its sign-in prompt in 6.07 s / 1.190 G instructions.** First attempt with
`BPF_SYSCALL=n` failed container init (`runc`: `bpf_prog_query(BPF_CGROUP_DEVICE)` ENOSYS) — the eBPF
INTERPRETER stays, the JIT is off.

Fair A/B of the two images (same engine source, no bundles on either side — passing eh-nb's bundles to
the other engine tag would give one side a cold JIT, the trap recorded in J):

| pair | current image | no-codegen image (`nokaslr pti=off mitigations=off`, no jump labels) |
|---|---|---|
| 1 | 7.28 s, 230 ms, 97.3 MIPS | 7.31 s, 180 ms, 99.7 MIPS |
| 2 | 6.80 s, 171 ms, 103.6 MIPS | 6.58 s, 191 ms, 107.9 MIPS |
| 3 | 6.62 s, 177 ms, 105.1 MIPS | 6.15 s, 195 ms, 111.6 MIPS |

**MIPS ahead in 3/3 (+2.4 / +4.2 / +6.2 %), boot in 2/3, instruction count essentially equal (1.190 vs
1.186 G to the prompt).** The invariant costs nothing and already pays a little before any AOT — the
kernel no longer double-switches CR3 on every syscall.

### Adopting the image: the identity leg needed a methodology fix, not the engine

Both engines rebuilt from the no-codegen pack; `test/gate.sh` reported **IDENTITY DIFFERENT, BISECT no
divergence**. Diagnosis: each engine is perfectly deterministic run to run (same icount, same ticks), the
JIT agrees with the interpreter inside the engine (bisect clean), but the two BUILDS' wizer pre-init
snapshots land at different guest points on this kernel — ref icount 562,638,707 / ticks 2,182,091,484
vs optimized 563,353,589 / 2,182,293,431 (on the old kernel they matched to the tick) — so everything
downstream differs in interrupt phase and RAM cannot match. The two wizer versions (v3 for the legacy
build, the EH fork for the optimized one) feed different host inputs during pre-init; the new kernel
happens to be sensitive to it.

Proof it is not the engine: the same two engines built with `--no-wizer` (cold boot, no snapshot, no
host input phase) are **IDENTICAL for codex AND agy** (codex ticks 2,944,765,941 both, RAM SHA-256 equal,
icount within 2). `test/gate.sh` now runs the identity leg on `build/{ref,eh}-nowiz` when they exist
(`--no-wizer` builds of the same source) and keeps the bisect on the snapshot build. Open item: why the
pre-init phase depends on the wizer version on this kernel (it did not on the old one) — worth fixing
so the shipped snapshot is also build-independent, but it is not a correctness issue.

### Interrupted (2026-08-18): three codegen trees, cut off by the account's spend limit — resume, do not restart

All three are unverified partial work in gitignored trees; their diffs against the shipping
`nanobox_jit.cc` are snapshotted as `work/prof/{flags,simd,hlo}-partial-nanobox_jit.diff`:

- **`work/j/flags`** (Phase 1b: `CMP/TEST+Jcc` -> direct compare + `br_if`, no writeback, no flag
  materialisation; TLB tags across a region). Engine builds; **mode 3 crashes the engine** (run ends after
  the snapshot with no SUMMARY) and the agent was bisecting it (`work/prof/flags-bisect{0,1}.log`,
  `flags-bisect.mjs`) when cut off. Baseline level-3 hot loop recorded at 170.3 MIPS. Not safe to apply.
- **`work/j/simd`** (templates for `VPCMPEQB`/`PCMPISTRI`/`PSHUFB`/`VPMOVMSKB`/`VPXOR`/`VZEROUPPER`, `REP
  STOS/MOVS` fast paths, `LEAVE`/`BSR`/`BT*`/`SHRD`): 650 diff lines, engine builds, no measurements taken.
- **`work/j/hlo`** (per-opcode cost table + RIP/icount bookkeeping, dead writebacks, redundant local
  copies, constant bases): 829 diff lines, engine builds, the table was not yet produced.

Each needs: finish, single-binary A/B on the hot loop, ticks identical per pair, then the full gate here.
The per-opcode cost table (hlo's first deliverable) is the one to produce first — it ranks the rest.

## O. SIMD/AVX, REP and ALU templates shipped (2026-08-18, gate green)

Level-3 counters showed 64 M interpreter handler steps per hot loop, dominated by the SSE/AVX string
kernels every guest string function goes through. Shipped (`patches/bochs-nanobox.patch`), all behind
runtime bits of `nanobox_jit_spill` (16 SIMD/AVX, 32 REP, 64 ALU; default all on):
* wasm `v128` in the emitter (`nanobox_wasm.h`: V128 type, `0xfd`-prefixed ops, `memory.fill/copy`;
  v128 locals declared lazily so modules without SIMD stay SIMD-free); templates dispatched by Bochs
  HANDLER: `VZEROUPPER`, VEX 2-source `VPXOR/VXORPS/VPOR/VPAND/VPANDN/VPCMPEQB` (VL128 zeroes the upper
  lane, VL256 both lanes, register + memory forms), `VPSHUFB`/`PSHUFB` (`i8x16.swizzle` on `mask & 0x8f`),
  `VPMOVMSKB`/`PMOVMSKB`, SSE `PCMPEQB/PXOR/PAND/PANDN/POR/XORPS/ANDPS/ORPS/ANDNPS`, `PCMPISTRI` (helper
  `bx_nanobox_pcmpistri()` in `cpu/sse_string.cc` sharing the handler's static code; the JIT replays
  `setEFlagsOSZAPC`'s exact lazy-flag sequence), `VMOVDQU/VMOVDQA`, `VMOVD`, `MOVD`, `MOVQ`, `VPBROADCASTB`;
* `REP STOSB/MOVSB/MOVSD/MOVSQ` single-chunk fast paths (exactly the case where the FIRST fast chunk is
  the whole count: DF clear, span inside one page, `bytes <= currCountdown`, no code marks, no host
  aliasing; `memory.fill/copy`; everything else deopts BEFORE any side effect). **The gate's bisector
  caught the first version**: its deopt was handler step + `ret`, ending the trace after the REP where the
  interpreter's `repeat()` continues into the next instruction — an extra boundary (kernel loop at
  `0xffffffff81121a60`, `REP STOSB` count 3). Fixed: the deopt is an ordinary rejoining handler step;
  bisector `no divergence: 935 blocks x 100000 traces`, and the earlier "+8/+17 icount" drift vanished
  with it (it was that boundary, not chunk accounting);
* ALU: `LEAVE`, `MUL_RAXEq`, `BSF/BSR` 32/64, `INC/DEC/NEG/NOT_Eb`, `BT/BTS/BTR` immediate memory forms,
  `SHLD/SHRD` register forms (a v4 bug — `src` loaded inside the count!=0 branch — was caught by the
  RAM-hash identity check and fixed).

| | off | on |
|---|---|---|
| handler steps, hot loop (3.32 G instr) | 64,184,135 | **1,320,699 (−97.9 %)** |
| handler steps, codex boot to prompt | 2,471,169 | 1,665,491 (−32.6 %) |
| hot loop MIPS, single binary (agent, 4 pairs) | 211.0 | **224.0 (+6.2 % median, every pair ahead)** |
| bytes / compiled instruction | 158.5 | 158.9 |
| **gate** | | **IDENTITY identical (codex + agy), BISECT no divergence** |

Codex keystroke/boot/MIPS: inside noise (its remaining steps are boot/privileged/32-bit-mode work, and it
is coverage-limited). Remaining handler steps: `DIV_EAXEd` 796 k, `BLSMSK` 198 k, `PUNPCKLQDQ` 198 k, then
< 30 k each; codex boot: `REP_MOVSB` in 32-bit mode 510 k, `CLI/STI` 466 k, `CMPXCHG16B` 51 k.

**Measurement note that now matters**: on the no-codegen image the two builds' snapshot phases differ,
so a CROSS-build hot-loop A/B reads `ticks DIFFER` and its MIPS delta is not apples-to-apples (measured:
"+0.4 %" cross-build for a change the single-binary A/B shows at +6.2 %). Use single-binary runtime
switches for A/B (as L, N, O did), and cross-build only for boot/keystroke on the codex scenario.

## P. Where executed wasm ops go — the per-path accounting (2026-08-18, `work/j/hlo`, level 3 only)

Every straight-line path the emitter produces gets a slot {opcode, kind, per-category static ops};
nested paths (a taken Jcc arm, a probe fill, a slow arm, an exit) are their own slots subtracted from
their ancestors, so a body slot holds exactly its own ops. Sanity: the link hop measures 92.0 ops, exactly
section J's counter; MOV_Op64_GdEd read by hand from `wasm-objdump` matches its slot to the op. Tooling:
`work/prof/hlo-run.mjs --hlo-out F.json` + `hlo-report.mjs F [--forms|--kinds]`, `NANOBOX_HLO=<mask>`.

| executed ops by kind | hot loop (212 G ops, 63.7/guest instr, 78/JIT'd instr) | codex boot+typing (57.6 G, 37.3/guest, 69.8/JIT'd) |
|---|---|---|
| template bodies | 31.7 % | 33.7 % |
| **full DTLB probe + tag fill (92 ops)** | **23.5 %** | **22.6 %** |
| front-entry miss test + swap (35 ops) | 9.2 % | 9.3 % |
| link hop (92/hop) | 14.8 % | 15.0 % |
| prologue (28/entry) | 6.4 % | 5.3 % |
| exit (chain + tail, ~30) | 5.1 % | 5.3 % |
| link-fail / trans / handler / jcc-taken / loop / slow | 3.1 / 2.6 / 1.7 / 1.7 / 0.1 / 0.0 | 4.5 / 1.4 / 0.4 / 1.5 / 0.8 / 0.0 |
| by category: op / **mem** / rip / flags / regs / **exit** / async | 11.7 / **44.9** / 5.3 / 9.6 / 3.6 / **20.5** / 3.1 % | 13.4 / **43.5** / 4.8 / 9.7 / 3.2 / **21.9** / 2.8 % |
| function entries; templates per entry | 343 M; **7.7** | 100 M; **8.2** |
| memory accesses; front-entry miss; **full DTLB probe** | 1.09 G; 55 %; **49 %** | 277 M; 59 %; **49 %** |

**~1/3 body, ~1/3 probe refills, ~1/3 boundary.** Half of all memory accesses run the full 92-op probe
because the probe cache is poisoned at every function entry and a function runs ~8 templates (MOV_GqEq
loads refill 72 % of the time, stack ops 21-41 %). Per instance: MOV_GqEq 127 ops (94 fill), CALL 136
(54), RET 125 (53), PUSH 74 (36), POP 63 (28); CMP_EbIb 115 of which **29 lazy-flag ops**; INC_Eq 44 of
which 33 flags; a taken `cmp; jne` pays ~370 ops all in (43 + 32 + 92 link + 28 prologue + ~2 refills).

What the user asked to remove, checked against the table:
* RIP / prev_rip / icount per instruction: **already zero** in bodies (5.3 % of ops, all at observers).
* dead register writebacks: **none in bodies** (stores only in exit chains, handler steps, cold arms).
* redundant local copies: found and removed (PUSH 8->6, POP 9->5, RET 17->15, MOV store 3.6->2.7 ops):
  −1.8 % executed ops, hot loop −0.8 % median = noise, ticks/icount identical — kept behind mask bits 2|4.
* `i32.const 0` bases: 7 % of executed ops, but V8 folds base 0 + offset; wasm has no memarg without a base.
* outlined fill (one shared `fill(la, size|bit)` function): **−15…−20 % bytes** but **−9 % hot-loop MIPS**
  while 49 % of accesses still refill (an indirect call per fill); a wash on codex. Becomes free profit
  once tags survive across entries. Kept behind mask bits 8|16.

**Conclusion: carrying the two probe-cache entries across function entries removes ~30 % of executed
ops in both workloads and unlocks the −20 % bytes of the outlined fill. That is the single item;
direct conditions (~29 ops per CMP, ~10 %) is second.**

## Q. Phase 1b measured: probe cache across traces, forward `br`, deferred flags (2026-08-18, `work/j/flags`)

* **Crash root cause (worth remembering)**: `cmpl $1,0xc(%rsp)` then `adcl $-1,0xc(%rsp)` — the kernel's
  `mmap_miss` saturating decrement. The deferred-flags ADC evaluated its operands into the pending-flag
  locals BEFORE reading CF, so CF came from ADC's own operands; memory-only, invisible in register/RIP
  fingerprints for 96 M traces, then `mov 0xc(%rsp),%ebx` read 1 instead of 0 and the guest looped
  forever. Fixed (ADC/SBB materialise pending state and read CF before touching operand locals); a
  self-check mode (bit 16) compares every direct condition against Bochs' `getB_*` — 0 mismatches.
* **Probe cache carried across JIT->JIT links** (soundness: the only code between one trace's last access
  and the next's first is the link epilogue — timer/async tests, inline prefetch, iCache lookup — none of
  which touches a DTLB entry, stamps a page, or changes CPL/`alignment_check_mask`; handler steps still
  poison; entry from cpu_loop gets poison; individual DTLB entry replacement never invalidates a cached
  translation, INVLPG/CR3 are handler steps):

  | variant | full probes / guest instr | hot loop, single binary |
  |---|---|---|
  | baseline | 0.160 | — |
  | 4-param tail call, front entry only | **0.102 (−37 %)** | **+2.6 % median, 4/4 ahead** |
  | 11-param tail call, both entries | 0.072 (−55 %) | **−5.6 %** (stack-passed params cost more than the probes) |
  | memory handoff, front entry | 0.102 (−37 %) | +0.8 % (noise) |
* **Forward in-region `br` instead of `L_cur` + `br_table`**: **+5.0 %** (390 sites; same target body,
  `L_cur` unread after) — the one clear win, because it removes a dispatch per in-region edge.
* **Deferred lazy flags**: 2004 of 2005 `Jcc`-after-ALU sites became direct compares (99.95 %); 573 M
  pending states, 492 M direct conditions, 321 M still materialised (56 %: 270 M at exits with unknown
  successor); ~10 G ops removed — and wall time **−4.7 %**: code +4 % (materialisation inlined at every
  exit arm) and the exit path got longer. Kept behind its bit, OFF.
* **Why −55 % full probes (~27 G of ~80 G ops) barely shows in wall time**: `node --cpu-prof` of the
  steady state — **the shared link epilogue is 28.7 % of time by itself**, JIT bodies ~50 %, engine ~19 %.
  The two `return_call_indirect` per hop dominate; the machine is not op-count-bound (consistent with J
  and P). The next real lever per the profile is the two indirect tail calls per hop.

Adopt: bit 8 + bits 2|6; rebased adopt-set requested against current main; gate + bundle re-record here.

### The hop as a direct `return_call` (2026-08-18): tested, no win

The trace -> link-function hop was `return_call_indirect` to a CONSTANT table slot; imports resolve by
table index, so it can be a direct `return_call` to an import (no table bounds/type check). Built behind
`nanobox_set_jit_linkdirect` (harness env `NANOBOX_LINKDIRECT=1`), single binary, hot loop, 4 pairs, ticks
and icount identical: **+16.5 / −9.8 / −11.2 / +1.3 %, median −4.7 %** — no win inside a noisy window
(another agent building). Plausible null: a call to another instance's function still goes through V8's
import wrapper (instance switch), which costs about what the table dispatch did. Switch kept, default off.
The lever is therefore FEWER hops, not a cheaper hop — regions/AOT territory.

### Shipped from Q (2026-08-18, gate green): probe cache across links + forward `br`

Rebased onto main and integrated (`patches/bochs-nanobox.patch`): `nanobox_jit_flags = 4|8|64` — the DTLB
probe-cache front entry (`C_tagR`, `C_tagW`, `C_host`) travels along JIT->JIT links as tail-call
parameters (every JIT function is now `(i32 arg, i64, i64, i32)`; `nanobox_jit_call` passes poison, so
entry from cpu_loop and handler steps behave exactly as before), and forward in-region edges are a direct
`br` to the body label instead of `L_cur` + `br_table`. Deferred flags, entry classes, self-check and the
memory handoff stay in the code behind their bits, OFF. Full probes −37 % on the hot loop; measured
+2.6 % (4/4) and +5.0 % respectively in Q. **Gate: IDENTITY identical (codex + agy), BISECT no
divergence**; bundles re-recorded (the signature change invalidated them). Ticks identical between the
default mask and mask 0 in one binary.

## R. AOT mode (2026-08-18, decided by the user): everything precompiled, no interpreter dispatch, identity NOT required — behind `NANOBOX_AOT=1`

The user's direction, verbatim in effect: build the AOT engine as asked and put it behind a flag so it can
be tested with **no interpreted code** and **without the identical-memory requirement**; **everything
precompiled**. Under the flag the correctness bar is the guest working end to end (kernel boots, codex /
agy / claude reach their screens, keystrokes echo, the E2E suite passes) — NOT RAM identity, which stays
the bar for the default engine only.

Design (assembled from measured pieces, all in tree):
* function-scope static regions from the CFG (Phase 0 tree `work/j/aot0`: static walk over direct
  targets / fall-through / call continuations, decode-ahead, multi-page kernel regions, per-page region
  registry) with every block an entry point; compile on first touch (threshold 1) when a precompiled
  entry is missing;
* inside a region: registers and probe tags in locals across blocks (already), direct conditions instead
  of lazy flags (Q's bits 1|2 — a loss in the trace model because of exit materialisation, which function
  regions mostly remove), probe cache across links (shipped);
* relaxed boundary discipline (identity waived): timer/async checks only at loop back-edges, region exits
  and handler steps; icount per block; precise state committed only where a fault can occur (slow arms —
  already how syncBefore works);
* **precompile everything**: an offline translator that walks the function list — kernel from
  `work/pack-out-nb/symbols/System.map` (fixed: `nokaslr`), codex/agy from their ELF `.eh_frame_hdr` /
  `.symtab` at a fixed PIE base (`norandmaps` on the cmdline) — forms and compiles every function into an
  `.nbjb` bundle the existing loader consumes; a level-3 counter reports entries NOT served by compiled
  code (target: ~0; handler steps for untemplated instructions are the only remaining interpretation).

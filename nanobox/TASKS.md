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
- [ ] I2 Cheap short traces so T can drop to ~200 (successor cache in the link epilogue, trimmed
      prologue) — the report's −1.0…1.5 s.
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
      in the table the address test already consults; stores to a frozen page skip the write stamp
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
per-access DTLB test + SMC stamp, icount bookkeeping). That is the ceiling behind every result in this
section: with a 1.3x engine advantage, raising coverage (max +8 points) or trimming the 17.6 %
boundary cannot produce a step change.

**The lever is code QUALITY, not code quantity**: make the templates cheaper than the interpreter's
handlers (flag liveness across instructions — partially there; hoisting address resolution out of loops;
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
`POP_Eq` 33.3 M), so the emitted memory path is where template work pays. What shipped: the duplicate
`async_event` test after the last instruction of a trace removed (the very next thing was the same
exit, testing the same state in the same order); a no-op `laLocal()` copy dropped for segments
without a base; `alignment_check_mask` now loaded eagerly, which also fixes a latent bug where a
compile-time `acmLoaded` flag could leave the local uninitialised on a path whose memory site was
compiled second; plus size-only encoding wins (`i64.const 0xffffffff; i64.and` -> `i32.wrap_i64;
i64.extend_i32_u`, run-length-grouped local declarations).

| measurement | result |
|---|---|
| hot loop, in-build A/B (6 interleaved pairs) | **+12.0 %** (spread +7.7…+15.2 %) |
| hot loop, cross-build vs the engine it replaced (3 pairs, mine) | **+8.0 % median** (+6.6…+15.0 %), `ticks` identical every pair |
| codex keystroke median (agent, 3 pairs) | −15.7 % |
| codex keystroke median (mine, 3 pairs) | −4.4 % (better in 2 of 3; codex is coverage-limited at 46.7 %) |
| emitted bytes per instruction | 242.0 -> 231.9 (encoding wins) / 235.8 (with the executed-path work) |
| `br_if` in dumped modules | **−40 %** |
| **gate** | **IDENTITY identical (codex + agy) AND BISECT no divergence** |

Note the shipped tree is 1.7 % BIGGER than the same tree without the hit-path work and still wins — it
moves ~19 ops off the executed path onto a rarely-executed one. So "smaller is always better" is not the rule;
"fewer ops on the executed path" is, and code size is the tie-breaker.

**Next item, already located: register-spill triples (`i32.const 0` / `local.get` / `i64.store`) are
213 k stores ~ 1.9 MB = 35 % of all emitted bytes**, nearly all of it duplicated cold epilogue
(`spillAll` at every trace exit, `syncBefore` on every memory slow path — about two copies per
memory-access site). Collapsing them into one shared per-function exit epilogue is the next ~30 % of
bytes; it needs the spill set to become a compile-time union with those registers force-loaded in the
prologue and reloaded after handler steps.

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
  dirty registers; then flags computed directly across blocks.
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
steps 124 M -> 64 M. A latent bug fixed on the way: `emitHandlerStep` loaded `alignment_check_mask`
BEFORE the handler call, so a POPF flipping EFLAGS.AC left it stale.

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
nested paths (a taken Jcc arm, a slow arm, an exit) are their own slots subtracted from
their ancestors, so a body slot holds exactly its own ops. Sanity: the link hop measures 92.0 ops, exactly
section J's counter; MOV_Op64_GdEd read by hand from `wasm-objdump` matches its slot to the op. Tooling:
`work/prof/hlo-run.mjs --hlo-out F.json` + `hlo-report.mjs F [--forms|--kinds]`, `NANOBOX_HLO=<mask>`.

| executed ops by kind | hot loop (212 G ops, 63.7/guest instr, 78/JIT'd instr) | codex boot+typing (57.6 G, 37.3/guest, 69.8/JIT'd) |
|---|---|---|
| template bodies | 31.7 % | 33.7 % |
| link hop (92/hop) | 14.8 % | 15.0 % |
| prologue (28/entry) | 6.4 % | 5.3 % |
| exit (chain + tail, ~30) | 5.1 % | 5.3 % |
| link-fail / trans / handler / jcc-taken / loop / slow | 3.1 / 2.6 / 1.7 / 1.7 / 0.1 / 0.0 | 4.5 / 1.4 / 0.4 / 1.5 / 0.8 / 0.0 |
| by category: op / **mem** / rip / flags / regs / **exit** / async | 11.7 / **44.9** / 5.3 / 9.6 / 3.6 / **20.5** / 3.1 % | 13.4 / **43.5** / 4.8 / 9.7 / 3.2 / **21.9** / 2.8 % |
| function entries; templates per entry | 343 M; **7.7** | 100 M; **8.2** |
| memory accesses | 1.09 G | 277 M |

What the user asked to remove, checked against the table:
* RIP / prev_rip / icount per instruction: **already zero** in bodies (5.3 % of ops, all at observers).
* dead register writebacks: **none in bodies** (stores only in exit chains, handler steps, cold arms).
* redundant local copies: found and removed (PUSH 8->6, POP 9->5, RET 17->15, MOV store 3.6->2.7 ops):
  −1.8 % executed ops, hot loop −0.8 % median = noise, ticks/icount identical — kept behind mask bits 2|4.
* `i32.const 0` bases: 7 % of executed ops, but V8 folds base 0 + offset; wasm has no memarg without a base.

## Q. Phase 1b measured: forward `br`, deferred flags (2026-08-18, `work/j/flags`)

* **Crash root cause (worth remembering)**: `cmpl $1,0xc(%rsp)` then `adcl $-1,0xc(%rsp)` — the kernel's
  `mmap_miss` saturating decrement. The deferred-flags ADC evaluated its operands into the pending-flag
  locals BEFORE reading CF, so CF came from ADC's own operands; memory-only, invisible in register/RIP
  fingerprints for 96 M traces, then `mov 0xc(%rsp),%ebx` read 1 instead of 0 and the guest looped
  forever. Fixed (ADC/SBB materialise pending state and read CF before touching operand locals); a
  self-check mode (bit 16) compares every direct condition against Bochs' `getB_*` — 0 mismatches.
* **Forward in-region `br` instead of `L_cur` + `br_table`**: **+5.0 %** (390 sites; same target body,
  `L_cur` unread after) — the one clear win, because it removes a dispatch per in-region edge.
* **Deferred lazy flags**: 2004 of 2005 `Jcc`-after-ALU sites became direct compares (99.95 %); 573 M
  pending states, 492 M direct conditions, 321 M still materialised (56 %: 270 M at exits with unknown
  successor); ~10 G ops removed — and wall time **−4.7 %**: code +4 % (materialisation inlined at every
  exit arm) and the exit path got longer. Kept behind its bit, OFF.
* **The machine is not op-count-bound**: `node --cpu-prof` of the steady state — **the shared link
  epilogue is 28.7 % of time by itself**, JIT bodies ~50 %, engine ~19 %. The two
  `return_call_indirect` per hop dominate (consistent with J and P). The next real lever per the
  profile is the two indirect tail calls per hop, not the op count.

Adopt: the forward `br`; rebased adopt-set requested against current main; gate + bundle re-record here.

### The hop as a direct `return_call` (2026-08-18): tested, no win

The trace -> link-function hop was `return_call_indirect` to a CONSTANT table slot; imports resolve by
table index, so it can be a direct `return_call` to an import (no table bounds/type check). Built behind
`nanobox_set_jit_linkdirect` (harness env `NANOBOX_LINKDIRECT=1`), single binary, hot loop, 4 pairs, ticks
and icount identical: **+16.5 / −9.8 / −11.2 / +1.3 %, median −4.7 %** — no win inside a noisy window
(another agent building). Plausible null: a call to another instance's function still goes through V8's
import wrapper (instance switch), which costs about what the table dispatch did. Switch kept, default off.
The lever is therefore FEWER hops, not a cheaper hop — regions/AOT territory.

### Shipped from Q (2026-08-18, gate green): the forward `br`

Rebased onto main and integrated (`patches/bochs-nanobox.patch`): forward in-region edges are a direct
`br` to the body label instead of `L_cur` + `br_table`. Deferred flags, entry classes and self-check
stay in the code behind their bits, OFF. Measured +5.0 % in Q. **Gate: IDENTITY identical (codex +
agy), BISECT no divergence**; bundles re-recorded (the signature change invalidated them). Ticks
identical between the default mask and mask 0 in one binary.

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
  regions mostly remove);
* relaxed boundary discipline (identity waived): timer/async checks only at loop back-edges, region exits
  and handler steps; icount per block; precise state committed only where a fault can occur (slow arms —
  already how syncBefore works);
* **precompile everything**: an offline translator that walks the function list — kernel from
  `work/pack-out-nb/symbols/System.map` (fixed: `nokaslr`), codex/agy from their ELF `.eh_frame_hdr` /
  `.symtab` at a fixed PIE base (`norandmaps` on the cmdline) — forms and compiles every function into an
  `.nbjb` bundle the existing loader consumes; a level-3 counter reports entries NOT served by compiled
  code (target: ~0; handler steps for untemplated instructions are the only remaining interpretation).

### R.1 First measurements of AOT mode (2026-08-18, `build/aot`, one binary, `NANOBOX_AOT=0/1`, bundle-free, interleaved)

Hot loop (busybox `while`, 3.32 G instr, whole run incl. boot):

| variant | MIPS | wall | wasm compiled | modules |
|---|---|---|---|---|
| AOT off (= the shipping engine) | 221.7 / 222.9 | 15.2 / 15.2 s | 4.3 MB | 1,260 |
| AOT on | 132.9 / 131.1 | 25.3 / 25.6 s | 320 MB | 26,394 |
| AOT on + dedupe | 142.2 | 23.7 s | 234 MB | 28,577 |
| AOT on + minhot | 147.3 | 22.8 s | 141 MB | 49,138 |
| AOT on + dedupe + minhot | 182.0 | 18.5 s | 126 MB | 48,901 |

Ten times the loop (16.6 G instr) — the one-time compile amortised: off **183.2**, on **141.2**, on+both
**162.0** MIPS. So the loss is NOT only compile time: the region code itself is slower here, which is
expected — a tight self-loop is the trace JIT's best case (single-trace loop, registers in locals across
iterations), while in a region the same loop is a member block reached through the region's dispatch.

codex scenario (boot to the sign-in prompt, then keystrokes a–d):

| variant | boot | keystroke median | wasm compiled | modules | regions |
|---|---|---|---|---|---|
| AOT off | 6.5 / 7.3 s | 157 / 207 ms | 16.7 MB | 5,194 | 1,397 |
| AOT on | 28.6 / 30.0 s | 215 / 205 ms | **652 MB** | 65,714 | 214,151 |
| AOT on + dedupe + minhot | 18.2 s | 173 ms | 304 MB | 101,937 | 1,488 |

**The finding: compiling everything AT RUNTIME is the wrong shape.** 652 MB of wasm for a codex boot is
39× the baseline's 16.7 MB, and the counters say why: `call` 791 k / `cont` 773 k (every direct CALL pulls
its continuation into the region), 214 k regions at 6.1 blocks each with 171 k region-key cache hits —
the same blocks translated over and over, most of them never executed. Interpretation only fell from
720 M to 565 M instructions for that price, and the residual 564.7 M is identical in every AOT run and
in every workload: it is the boot phase before the JIT can act, which no runtime threshold reaches.

This is the argument FOR the user's instruction ("everything needs to be precompiled") and against
compiling at first touch: the translation has to exist before the run, and it has to be compact — the
next step is the offline artifact (`tools/aot-kernel.mjs`) and the size it produces.

### R.2 The precompiled artifact, and what AOT mode actually delivers (2026-08-18)

`tools/aot-kernel.mjs` — the offline translator. It hands itself to `harness/run.mjs` as `--aot-script`,
so it runs INSIDE the engine between traces, walks every text symbol of `System.map` and calls the
engine's own `nanobox_aot_compile_function(...)` per function; every module lands under the content key
a later boot computes, and `--jit-bundle-out` writes a normal `.nbjb`. The boot that carries it runs at
threshold 1e9 — the JIT is on (the session needs level 2) but nothing compiles until the session drives
it, so the artifact holds precompiled translations and not a recording of a boot.

**The whole kernel precompiles in 4.2 s**: 29,013 functions -> 121,753 translations, 30,500 functions in
2,329 batch modules, 262 MB of wasm, 0 functions unmapped (nokaslr: lin - 0xffffffff80000000 = phys,
verified). With `NANOBOX_AOT_DEDUPE=1`: 126,068 translations, 207 MB, 2.9 s. Loading it into a run
works — 24,857 bundle hits on a codex boot, and the hot loop then compiles **16 MB at runtime instead
of 320 MB**.

**Interpreted code, the user's actual requirement.** The wizer snapshot itself carries icount
563,103,540 / 95,543,412 traces — everything before the engine starts this run (real-mode boot,
protected mode, early kernel; the JIT only translates long mode). Subtracting it gives the interpretation
that happens IN THE RUN:

| | interpreted instructions in-run | traces |
|---|---|---|
| shipping engine (AOT off) | 157.2 M | 21.8 M |
| **AOT mode** | **1.60 M** | 0.21 M |
| AOT mode + precompiled kernel | **1.30 M** | 0.16 M |

So AOT mode does what was asked: **99 % of interpreter dispatch is gone.** What it costs today:

| codex scenario | boot | keystroke | wasm |
|---|---|---|---|
| shipping engine | 6.5 / 7.3 s | 157 / 207 ms | 16.7 MB |
| AOT mode | 28.6 / 30.0 s | 215 / 205 ms | 652 MB |
| AOT + dedupe + minhot | 18.2 s | 173 ms | 304 MB |
| AOT + precompiled kernel bundle | 33.1 s | 208 ms | 348 MB (+580 MB bundle to instantiate) |
| AOT + deduped kernel bundle | 23.0 s | 167 ms | 326 MB (+439 MB bundle) |

**Why it is slower, in one number: volume, not density.** Per compiled instruction the region path emits
157 bytes against the trace path's 129 (the offline translator: 71) — same order. But AOT mode translates
**4.15 M instructions for a codex boot against the baseline's 129 k, i.e. 32x more**: `call` 803 k /
`cont` 784 k (every direct CALL drags its continuation in), 216 k regions at 6.1 blocks, 193 k of which
are content-key duplicates of code already translated. Almost all of it never executes. That is the
whole regression -- with the kernel bundle serving the compiles, the hot loop still runs at 123 MIPS
against 222, and the 10x-longer loop measures 141 vs 183 steady state, so the emitted region code is
also ~20 % slower than the trace JIT on a tight self-loop (its best case: single-trace loop with
registers in locals across iterations, which a region reaches through its dispatch instead).

**What this says about "everything precompiled".** It works mechanically and it removes the interpreter.
To make it WIN it has to get compact: 8.4 MB of kernel text became 262 MB of wasm (71 bytes per guest
instruction). Section K's hand-translated probe was **15.7x denser** than the trace JIT at 4.7-9x the
speed -- that density, not more coverage, is the remaining work, and it is a codegen project (registers
in locals across the whole function, direct flags, no per-block prologue), not a former tuning knob.

### R.3 Precompiling the programs, and the size wall (2026-08-18)

The kernel was easy: its text is resident and its addresses are fixed. A user program is neither, and
both problems now have a fix in tree:

* **whose page tables** -- the AOT session runs between traces with whatever CR3 the guest left
  installed, so the first attempt at codex reported **3000/3000 functions "not mapped"**. The engine
  now takes an **offline byte source**: the driver writes the program's own ELF bytes into a buffer
  (`nanobox_aot_srcbuf_addr` / `nanobox_aot_source`) and they are mapped at a synthetic physical base
  (1 TiB, above any guest RAM) so decode, the iCache and the region former work exactly as they do on
  resident memory. Result: **0 not mapped**, 3,000 codex functions -> 25,189 translations in 1.8 s.
* **which address** -- in AOT mode the region key is now CONTENT ONLY (the entry pAddr is dropped from
  the hash), so a translation made offline at whatever base the ELF was read at is found again in any
  later boot at any other base. `tools/aot-user.mjs codex|agy` reads the guest's own `/proc/*/maps`
  out of the live transcript to place the text, then walks `.eh_frame_hdr` / `.symtab`.

**The wall is size.** Measured per function: kernel **7.1 KB** of wasm, codex **26.5 KB** (sweep on) /
8.4 KB (sweep off). codex's `.eh_frame_hdr` carries **294,540 function boundaries** (a 190 MB Rust
binary), so translating all of it projects to **7.8 GB** (2.5 GB without the linear sweep). The kernel
-- 29,013 functions, 205 MB, 2.9 s -- is the only "everything" that actually fits.

So "every function of every program, precompiled" is reachable for the platform (kernel) and not for a
190 MB application binary at today's density. Three ways forward, in order of what they buy:
1. **precompile what executes**: record a run under the flag and keep its translations (the artifact is
   tens of MB and covers the code the program actually reaches). This is the practical AOT product and
   it is what the sandbox's auto-cache already approximates.
2. **density** (section K: the hand-translated probe was 15.7x denser at 4.7-9x the speed): at that
   density the kernel is ~13 MB and codex's executed set is small enough to ship. This is the real
   project and everything else is a workaround for not having done it.
3. accept partial coverage per program (hot functions from a profile), which is (1) with extra steps.

Also fixed while measuring: the artifact used to contain a recording of the boot that produced it --
AOT mode forces threshold 1, so the boot compiled everything before the session ran (that is why the
first kernel bundles were 580 MB for 205 MB of translations). `NANOBOX_THRESHOLD` now pins the
threshold AFTER the mode is selected, and the harness compiles bundle modules on FIRST USE
(`NANOBOX_BUNDLE_EAGER=1` restores eager compilation; measured neutral on codex, a win when few
modules are touched).

### R.4 The AOT product, merged and gated (2026-08-18)

AOT mode now lives in the shipping engine (`bochs/bochs`), off by default. **With the flag off the gate
is green — `IDENTITY: identical (codex + agy)`, `BISECT: no divergence`** — and the default path costs
nothing for carrying it: codex boot 6.47 / 7.34 / 7.16 s and keystroke 168-177 ms on the merged engine,
the same as before it. `NANOBOX_AOT=1` (harness) or `?aot=1` (sandbox, which now also asks for
`aot-*.nbjb` under both engine tags) selects it.

The artifacts, produced against the shipping engine (`build/eh-nb/jit/`):

| artifact | shipping JIT (recorded, executed code only) | AOT (every function) |
|---|---|---|
| kernel | 9.4 MB | **274.8 MB** (29,013 functions, 149,658 translations, 3.5 s) |
| codex | 14.8 MB | 502 MB (recorded under the flag) |

Loading both AOT artifacts, the flag on: **83.6 % of translations come from the artifact**
(61,320 hits / 12,024 misses), the run compiles **54 MB instead of 652 MB**, and interpretation falls to
**404,840 instructions** — against 157.2 M for the shipping engine, i.e. **99.7 % of interpreter
dispatch removed**, which is what was asked for. Boot is still 22.7-26.7 s against 7.2 s, and the
remaining cost is now visible in the counters: 38,746 regions are still FORMED at runtime (a region has
to be formed before its content key can be looked up), 3,199 modules are compiled+instantiated (2.4 s),
and the region code itself runs slower than the trace JIT's.

**The lean end of the dial is the interesting one.** `NANOBOX_AOT=1 NANOBOX_AOT_AHEAD=0` -- threshold 1
(nothing interpreted) but no speculative growth (only code that executed joins a region) -- gives boot
17.4 s with **keystroke 162 ms, the best of every AOT configuration measured and no worse than the
shipping engine's 168-201 ms**, with 6,349 regions instead of 38,746. That says the speculation, not
the AOT idea, is what costs: translating what runs is affordable, translating everything reachable is
not (R.3's size wall).

### R.5 Why "no interpreted code" costs time — the cold-code entry price (2026-08-18)

The lean configuration with its own artifact is the cleanest experiment of the round: AOT on, no
speculative growth, one previously recorded run replayed.

| | boot | keystroke median | compiled at runtime | interpreted instructions |
|---|---|---|---|---|
| shipping engine + its bundles | 6.13 / 6.45 s | 167 / 154 ms | 4.5 MB | 157 M (22.3 M traces) |
| **AOT, lean, + its artifact** | 16.6 / 17.0 s | 139 / 302 ms | **4.1 MB** | **97,493** |

**98.4 % of translations came from the artifact** (99,336 hits / 1,595 misses), the artifact cost
1.5 s in total (191 ms to load, 1.32 s to compile+instantiate the 3,334 modules the run touched), and
our own compiler ran for 50 ms. So of the +10.5 s, only 1.5 s is the artifact. The remaining ~9 s is
the price of running compiled code instead of interpreting it — and the counter says exactly how it
divides: the shipping engine interprets **22.3 M trace executions** during that boot, and the AOT run
enters a compiled function for every one of them instead. 9 s / 22.3 M = **~400 ns per entry**, which
is what a wasm indirect call plus the prologue and the exit epilogue cost.

That is the honest answer to "why not compile everything": **for code that runs once, the interpreter
is cheaper than any compiled entry**, and a boot is mostly code that runs once. The trace JIT's
threshold is not a limitation to be removed — it is the mechanism that keeps one-shot code out of the
compiler. "No interpreted code" is therefore a correctness/uniformity property (and a prerequisite for
a guest that may not generate code), not a performance one, unless the entry price comes down:
* cheaper entries (a region entered once through a direct call with no spill ceremony — the same
  work as section K's density project), and/or
* fewer entries (bigger regions so one entry covers more guest code — which is what the speculative
  former was for, and it costs the size wall of R.3).

Keystroke latency, the thing the user actually feels, is NOT worse under AOT: 139 ms in one pair
(against 167 ms for the shipping engine, with a far tighter spread: 136-146 ms vs 141-173 ms) and a
302 ms outlier in the other. That is where AOT should be expected to win — steady-state code that is
already hot — and it is the measurement to repeat once entries get cheaper.

## S. Density: making the emitted code as small as the work it does (2026-08-18)

The measurement kernel is an iterative Fibonacci compiled twice from ONE C source (`work/fib/fib.c`):
to wasm (12 instructions per loop iteration, clang) and to x86-64 (6 instructions per iteration). The
guest runs the x86 one and the engine translates it back to wasm, so the native 12 is the ceiling a
perfect translator would reach -- as the user put it, converting 6 x86 instructions into 12 wasm ones
is what the same compiler already did.

| step (all AOT-only unless noted) | wasm instructions per iteration |
|---|---|
| where the round started | 84 |
| the two statistics counters on a self-loop back edge were emitted unconditionally | 72 |
| ALU emits `get, get, op, set` when the flag liveness analysis already proved the flags dead (global; identity-safe, gate green) | 60 |
| the inter-trace sync (guest clock, `async_event`, fetch window) made periodic -- once per `nanobox_jit_aot_tick` (64) iterations instead of every one | 26 |
| a compare leaves its operands in their register locals instead of copying them into the deferred-flag locals | **22** (fast path 21) |
| *native wasm from the same source* | *12* |

What the remaining 21 are: **12** for the guest's four register ops (`mov` 2 each, `add` 4 each -- minimal),
**3** for the compare, **6** for the branch and the interrupt countdown. The guest work (15) is already
within a quarter of native's 12 for the same computation; what is left on top is the interrupt check.

**A regression I introduced, and how it was found.** The operand aliasing hung call-heavy guest code:
a 1M-call benchmark that takes 1.2 s with the flag off ran past a 250 s timeout. **The identity gate
could not see it** -- AOT mode turns deferred flags ON (`nanobox_jit_flags |= 1|2`) and the gate runs
with them OFF, so the affected path is never exercised there. Two runtime bisect knobs
(`NANOBOX_FLAGS` bit 128 = no direct ALU, bit 256 = no aliasing) pinned it in a single build: aliasing
off -> 8.5 s and correct, direct-ALU off -> still hung. The cause: an alias claims "this operand is
still in its register local", and a cold path may reload that local from memory, after which the flags
materialise from a stale value -- a wrong branch condition, hence the infinite loop. The alias now
lives for exactly ONE instruction (the consumer immediately after the compare), which is the case that
pays. RULE: an AOT-only change needs an AOT-only test; the gate proves the default engine and nothing
about the flag-on path.

### S.1 Where the cost actually is (per-opcode, executed, real codex run)

`template COST` over 10,461.9 G executed template bytes:

| opcode | bytes/site | executions | share |
|---|---|---|---|
| MOV_GqEq | 473 | 1,982 M | 9.0 % |
| **PUSH_Eq** | 561 | 1,428 M | **7.7 %** |
| **CALL_Jq** | 825 | 895 M | **7.1 %** |
| **POP_Eq** | 484 | 1,508 M | **7.0 %** |
| **RET_Op64** | 756 | 898 M | **6.5 %** |
| MOV_EqGq | 175 | 3,675 M | 6.2 % |

**Stack traffic (push/call/pop/ret) is 28.3 % of everything executed** -- the largest single category.
And calls outnumber interrupts by ~4 orders of magnitude (~895 M calls against ~3.9 k longjmps per
1.5 G instructions), so flushing deferred state at interrupts would indeed be free.

But the cost of a call is not the return-address store: it is that **a CALL leaves the translated
unit** (exit epilogue -> shared link -> find the callee -> enter, and the reverse on RET). Measured:
one non-inlinable call per iteration costs **1.9 ns natively** and the VM needs a ~9 s run for 200 k
iterations. Removing the store outright was tried and **the guest hangs before printing anything** --
the kernel changes stacks constantly, so a shadow-stack entry stops matching and the address it needs
was never written; `nanobox_jit_aot_nostack` keeps the experiment reproducible, default off. The store
is the floor; the machinery around it is not, and that is the next piece of work.

### S.2 What the density work bought, in wall clock (2026-08-18)

Measured with in-guest markers around the loop (`@@NANOBOX-DUMP:pre@@` / `post`), so boot -- which
varies by seconds under AOT -- is excluded. Differencing two whole runs, which is what the first
attempt did, is useless here: AOT boot variance swamped a 200 M-iteration difference.

| engine | ns per fib iteration | icount for the loop |
|---|---|---|
| before the density work, AOT on | 2.89 | 601.6 M |
| before, AOT off (the trace JIT) | 2.22 | 601.6 M |
| **after, AOT on** | **2.34** | 601.7 M |
| after, AOT off | 2.32 | 601.6 M |
| native wasm from the same C source | 0.53 | -- |

**AOT went from 30 % slower than the trace JIT to parity**, 19 % faster than where it started, and the
distance to native fell from 5.5x to 4.4x. The instruction count dropped from 84 to 26 amortised while
wall clock moved 19 %: V8 was already folding much of the redundant local traffic, so instruction-count
reduction pays less than it reads on paper -- worth knowing before spending more effort on counting.

**A first version of this measured 2.08 ns and "10 % faster than the trace JIT", and both were wrong.**
The periodic back-edge sync charged `icount` only at the sync, so a loop exiting mid-window reported a
stale clock. The guest noticed before any benchmark did: **codex died during start-up with
"failed to initialize sqlite local db ... pool timed out while waiting for an open connection"** --
timer interrupts arrived late, threads stopped being preempted, and a lock holder starved. The fix
charges icount every iteration (4 instructions) and keeps only the expensive checks periodic; the
matching icounts in the table above (601.7 M vs 601.6 M) are the signal that the clock is exact again.
LESSON: when an optimisation touches the guest clock, an icount that no longer matches the reference
run is the tell -- and a speed number taken while the clock is short is not a speed number.

### S.3 Open: the precompiled kernel artifact hits rarely (2026-08-18)

After the density work, regenerating the whole-kernel artifact against the current engine (29,013
functions -> 149,471 translations, 274 MB, 3.3 s) and loading it into a codex boot gives **2,541 bundle
hits against 101,846 misses**, where the same shape earlier in the day gave 22,365 / 68,789. The engine
tag matches (a mismatch is refused outright and reports 0 modules -- which is what the SHIPPED
kernel.nbjb / codex.nbjb now do, because they were recorded against an older build and every engine
rebuild changes the tag; they need `test/record-bundles.sh all` again).

So the artifact is accepted and simply does not describe what the runtime forms. Two hypotheses were
tested and one holds:

* **dedupe** (a successor already carrying a translation is not copied in -- a runtime-only condition,
  so the offline former would build bigger regions): rebuilt the artifact and measured with dedupe off
  on both sides -> 3,450 / 101,282, i.e. **3.3 % against 2.4 %. Rejected.**
* **the earlier 24 % was not the artifact matching.** Before `NANOBOX_THRESHOLD` existed, the boot that
  produced the artifact ran at threshold 1, so the file also contained ~38 k modules the RUNTIME had
  formed during that boot -- those match a later boot by construction. Once the artifact holds only
  offline-formed regions, the true match rate shows: **2-3 %**.

The first diagnosis -- that the runtime roots regions at the block it enters while the translator walks
from function starts -- was tested and is NOT the main factor. The engine now takes a function map
(`--aot-fnmap System.map`, `nanobox_aot_fnmap_add`) and roots a region at the containing function under
AOT; combined with order-independent forming (dedupe off) the hit rate moved 2.4 % -> 3.3 %, and the
retarget fired only 336 times in 241,006 formations.

**The measurement that settles it: within a run, 199,962 of 241,006 formations hit the in-process cache
by content key.** Keys are stable; the artifact simply does not contain what is being asked for. A
kernel artifact covers the kernel, and a codex boot is dominated by CODEX's own code -- of ~41 k
distinct regions compiled at runtime, only ~3.4 k are kernel regions the artifact holds. So this is a
COVERAGE problem, and R.3's size wall is exactly why the coverage is missing: the same 294,540-function
binary that projects to 7.8 GB. The function-rooted former is kept (it is the right structure once user
function maps exist, and it costs nothing), but the thing that would make the artifact pay is
precompiling the code the program actually executes. The artifact should carry the address->function-entry map it already knows
(System.map for the kernel, `.eh_frame_hdr` for a program), and on first touch of any address the
runtime should form/attach the region of the function CONTAINING it, entering at that block, instead
of rooting a fresh region there. Then the offline and runtime regions are the same object by
construction and the artifact hits by design rather than by luck.

End to end after the density work, codex scenario:

| | boot | keystroke |
|---|---|---|
| AOT + kernel artifact | 24.0 s | 162 ms |
| AOT, no artifact | 24.1 s | 153 ms |
| trace JIT (flag off) | 5.7 s | 153 ms |

Keystroke is at parity; boot is still dominated by compiling ~500 MB at threshold 1, which is what the
artifact is supposed to remove and cannot until the keys line up.

### S.4 The loop, finished: 20 wasm instructions and 0.84 ns per iteration (2026-08-18)

| step | wasm instructions on the executed path |
|---|---|
| where the day started | 84 |
| statistics, dead-flag ALU form, periodic checks, operand aliasing (S) | 31 |
| stack scheduling (`nbw::Module::stackify`: dead `block` removal, `local.set X … local.get X` -> `local.tee X`) | 30 |
| flag operands staged only where a receiving block actually reads `P_op1/P_op2` | 26 |
| the interrupt countdown fused into the back edge (`i32.eqz` + `if` + `br` -> one `br_if`) | 24 |
| the guest clock charged per window, exits adding `(tick - L_tick)*(k+1)` themselves | **20** |
| *native wasm compiled from the same C source* | *12* |

The final loop: `get 10, tee 9, get 14, const 1, add, set 14, get 10, get 8, add, set 10, set 8,
get 14, get 16, lt_u, if, get 49, const -1, add, tee 49, br_if`.

**The 8 over native are accounted for and only one of them is translator overhead**: 7 do the
mov/add/mov rotation, which is exactly what clang emits for the same rotation; 3 because the guest
counts up and compares against `%r8` where clang counts down to zero and branches on the decrement;
5 for the interrupt countdown, which native wasm has no equivalent of -- and 5 is also what clang pays
for its own loop counter. Below 19 needs the two register copies GONE, which is renaming, i.e.
unrolling to the length of the register rotation.

Steady state (`work/fib/phase.sh`, n = 1e9, markers around the loop):

| | ns per iteration | MIPS | icount |
|---|---|---|---|
| **AOT** | **0.84** | 7,113 | 6,007.2 M |
| trace JIT (flag off) | 2.19 | 2,747 | 6,007.2 M |
| native wasm | 0.53 | -- | -- |

**AOT is 2.6x the trace JIT and 1.6x off native wasm**, with the guest clock EXACT -- the icount now
matches the reference run digit for digit (main's earlier version overcounted by ~1 M because a
sync-path exit added `k+1` on top of an already-advanced `L_ic0`).

MEASUREMENT LESSON, again: every earlier fib number in this file taken at n = 1e8 (2.34 / 2.89 ns) was
measuring **V8 warm-up**, not the loop. At n = 1e9 the same builds read 1.03 and 0.84. Warm-up is worth
~1.5 ns/iteration here; a loop benchmark that does not outrun it measures the compiler, not the code.

### S.5 Precompiling everything the workload executes does NOT get the boot under 10 s (2026-08-19)

Record one AOT codex boot's translations into an artifact, then replay it (`work/prof/selfrec.sh`):

| | boot | artifact | compiled at runtime |
|---|---|---|---|
| AOT, recording | 40.1 s | writes 500 MB | ~500 MB |
| **AOT, replaying it** | **25.6 s** | 60,136 hits / 13,736 misses (81 %) | **57 MB** |
| trace JIT (flag off) | 9.2 s | -- | -- |

Runtime compilation falls **9x** and the boot is still **2.8x** the trace JIT's. So the artifact is not
what stands between AOT and a fast boot, and neither is coverage: it is the per-entry price of running
compiled code for blocks that execute once. Measured directly on the call benchmark
(`work/fib/minpath.py` over dumped translations):

| | executed wasm instructions per call+ret iteration |
|---|---|
| native wasm (12 loop + 3 callee) | **15** |
| ours: caller up to the call | 33 |
| ours: the callee (`endbr64; lea; ret`) | 31 |
| ours: caller after the call | 35 |
| **ours** | **99** |

~10 guest instructions, 15 wasm if compiled like clang does it, **99 as we translate it** -- and the
extra is paid THREE times per iteration because one guest call/ret crosses three translated wasm
functions, each re-materialising state from memory. The callee's prologue for three x86 instructions:
load the fetch-mode word, unpack the direct-call bit, load RIP and the
tick base, load `user_pl`, seed the countdown, test `async_event` -- with a matching epilogue.

**Therefore the entry/exit ABI is the critical path for the boot target, not more precompilation.**
Direct calls (bit 9) already removed the link/dispatch half of a call: 37.6 -> 16.6 ns per call+ret,
2.2x, with 99.59 % of direct-CALL sites taking the wasm call. What remains is passing RIP, the icount
base and the hot registers through wasm PARAMETERS and RESULTS instead of
through the CPU struct -- expressible only now that a call is a real wasm call.

### S.6 Direct calls between translated functions, shipped in AOT mode (2026-08-19)

A guest `CALL rel32` becomes a wasm `call_indirect` into the callee's translation and the matching
`RET` a wasm `return`, so the pair never leaves compiled code. Per call site a one-entry inline cache
`{va, cr3, fn, arg, ilen, gen}` lives in the CALLER'S REGION DESCRIPTOR, not in the module (modules are
content-keyed and shared, so a module-resident cache thrashes). `jitarg|1` tells the callee it was
entered by a direct call -- only then may its RET compile to `return`. The return address is still
written to the emulated stack. A direct RET publishes where it returned to; if that is not the caller's
continuation the caller simply returns, which covers "returned elsewhere", tail-links, async events and
uncompiled successors in one branch (1.35 % of calls). Depth capped at 200.

| call+ret (`work/fib/call.x86`, 10.2 guest instructions per iteration) | ns |
|---|---|
| shipping engine (flag off) | 30.2 |
| AOT without direct calls | 36.0-42.6 |
| direct call only, ordinary RET | 39.6-39.8 -- **worse** |
| **AOT with direct calls (bit 9, now the default)** | **15.8-18.7** |
| native wasm from the same C source | 1.9 |

**99.59 %** of direct-CALL sites take the wasm call (103.96 M of 104.39 M). Fallbacks: indirect/far
calls, CALLs outside a region, untranslated or unmappable targets, the depth limit, dbg mode, non-AOT.
`nanobox_set_jit_dcall_max(0)` forces every CALL back down the exit path without a rebuild.

**Two findings worth more than the speedup.**
1. **Closing half the pair is worse than doing nothing** -- a direct call whose RET still goes through
   the exit/link machinery is slower than the old path.
2. **An inline cache must be invalidated when code is RELEASED, not when it is installed.** The first
   version bumped a global generation on every batch flush and the A/B read NEUTRAL; the second
   validated against a global eviction generation and re-resolved 9,338,037 sites per codex boot. A
   precise per-site check (`entry->pAddr == site.pa && entry->jitfn == site.fn`, plus VA and CR3)
   gives **169,008 -- 55x fewer** -- and halves the boot cost. A null result was a bug in the
   experiment, twice.

Step 1 of the entry ABI also landed: the compiled function's signature under bit 9 carries
`rip` and `ic0` as PARAMETERS, so a direct call passes them from its own locals instead of storing and
reloading them. The call-free fib loop got faster too (0.96 vs 1.03 ns/iteration in that round) -- the
first configuration where bit 9 beats baseline on code with no calls at all.

Merged with the gate green (`IDENTITY: identical`, `BISECT: no divergence`), guest results verified
against the host (`call(200000) = 15034622464419917381`, `fib(2000000) = 17141820111795327685`,
`fib(10) = 55`), loop icount exact at 6,007.2 M, fib loop 0.92 ns/iteration.

**Step 2 is blocked on the wasm C ABI**: cpu_loop calls a compiled function from C++ through a plain
pointer, so its results must fit clang's wasm C ABI and multi-value is unavailable despite the feature
being enabled. The unblock is one pinned trampoline (installed like `nanobox_link_fn`) that keeps a
C-callable type and `call_indirect`s the multi-value target; the link function keeps the multi-value
type so its tail call forwards results. Then the icount and RAX can be returned, and
the hot registers passed IN (which needs no results and is independently landable).

### S.7 Is AOT usable once it is running? Parity when quiet, two-second stalls when not (2026-08-19)

The 4-keystroke scenario was measuring the wrong thing: those keys land immediately after the sign-in
screen while codex is still initialising, which is why every earlier keystroke number in this file is
150-250 ms. Typing 20 keys 1.2 s apart (`work/prof/sustained.sh`) and taking the median of the last
half gives the steady state:

| | median (all) | median (last half) | max |
|---|---|---|---|
| AOT, run 1 | 21 ms | 19 ms | **741 ms** |
| AOT, run 2 | 36 ms | **250 ms** | **2129 ms** |
| shipping engine, run 1 | 15 ms | 18 ms | 35 ms |
| shipping engine, run 2 | 16 ms | 18 ms | 63 ms |

**AOT is at parity while nothing new compiles and stalls for up to two seconds when something does.**
The counters from the same runs say why: AOT compiled **600 MB in 79,931 modules** during the session
against the shipping engine's **20 MB in 6,704** -- compile-everything-on-first-touch, synchronously,
on the interactive path. It is the same policy that makes the boot 33 s against 8 s (S.5), so startup
cost and interactive stalls are one problem, not two.

That also makes the sustained-typing test the right iteration signal for the startup work: a run is
~40 s and it separates policies far better than boot time, and a fix that lowers boot while keeping
the stalls is not a fix. The bar for "usable once running" is what the shipping engine already does:
no keystroke over ~60 ms.

### S.8 What the 600 MB is made of, and why density work did not shrink it (2026-08-19)

Static bytes per opcode over a codex session (`--tpl-bytes`, 925.3 MB emitted over 3,378,158 compiled
instances -- more than the 600 MB live at any moment because code is released and re-emitted):

| instruction | total | share | instances | bytes/site |
|---|---|---|---|---|
| `CALL_Jq` | 171.1 MB | **18.5 %** | 161,458 | **1,060** |
| `MOV_GqEq` (load) | 139.2 MB | 15.0 % | 358,800 | 388 |
| `MOV_EqGq` (store) | 106.0 MB | 11.5 % | 472,618 | 224 |
| `POP_Eq` | 56.5 MB | 6.1 % | 139,324 | 405 |
| `PUSH_Eq` | 40.0 MB | 4.3 % | 92,038 | 435 |
| `CALL_Eq` (indirect) | 38.6 MB | 4.2 % | 40,962 | 942 |
| `RET_Op64` | 32.9 MB | 3.6 % | 42,838 | 769 |
| `JZ/JNZ/JMP` | ~63 MB | 6.8 % | ~348 k | 127-226 |
| SSE moves | ~49 MB | 5.3 % | ~112 k | 407-460 |

**Call/stack machinery 36.7 %, memory-access MOVs ~30 %: two thirds of all emitted code.** The density
work (S, S.4) attacked arithmetic and loop overhead, which is a small share of the bytes -- that is why
the fib loop shrank 4x and the kernel artifact only 7 %. `CALL_Jq` also GREW with direct calls
(825 -> 1,060 B/site): the inline cache, resolver and fallback are inlined at all 161 k sites.

Each of these is hundreds of bytes for one guest instruction because every memory-touching site inlines
BOTH paths: the address test + access fast path, and the full slow path (spill everything, call the C++
helper, reload).

### S.9 Instruction count is a poor proxy for time (measured, 2026-08-19)

Passing `direct`/`user_pl`/`alignment_check_mask` and the six ABI registers as wasm PARAMETERS
(flags bits 11|12, default off) cut the callee from **46 to 28 executed instructions (-39 %)** and the
three units of a call+ret from 180 to 128 -- and **wall clock did not move**: 21.9/21.1 ns against
22.6/20.5, inside the machine's own spread (the same shipped config measured 0.93, 1.13 and 1.30
ns/iteration on three consecutive rounds of the fib loop). A control settles it: a 13-parameter
signature with NO entry ABI measures the same as the 6- and 15-parameter builds, so neither parameter
count nor deleted prologue work is worth anything here. Those instructions are register moves and
L1-resident field loads that predict perfectly; ten of them cost less than one mispredict.

**Consequence: stop optimising for executed instruction count.** What is left to attack is real memory
work -- the guest stack access in CALL/RET (an address test plus write-stamp check each), the caller's
register spill, and the indirect call -- measured in wall clock at n = 1e9.

Bug found on the way, worth remembering: `nbw::FuncType::params` was `ValType[12]`; a 15-parameter
signature overflowed it silently, the type section came out malformed, V8 rejected EVERY module with
`invalid value type 0x0 @+27`, the JIT fell back to the interpreter, and the run presented as a HANG
rather than a compile error.

### S.10 The typing stalls are synchronous compilation, not interrupt latency (2026-08-19)

Two hypotheses, one run each, artifact loaded in all three (`work/prof/spike.sh`):

| | median | p90 | max | keys > 100 ms |
|---|---|---|---|---|
| AOT, default (async check every 64 iterations) | 26 ms | 421 ms | 1504 ms | 4 |
| interrupts checked EVERY iteration (`NANOBOX_AOT_TICK=1`) | 34 ms | 235 ms | **1404 ms** | 3 |
| **compile only code that repeats (`NANOBOX_THRESHOLD=2000`)** | **19 ms** | **45 ms** | **68 ms** | **0** |

Checking interrupts 64x more often changes nothing; compiling only repeated code removes the stalls
entirely and matches the shipping engine (18 ms). So the interactive stalls and the 33 s boot are one
policy -- compile-everything-on-first-touch -- and the fix is either to raise the threshold (giving up
"no interpreted code") or to make a precompiled artifact ATTACHABLE rather than recompilable, which is
the deterministic-former work.

### S.11 The artifact now matches: 10.1 % -> 68.6 % of kernel lookups served (2026-08-19)

**First, a correction to S.3: my own diagnosis tool was the first bug.** `--aot-keys` read the key log
through an export returning a `double`, and the ulp at 2^63 is 2048 -- so every 64-bit address and key
was quantised into 2 KB buckets. "The offline translator formed regions at only 214 distinct addresses
out of 4,000 functions" was exactly the 436 KB those functions span divided by 2048. With 32-bit halves
the same artifact shows 7,303 regions at 7,303 distinct addresses. LESSON: a `double` cannot carry a
64-bit address; when a measurement lands on a suspiciously round structure, suspect the instrument.

With real keys, seven distinct causes of offline/runtime divergence, each measured:
1. dedupe / minhot / the ITLB fast path consult runtime state -- ignored under the deterministic former.
2. **The walk crossed function boundaries** (fall-through and CALL continuations run into the next
   function), so whoever walked first swallowed the neighbour's entry and the neighbour never got a
   region: the artifact held a region at only **2,887 of 29,013 kernel function starts**. Fixed with a
   function range from the `--aot-fnmap` System.map.
3. A block already belonging to a live region re-rooted its own -- added a member search over the
   attach registry.
4. **Region comparison used a full-length `memcmp`** while the end-of-trace marker's pool slot still
   holds an earlier decode's bytes, so two decodes of the SAME address compared unequal. Comparing only
   the real instructions took "bytes differ" from **88,945 to 18** and runtime formations from 186,595
   to 47,385.
5. `nanobox_jit_after_decode` handed a fresh entry a translation compiled for a different address with
   the same bytes (content-only plain-trace key), keeping the site out of `maybe_compile` entirely.
6. The runtime rooted where the guest entered, the translator where its queue went -- both now run the
   same whole-function sweep.
7. **The offline sweep ran out of iCache instruction pool**: decode-ahead refuses to let the miss
   handler flush it and offline nothing else decodes, so after half the kernel every successor decode
   failed and functions collapsed to plain traces.

| codex boot, same build | baseline | deterministic former |
|---|---|---|
| kernel served / missed | 2,487 / 22,124 = 10.1 % | **13,584 / 6,210 = 68.6 %** |
| user served / missed | 15 / 77,802 | 19 / 75,460 |
| keys agreeing where both rooted | 70.4 % | **99.8 %** |
| runtime kernel addresses in the artifact | 26 % | **85 %** |
| boot | 24.4 s | 27.8 s |

Kernel-side runtime compilation is largely gone. **Boot did not improve because user space is 92 % of
the remaining misses** (75,460 vs 6,210) and the artifact does not cover it -- `tools/aot-user.mjs`
needs the same function-scoped sweep off the ELF's own boundaries. Dedupe also has to stay off
(dedupe=1 drops key agreement to 83 %), which costs code size while size is the top complaint.

Trap: the Bochs makefile has no header dependency tracking, and an incremental rebuild produced a mixed
binary that parked the guest at `native_safe_halt` for six consecutive runs -- indistinguishable from a
correctness bug. Deleting every `.o` and rebuilding fixed it with zero source change.

## T. AOT mode is now a win everywhere (2026-08-19)

**`threshold = 1` was the entire startup cost, and it was never part of what AOT means.** "Everything
compiled" was implemented as a *when-to-compile* policy that put a synchronous region formation and
translation in front of every block the guest reached even once -- and a boot plus a session executes
millions of blocks exactly once. AOT mode now changes the CODEGEN only and leaves scheduling to the
ordinary threshold; `nanobox_set_jit_aot_threshold(1)` (`NANOBOX_AOT_THRESHOLD=1`, `?aotthreshold=N`)
restores the old behaviour exactly, and re-measures at 31.3 s and 600 MB.

Merged and verified on the shipping engine (codex boot to the sign-in prompt, then 20 keystrokes
1.2 s apart, then the fib loop at n = 1e9):

| | boot | keystroke median | worst keystroke | keys > 100 ms | fib loop | compiled per session |
|---|---|---|---|---|---|---|
| **AOT** | **7.2 s** | **10 ms** | **38 ms** | **0** | **0.58 ns/iter (10,375 MIPS)** | **29 MB** |
| trace JIT (flag off) | 6.4 s | 11 ms | 41 ms | 0 | 2.14 ns/iter (2,808 MIPS) | 20 MB |

**Boot at parity, typing slightly better, compute 3.7x** -- where the same engine yesterday booted in
33 s, stalled 1.5-2 s per keystroke, and emitted 600 MB. Guest verified
(`fib(2000000) = 17141820111795327685`, `fib(10) = 55`, `call(200000) = 15034622464419917381`), gate
green on freshly built cold-boot engines (`IDENTITY: identical (codex + agy)`, `BISECT: no divergence`).

Two supporting findings:
* **It is our translator that is slow, not V8.** V8 compiles the 600 MB in 1.8-2.1 s; the engine spends
  ~25 s emitting it.
* **Runtime decode-ahead off by default** (`nanobox_jit_aot_ahead = 0`; the offline sweep re-enables it)
  gave an unexpected **3x on the hot loop**: with decode-ahead the loop's never-executed exit block
  joins the region, so the back edge goes through the region dispatch and pays the full inter-trace
  sync every iteration (1.78 ns) instead of staying a single-trace loop with the periodic check (0.59).

The "boot on the trace JIT, switch to AOT after" lever works (the switch costs 2.4-3.6 ms) but only
MOVES the cost -- with a sane threshold the boot is already fast without it. It is kept as a knob
because it is the only way to run the session at a LOWER threshold than the boot: `--aot-mode-at expect`
with `NANOBOX_AOT_THRESHOLD=256` gives boot 6.7 s, median 15 ms, max 138 ms and only 14.5 M interpreted
instructions in the session -- 93 % below the trace JIT's 202 M. If you keep it, the switch must
release every pre-switch translation (the modes give a compiled function different wasm signatures)
AND force a fresh link function, or the first post-switch call traps on a signature mismatch.

### T.1 Cold paths outlined: emitted code down 43-46 % (2026-08-19)

The 510-emitted / 30-executed problem: every memory site carried its own private copy of the
write-stamp dance, the spill and the handler-step prologue. Those are now **shared C++ helpers in the
engine**, imported by every JIT module through the existing import-by-table-index path
(`NANOBOX_OUTLINE=<mask>` / `nanobox_set_jit_outline`, default 2|8): bit 1 `syncBefore`'s stores, bit 3 the
handler-step prologue/epilogue.

| | before | after |
|---|---|---|
| default engine, emitted template bytes | 28.0 MB | **15.1 MB (-46.1 %)** |
| AOT mode | 33.0 MB | **18.7 MB (-43.3 %)** |
| whole-kernel artifact | 291.2 MB / 9.0 s | **191.6 MB (-34.2 %) / 6.8 s** |

Per site: `MOV_GqEq` 387 -> 172 B, `MOV_EqGq` 157 -> 64, `PUSH_Eq` 440 -> 178, `POP_Eq` 407 -> 190,
`CALL_Jq` 599 -> 296, `RET_Op64` 559 -> 478. Speed is flat everywhere except **+15 % on call+ret and
+5.8 % on default-engine boot**, and that cost is entirely explained below. Gate green on the merged
tree (`IDENTITY: identical (codex + agy)`, `BISECT: no divergence`), guest verified, fib loop unchanged
at 0.58 ns/iteration.

**The identity gate caught a real miscompile in this work**: the first run came back codex identical,
**agy DIFFERENT**. AVX-256 accessors work with `size == 32`; the new helper table stopped at 16, so
32-byte accesses silently used the 16-byte helper -- wrong DTLB index, wrong alignment mask, wrong
write-stamp length. Fixed with 32-byte helpers plus a size lookup that returns -1 for unknown sizes so
those sites keep the inline form. **codex alone never finds this**; two guests in the gate is what did.

### T.3 Is "everything precompiled, nothing interpreted" reachable? (2026-08-19)

One build, back to back (`thr` = JIT threshold, `interp` = in-run interpreted instructions):

| | thr | detform | artifact | boot | keys med/max | wasm | kernel served | user served | interpreted |
|---|---|---|---|---|---|---|---|---|---|
| **A** (shipped) | 2000 | off | none | **7.0 s** | 11/42 ms | 30 MB | -- | -- | 193.8 M |
| **B** | 1 | off | none | 22.7 s | 18/158 ms | 349 MB | 0 / 34,461 | 0 / 82,070 | **1.7 M** |
| **C** | 1 | on | kernel | 26.3 s | 17/157 ms | 349 MB | 14,413 / 6,840 = **67.8 %** | 73 / 91,949 | 1.6 M |
| **D** | 2000 | on | kernel | 7.7 s | 14/51 ms | **22 MB** | 2,535 / 729 = 77.7 % | 11 / 4,711 | 277.6 M |

**The property is reachable**: threshold 1 removes **99.1 %** of the interpreter's work (193.8 M ->
1.7 M). It costs 15.7 s of boot and 319 MB. **The deterministic former makes matching work** (a control
row with the same artifact and detform off serves 11.6 %; with it, 67.8 %; key agreement 99.8 %) **but
cannot buy the boot back, because the kernel is not where the lookups are**: 34,461 kernel against
82,070 user-space, and the artifact is kernel-only. A second control (function bound, no eager sweep)
collapses to 17.4 % serve without recovering boot, so the sweep is what makes the keys line up.

So: ship row A, keep detform off, and the sequence that would make C shippable is user-space artifact
coverage first (removes the 82,070 lookups and most of the 349 MB), then a deterministic dedupe (which
also collapses detform's 118,244 regions back toward 6,500).

### T.4 User-space artifacts: the mechanism works, ASLR blocked it, the image fixes it (2026-08-19)

Applying the function-scoped sweep to a user binary was built end to end and each piece verified:
codex's `.eh_frame_hdr` yields **294,540** function boundaries with no symbols; a `--fnlist` option
translates only the ones a scenario executes (all 294,540 project to ~4 GB, a scenario runs ~1,600);
`nanobox_aot_fnmap_gap` was needed because one sorted map now holds several text regions and without an
end sentinel an address in a gap got a 100 TB "function". Result: **1,612 codex functions -> 80,373
translations, 198.8 MB**, and in a boot with it the user artifact **served 36,337 lookups** where the
kernel-only artifact served 74. The chain -- ELF boundaries -> engine fnmap -> function-scoped sweep ->
content-keyed translations replaying at another base -- is proven.

**The blocker was the load base**: codex's text moved 51 GB between runs whenever anything changed guest
timing (`0x7f9406e9b000` vs `0x7f643e97f000`), because the guest runs `randomize_va_space=1`. Recording
the base and replaying it is self-defeating -- the pass that uses the map is not the pass that recorded
it. **Fixed by adopting the image built earlier with `norandmaps` on the kernel cmdline** (the same
class as the existing `nokaslr`, applied before any program maps; `work/pack-out-aot` -> the default
pack, previous pack kept at `work/pack-out-nb.pre-norand`). Re-verified after the swap: AOT boot 7.1 s,
keystroke median 11 ms / max 29 ms; trace JIT 6.4 s / 12 ms / 30 ms -- unchanged.

**Deterministic dedupe (detform bit 32) is a clean win**: "a successor already claimed by an earlier
region OF THE SAME SWEEP does not join", tracked in the sweep's own claim map. Artifact **375.1 MB ->
280.9 MB (-25 %) with MORE translations in it** (290,851 -> 294,634) and key agreement going
99.8 % -> 99.9 %. The old `se->jitfn` dedupe cost 98.7 % -> 83.1 % agreement; this costs nothing.

Outlining (T.1) also pays inside this work exactly as predicted: row C's compiled volume went
349 MB -> 203 MB (-42 %) and its boot 26.3 s -> 21.9 s with no other change.

### T.5 The answer: "nothing interpreted" is reachable, stable, and costs a boot (2026-08-19)

With `norandmaps` adopted, codex's text base is `0x7fffe905b000` under the trace JIT, under AOT, under
AOT+threshold-1+detform+dedupe, and in the offline driver's own recording run -- the same base every
time, where before the adoption the same comparison moved 51 GB. Everything below is on that image.

**The function set converges in two iterations**: 1,609 -> 5,572 -> **0 new**. The runtime touches 5,523
codex functions and every one is in the artifact, so coverage is SOLVED; what remained was key
divergence inside covered functions, fixed by the user-space member attach (safe now that a user page
cannot move: the member search requires equal physical address, trace length, real instructions AND
linear placement). That took regions 176,693 -> 90,634, wasm 228 -> 187 MB, user serve 62.5 -> 68.0 %,
worst keystroke 515 -> 172 ms.

| | boot | keys med/max | wasm | kernel served | user served | regions | interpreted |
|---|---|---|---|---|---|---|---|
| **A** shipped (threshold 2000) | **7.4 s** | 10/45 ms | **18 MB** | -- | -- | 2,658 | 203.9 M |
| **C** everything precompiled (threshold 1, detform 63, both artifacts) | 26.7 s | 17/172 ms | 187 MB | 66.8 % | 68.0 % | 90,634 | **1.3 M** |

**99.4 % of interpretation eliminated, for ~19 s of boot and ~430 MB of artifact.** Keys are no longer
the problem (99.9 % agreement) and neither is coverage. The problem is SWEEP SCOPE: threshold 1 with
function-scoped sweeps translates every path in every function the guest enters, and the guest runs a
fraction of them -- 90,634 region descriptors and 187 MB against row A's 2,658 and 18 MB.

So the conclusion the measurements support: **the interpreter earns its place on run-once code, and
AOT's win is the 3.7x on everything that repeats.** "Nothing interpreted" ships as an available mode
with a known price, not as the default. The next lever, if it is ever wanted, is not matching or
coverage but translating the paths a function actually RUNS -- per-function profile data in the
artifact, a different project.

Merged with `nanobox_jit_aot_detform` defaulting to 0. Gate on both guests, new image:
`IDENTITY: identical (codex + agy)`, `BISECT: no divergence`; guest verified; fib loop 0.62 ns/iteration;
icount 643,129,628 vs 643,129,730 AOT+detform vs AOT off -- 102 instructions in 643 M (1.6e-7).

## U. The live browser sandbox: two real defects, a split shell, and the MCP root cause (2026-08-19)

### U.1 `?cli=codex` was dead for a fresh visitor -- caused by suggesting `?aot=1`

The plain URL froze at "booting the guest..." at 0 % CPU with `RuntimeError: function signature
mismatch` inside `_start`. The browser records its own JIT cache as `auto-<engineTag>.nbjb`, and the
engine tag is computed from the WASM BYTES -- which are identical in AOT and trace-JIT mode. AOT
changes the SHAPE of a translation, so a cache recorded by an `?aot=1` session poisoned the plain URL
for everyone. Fixed by putting the mode in the name (`auto-aot-<tag>.nbjb`); both URLs boot again.
LESSON: a cache key must cover every input that changes the artifact's shape, not just the binary.

### U.2 The >1 s typing stalls: the emulator was running behind the page's main thread

xterm-pty makes every guest `poll_oneoff` / `fd_read` / `fd_write` a BLOCKING round trip to the page
(`postMessage` + `Atomics.wait`), and the engine polls stdin ~1500x/s, almost always finding nothing:

| main thread | guest | blocked in poll | blocked in write |
|---|---|---|---|
| idle | 108 MIPS | 6.1 % | 1.5 % |
| 50 % busy | 67 MIPS | 33.7 % | 9.5 % |
| 86 % busy | **21 MIPS** | **78.2 %** | 8.0 % |

A composer keystroke costs codex ~40 M guest instructions, so at 31 MIPS that is **1.3 s per key**, and
characters typed meanwhile queue in the pty until the guest reaches a poll the page answers -- the
"stall then flush" the user saw. It never reproduced in the harness because there the guest writes to a
pipe with no main thread in the path.

Fix (`web/ttysignal.js` + `web/opt-worker.js` + `web/sandbox.html`, `?ttyfast=0` reverts): a shared-memory
flag lets the worker answer empty non-blocking polls itself; output goes through the existing ring with
a non-blocking post. Key->paint under an 86 %-busy main thread: **69.3 ms -> 13.2 ms median**, and the
guest holds **124 MIPS instead of 31**. Fixing only the input half left writes blocking 71.8 % of wall.

### U.3 A shell beside the CLI, on the same guest (`?shell=1`)

CLI left, interactive `/bin/sh -l` right, same guest, draggable divider; the separate-tab path still
works. Opt-in because for codex/agy it changes the guest boot path (adds `/dev/hvc1` and a second
process) -- the exact path every measurement and the identity gate walk; with the flag off the page
emits a byte-identical spec. The pane's bytes never touch the VM worker's event loop, which is why the
shell answers while the CLI is busy (asserted as a test).

**Fixed a real pre-existing bug on the way**: `nbnode` sized every pty child from THE SHIM'S OWN TTY and
re-broadcast that on `SIGWINCH`, so the existing "+ terminal" tab always got a mis-sized pty. Added a
per-child resize op and a pinned-size flag. Verified three ways: 74/74 shim unit tests,
`test/split-shell-guest.sh` (no browser), and `test/e2e-split-shell.mjs` 8/8 across codex/claude/agy/sh.

### U.4 Syscalls and networking are unchanged by today's engine work

**`test/guest-smoke.sh`: 34/34 on all three engines** -- current `eh-nb` against two pre-change
baselines that predate the direct-call, density, deterministic-former, outlining and probe work -- with
**zero verdict differences**. Covers files (2 MiB round trip, permissions, symlink, rename), processes
(pipelines, exit codes, background + wait, `ps`), pty (`stty size`, termios, Ctrl-C interrupting a
sleep), time (frozen and real clocks) and the network syscall layer. The only cross-engine delta
anywhere is the hundredths of `/proc/uptime`.

### U.5 MCP `codex_apps`: root-caused to two buffering hops

`test/net-smoke.mjs` (browser, real egress): dns PASS, https PASS, bulk PASS (2,000,000 B), relay PASS,
**sse FAIL** (first event at +5,069 ms of a 5,000 ms stream) and **open FAIL** (0 bytes in 8 s). So the
guest CAN issue a streaming GET and it does reach the page's fetch layer -- but nothing is delivered
until end-of-body, which is exactly why MCP's `POST 200` / `POST 204` pair succeeds and the session then
dies. Two hops located by A/B: `public/c2w/dist/runcontainer.js`'s `http_writebody` (`resp.arrayBuffer()`
gates the status+headers the guest blocks on) and the imagemounter's `handleHTTP` (`io.Copy` with no
`Flusher.Flush()`, plus a busy-spin when `bodysize == 0`). The prototype hop-1 patch was reverted -- it
does not fix MCP alone and starves the netstack; the real fix needs `./build-imagemounter.sh`.

Note for anyone repeating this: for ~30 minutes no freshly opened page booted at all, and it was NOT
either change -- pristine `HEAD` stalled identically. Two agents were rewriting `web/opt-worker.js` in
one tree at the same time. Concurrent edits to a served file are indistinguishable from a product bug.

### U.6 Emitted operations, second pass: -29 % per compiled instruction (2026-08-19)

On the user's instruction that the numbers were unacceptable. Same binary, same codex session
(`NANOBOX_OUTLINE=203` = previous default vs 511947 = new):

| | total | instances | bytes/instance |
|---|---|---|---|
| before | 15.3 MB | 127,454 | 120.0 |
| **after** | **10.7 MB** | 125,606 | **85.2 (-29.0 %)** |

Per site: `MOV_GqEq` 175 -> **120**, `CALL_Jq` 297 -> **205**, `POP_Eq` 193 -> **128**, `PUSH_Eq`
175 -> **133**, `RET_Op64` 302 -> **190**, `MOV_EqGq` 72 -> **50**, `JMP_Jbq` 241 -> **114**,
`CALL_Eq` 435 -> **287**. The targets set (MOV < 100, RET < 150, CALL < 150, session < 10 MB) are
approached, not reached.

**Per-phase byte accounting in the emitter changed the plan**: the "per-site fault/exit arm" I had
ranked first is mostly the REGISTER SPILL (16.6 % of all emitted bytes) rather than the sync+accessor
(5.7 %), and an item that was not on the list at all -- the in-region transition -- was **255 bytes for
a two-byte `JMP rel8`**. Shipped, each behind a bit so any of it can be A/B'd in one binary: cold-path
spill outlined (**-10.8 %**, the single biggest), handler step/deopt as one call (-3.4 %), memory slow arm as one call
(-3.3 %), in-region transition outlined (-2.8 %, non-AOT only), CPU struct through a base local
(-1.0 %), template wrapper block elided (-0.8 %).

Nothing regressed: AOT fib loop 0.60 -> 0.59 ns/iteration with icount exactly 6007.2 M, call+ret
17.7/19.4 -> 18.2/18.1 ns, codex boot and sustained keystrokes flat on both engines, guest exact.
Gate: `IDENTITY: identical (codex + agy)`, `BISECT: no divergence`.

**Two findings worth more than the bytes:**
* **Outlining pays only where the inline form is long.** Outlining the in-region transition cost
  **+35 % on the AOT call+ret benchmark** and pushed the worst AOT keystroke to 389 ms, because AOT's
  relaxed boundary had already shrunk that edge to three ops. It is now gated to the non-AOT engine.
* **A bisect "divergence" that was the instrument again**: the first gate flagged a trace whose state
  was byte-identical on both sides -- only the trace INDEX differed, because `nanobox_stats.traces` is
  the divergence finder's own index and the edit had moved its bump in front of the fingerprint hook.
  The A/B that proved it: with every new bit OFF the same trace still diverged with the same chain
  hashes, so the culprit had to be the one edit not behind a bit.

### U.7 MCP fixed: a streaming response now reaches the guest as it arrives (2026-08-19)

Both buffering hops of U.5 fixed, and a third defect found in the measurement itself.

* **Hop A, `public/c2w/dist/runcontainer.js` `http_writebody`**: headers go out the moment the fetch
  resolves and the body streams through a reader, instead of the guest blocking on a status line that
  `resp.arrayBuffer()` gated. **Dropping `content-length` is load-bearing, not cosmetic**: measured in
  this Chrome, `api.github.com/zen` reports `content-length: 51` and decodes to **37 bytes**, with
  `content-encoding` hidden because it is not CORS-safelisted -- forwarding it truncates bodies. The
  consequence is that `http.Response.ContentLength` is 0 for proxied responses; nothing on nanobox's
  path reads it, a containerd registry pull would.
* **Hop B, imagemounter `handleHTTP`**: flush the status line before any body byte and after every
  chunk (replacing an unflushed `io.Copy`), and back the body goroutine off in stages --
  `runtime.Gosched()` for 16 empty reads, then 1 ms, then 10 ms -- instead of busy-spinning. The
  staging is what keeps bulk at full speed while not starving the single-threaded wasip1 netstack,
  which is what killed the earlier prototype.
* **The probe was wrong too.** With both hops in, `open` still failed at 1 event / 17 bytes -- but the
  server's own marks showed the window was **549 ms of wall clock, not 8 s**: the guest's clock runs
  ~15x fast and the probe used the guest's `timeout 8`. The check now calibrates from a stage whose
  true length the server knows, times the first event on the server's clock, and distinguishes
  INCONCLUSIVE from BUFFERED. The old form would have passed a hop that delivered everything at the end.

`test/net-smoke.mjs` **9/9**: first SSE event **5,066 ms -> 69 ms**; a never-ending stream goes from
**0 events to 8**, arriving 1/s while held open 7.2 s; `bulk` byte-exact and scaling linearly (2 MB in
633 ms, **20 MB in 6,390 ms** -- 10x bytes for 10.09x time). A real MCP streamable-HTTP handshake run
from inside the guest (`work/prof/mcp-session.mjs`) reacts to a server push while the GET is still
open: **before, `tools/list` never returned; after, 58 ms**. The before-leg transcript reproduces the
user's log exactly -- two POST results then silence.

Regressions all green: `guest-smoke.sh` 34/34, `e2e-sandbox.mjs --cli codex`, `e2e.mjs codex`,
`e2e-split-shell.mjs` 8/8.

**Not confirmed against the user's banner, because the account is signed out**: `/root/.codex/auth.json`
no longer exists -- one of our own `?reset=1` e2e runs wipes the persistent tree. The credentials were
present earlier today (`work/prof/j2-serve.log`). After signing in, `work/prof/mcp-check.mjs --tag
signedin` watches for the banner and reports every `/ps/mcp` request.

DURABILITY (closed): hop B is captured by `tools/export-patches.sh` into
`patches/c2w-imagemounter-notbefore.patch`. Hop A turned out to have a real upstream source --
`work/c2w-src/extras/runcontainerjs/src/web/runcontainer.js`, which `vm-build/build.sh` already builds
with webpack and copies into `public/c2w/dist/` -- so it is now `patches/c2w-runcontainer-stream.patch`,
wired into `tools/export-patches.sh` and `tools/bootstrap.sh` like every other out-of-tree change, and
the deployed artifact is the BUILD OUTPUT rather than a hand-injected bundle. Proven rather than
assumed: revert the source to pristine, apply the patch, `npx webpack` -> byte-identical to the
deployed bundle (and `stack-worker.js` / `worker-util.js` came out byte-identical too, which says this
toolchain matches the one the shipped bundles were built with). Both gates re-run against the build
output: net-smoke 9/9, MCP session reacting in 41 ms.

The `content-length` measurement now lives in the SOURCE COMMENT, so it travels inside the patch and
cannot be tidied away without reading it.


## V. Size, coverage and the new identity criteria (2026-08-19)

The user's ask: analyse emitted size again, propose how to raise AOT coverage and cut per-instruction
size, compare simple programs compiled to wasm directly vs through AOT, and — the standing constraint —
**change the identity criteria to heap content + syscalls, excluding call stacks**. Target: 10x less
emitted size and 10x less headroom. The written deliverable is `docs/aot-size-and-coverage.md`; this
section is the measured record behind it.

### V.1 The new oracle: heap + syscalls, stacks excluded (shipped, flag-gated)

`./test/gate.sh --criteria heap+syscalls`; the default gate is untouched. A guest-physical page is a
stack page **iff `BX_CPU_C::stackPrefetch()` resolved the stack window to it** — the architecture's own
definition, not an address heuristic, and it covers PUSH/POP/CALL/RET/ENTER/LEAVE, interrupt and
exception frames, IRET and task switches (NOT the SS-segment MOV forms -- see V.6). On codex: **398 pages
masked = 1.6 MiB of 226 MiB (0.69 %)**, 261,746 of 262,144 still compared (319 user stacks, 67
VMAP_STACK kernel stacks incl. the IRQ stack, 10 boot stacks, `init_thread_union`, `cpu_entry_area`).
Two guards: an `[RSP-4096, RSP+128 KiB)` proximity test (`--stack-span`, removes 1 page of 399) and a
per-page "last used as stack" sequence so recycled pages re-enter the comparison. **The mask is taken
from the reference side only** — the engine under test cannot excuse a page by calling it a stack.

Syscall trace: `SYSCALL`/`SYSRET` are trace-terminating and never inlined, so one hook covers
interpreted, JIT'd and AOT'd execution. codex records 18,053 calls and 1,246 write payloads (length +
FNV-1a + first 48 bytes). Stated gap: 159 syscalls return via IRET and have no `R` line.

**Proved not weaker where it matters.** T.1's real miscompile (32-byte AVX probes folded onto the
16-byte helper) was reintroduced deliberately: RAM oracle and heap+syscalls agree on all four cells —
codex identical either way, agy DIFFERENT either way. On broken agy the new oracle reports 38,697
NON-stack pages differing (the mask is not carrying the verdict) and pinpoints the divergence in the
syscall stream. Cost 1m15.7 s vs the RAM oracle's 1m15.6 s. Caveat: for an AOT engine whose tick count
legitimately differs, the heap half fails for non-bug reasons and **the syscall trace becomes the
load-bearing half**.

### V.2 Two-tier emission: 8.7x fewer bytes per instruction, and it does not buy speed

`NANOBOX_JIT_TIER=<mask>[:<promotion threshold>]`, default off. Tier 0 emits
`local.get 0` / `i32.const p` / `call $nanobox_t0_step` / `br_if 0` = **9-10 bytes per guest
instruction, uniform across opcodes** (MOV_GqEq 120 -> 10, CALL_Jq 205 -> 9, RET_Op64 189 -> 9,
PUSH_Eq 133 -> 10), with **no prologue at all** — it keeps nothing in wasm locals. Neither RIP nor
icount has to travel: entering instruction k, icount is already "retired before k" and RIP is already
k's start. **84.9 -> 9.8 B per compiled guest instruction (8.7x); a codex session's installed wasm
7.23 -> 0.59 MB (12.2x).** Gate green for tier-0-everywhere and for two-tier with promotion exercised.

The speed, hot loop n = 1e9: tier 1 (shipped) 2.14/2.15 ns; two-tier promote-at-2000 2.21/2.26 (within
3 %); **pure interpreter 34.27; tier 0 42.98/43.67**. Tier 0 is 20x slower than tier 1 and **25 %
slower than not compiling at all**, because Bochs' chained interpreter runs a whole trace per dispatch
while tier 0 pays a cross-module call per instruction. A floor variant (one call per TRACE, 0.35
B/instruction, 45x smaller) converges on being the interpreter and is still slightly worse than it.
So the premise "slower per execution but it only executes once" is **false**.

**The finding worth more than the bytes:** two configurations holding coverage and function count
constant (576.0 vs 574.3 M interpreted icount; 39,108 vs 40,271 installed functions) while varying
emitted bytes **6.8x** (56.43 -> 8.35 MB) show **no speed difference** — 79.9 vs 78.9 MIPS, 10.90 vs
10.89 s boot. J4 attributed its regression to "code explosion, 24.9 -> 61.2 MB"; **byte volume is
measurably not the mechanism**. The remaining candidate is the number of distinct compiled functions
being dispatched. Keep tier 0 as a lever where BYTES are the constraint (the browser `.nbjb`, the
191.6 MB kernel artifact), not as a coverage policy.

### V.3 Cache loading: the 1.5 s premise had gone stale; real cost 180 ms, now -45 %

A self-recorded codex artifact is **5.5 MB / 773 modules** (harness), 7.6 MB / 1,101 (browser); mean
module 6.8-7.0 KB / ~4.5-4.9 functions. Load cost **~180 ms harness, ~110 ms browser**, of which
**65 % is one synchronous `new WebAssembly.Module` per touched module while the guest waits**
(101-125 ms of it). `NANOBOX_BUNDLE_EAGER=auto` compiles the whole artifact up front when under
`NANOBOX_BUNDLE_EAGER_MB` (64): **19-21 ms in parallel instead of 101-125 ms serialized**; codex boot
5,783 -> 5,704 ms, cache load -45 %. `?jitfast=1` in the browser memoizes the engine tag per
engine-URL+ETag and speculates fetch/decode/compile (adoption still gated on the tag from the real
engine bytes): a wash on localhost, but -84-87 ms serialized and **-1.85 MB of transfer** (`kernel.nbjb`
was fetched and refused on every load — the harness records full-engine bundles, the sandbox runs slim).
Rejected by the profile, each with a number: `compileStreaming` (N modules, not one stream), dedupe
(8 duplicates of 1,101), a leaner index (3-7 ms total), an IndexedDB compiled-module cache (<=45 ms,
already hideable), granularity re-tuning (whole artifact compiles in 19-28 ms in parallel).

Operational finding: closing the sandbox tab at the sign-in screen leaves codex's sqlite damaged, so the
NEXT codex run dies in "state db backfill" — that is the intermittent boot failure seen all day. Loops
that run codex repeatedly must wipe `/root/.codex` first.

### V.4 Still open (plan items 8, 9)

Per-function profile data in the artifact (which paths actually ran, to cut sweep scope and region
count); register renaming by rotation unrolling. Item 6 landed as V.6, item 7 was measured and
rejected in V.7, item 4 was measured and rejected in V.8, item 5 was measured in V.10 (the arm is
31.8 % of emitted bytes but already outlined; -1.7 % is what narrowing it is worth). All flag-gated, default off.
`work/prof/timelock.sh` serialises timed runs while several variants share the machine; every variant
tree keeps its own `work/j/<name>/bochs` so the shipping tree is never the experiment.

### V.6 A dedicated stack window for PUSH/POP/CALL/RET: -4 % bytes and **-33 % on AOT call+ret** (2026-08-19, `work/j/stacktag`)

Plan item 6 of `docs/aot-size-and-coverage.md`. PUSH/POP/CALL/RET paid the full general memory
machinery — a DTLB index, a page-identity compare and a permission test — for a slot on the one page
in the machine whose identity the CPU already knows.

**What it is.** `NANOBOX_STACKTAG=<mask>` (default 0 = today's engine, bit-for-bit). It is a flag
word of its own, exported as `nanobox_set_jit_stacktag`.
bit 0 = `emitStack{Read,Write}` (PUSH/POP/CALL/RET/ENTER/LEAVE), bit 1 = also 8-byte SS-segment
operands (frame slots), bit 2 = hoist the window's base pointer into a local.

**The mechanism is that there is no new mechanism.** The emitted site reads the CPU's OWN stack
window out of the CPU struct — `espPageBias`, `espPageWindowSize`, `espHostPtr`, the three fields
`stack_read_qword`/`stack_write_qword` themselves use:
`biased = off + espPageBias; if (biased >= espPageWindowSize) biased = nanobox_stack_fill(off);`
then `espHostPtr + biased`. The window is already `4096-7`, so the page-fit test for an 8-byte access
is folded into the same compare; there is no DTLB index and no offset compare.
**Invalidation is `invalidate_stack_cache()`** — paging.cc (TLB flush / CR3 / paging change),
proc_ctrl.cc (CR0/CR4), segment_ctrl_pro.cc (SS loads), tasking.cc, vm8086.cc, and `serveICacheMiss`
when the fetched page IS the stack page. Nothing new was invented, and the window survives a handler
step and a returning direct call — **which is exactly why it is faster, not just smaller**.
The two things the emitted form does not do (the #AC test, the write-stamp decrement) are handled by
closing the window in `stackPrefetch` when either is live, so such a page never reaches the fast path
and falls back to the ordinary accessor.

| codex session, trace JIT 2:2000, ONE binary | off | bit 0 | **bits 0+2** | bits 0+1+2 |
|---|---|---|---|---|
| `PUSH_Eq` | 133 | 114 | **108** | 108 |
| `POP_Eq` | 128 | 108 | **102** | 102 |
| `CALL_Jq` | 205 | 184 | **178** | 178 |
| `RET_Op64` | 190 | 169 | **163** | 163 |
| `MOV_GqEq` | 120 | 120 | 120 | 111 |
| `MOV_EqGq` | 50 | 50 | 50 | 46 |
| emitted total / instance | 10.9 MB / 85.2 B | 10.6 / 82.1 | **10.4 / 81.4** | 10.2 / 79.6 |
| installed session wasm (median of runs) | 7.26 MB | — | **7.05 (-2.9 %)** | 6.97 (-4.0 %) |

**Speed — this is the result that matters.** Interleaved A,B,A,B in one binary under `timelock.sh`:

| | off | bits 0+2 |
|---|---|---|
| **AOT call+ret** (`call.x86`, 100 M it) | 18.09 / 19.90 ns | **12.75 / 12.67 ns (-33 %)** |
| non-AOT call+ret | 35.54 / 36.72 ns | 31.33 / 31.29 ns (-13 %) |
| AOT fib n=1e9 | 0.61 / 0.60 ns | 0.59 / 0.60 ns |
| non-AOT fib n=1e9 (4 pairs) | 2.14 / 2.23 / 2.13 / 2.13 | 2.19 / 2.18 / 2.15 / 2.16 |
| codex boot / keystroke median / MIPS | 6.1-6.5 s / 172-181 ms / 106-110 | 5.9-6.1 s / 170-173 ms / 110-112 |

The census says why (level 3, `NANOBOX_PROBE_STAT=1`): DTLB-indexed accesses fall **-21 %** with bits
0+2 and **-35 %** with bit 1 as well. On `call.x86` the two stack accesses are the loop's whole memory
traffic, and the window serves them out of the CPU's own fields with one compare each.

**Gates, all three green** (`work/prof/stacktag/gate-*.md`):
* flag OFF, default `ram` criteria: `IDENTITY: identical (codex + agy)`, `BISECT: no divergence`.
* `NANOBOX_STACKTAG=5`, `--criteria heap+syscalls`: identical on BOTH guests — and stronger than
  required, `ticks same, rip same`, 0 of 398 (codex) / 700 (agy) masked stack pages differ.
* `NANOBOX_STACKTAG=7`, same oracle: identical on both guests, no divergence.
Kernels exact at every mask (`fib(2000000)`, `call(200000)`).

**What turned out to be false.**
* `docs/aot-size-and-coverage.md` §5.1 says the oracle's stack definition covers "the decoder's
  SS-segment MOV forms". In THIS Bochs that is only half true: `assignHandler`
  (`cpu/decoder/fetchdecode32.cc`, the single handler-assignment path for 32- and 64-bit decode)
  redirects only `BX_IA_MOV_Op32_{GdEd,EdGd}` to `MOV32S_*`. `MOV64S_EqGqM`/`MOV64S_GqEqM` are
  defined in `cpu/data_xfer64.cc` but **no `BX_IA_MOV64S` opcode exists and nothing assigns them** —
  they are dead code. So a 64-bit `mov %rax,(%rsp)` does NOT go through `stackPrefetch` here, and
  bit 1 is therefore NOT anchored in "the CPU already calls this a stack access". It is safe for a
  different reason (the window is strictly stricter than what `read/write_linear_qword` check:
  write-permitted at the current CPL, no page split, no #AC, no write stamps), and it measures well,
  but it is a policy choice rather than an x86-truth one. Recommended default: **bits 0+2 (mask 5)**.
* The byte prediction was optimistic: ~33 B/site expected, 25-27 B/site delivered, i.e. **-4 % of
  emitted bytes, not a collapse**. Four of the six costliest opcodes got 12-20 % smaller each; the
  rest of `CALL_Jq`'s 178 B and `RET_Op64`'s 163 B is the exit/deopt/direct-call machinery, not the
  memory access. Treating this as a size item undersells it — it is a speed item.
* Reusing the CPU's fields directly (rather than a nanobox mirror) was worth it twice over: it made
  the invalidation question disappear, and it avoided touching `cpu/cpu.h` (which the Makefile does
  not dependency-track).

Files: `nanobox_jit.cc` (`nanobox_jit_stacktag`, `nanobox_stack_fill`, `stackWindow`/`pushStackAddr`,
`emitStack{Read,Write}`, `emitRead`/`emitWrite` for bit 1), `cpu/stack.cc` (close the window on #AC /
write-stamped pages when the flag is on), `harness/run.mjs` (`NANOBOX_STACKTAG`).
Scripts: `work/prof/stacktag/st-{size,speed,aot,session,census,correct,gate}.sh`.

**Merged into `bochs/bochs` and made the default (mask 5) on 2026-08-19.** The gate for the default
flip rebuilt only the two optimized engines, leaving `ref-nowiz` without the change, so it compares an
engine that emits the stack window against a reference that does not: `IDENTITY: identical (codex +
agy)`, `BISECT: no divergence`, rc=0. `NANOBOX_STACKTAG=0` restores the previous emission exactly.
Confirmed on the merged `build/eh-nb`: AOT call+ret 17.91/18.27 -> 12.32/12.03 ns (-32.6 %), non-AOT
33.77/35.34 -> 30.96/29.88 ns, fib control flat at 2.14-2.18. Codex session x2: wasm 7.34 -> 7.11 MB
(-3.1 %), boot 6.05/6.23 -> 5.94/5.90 s, MIPS 110.3/108.9 -> 114.3/112.0 -- boot and MIPS are inside
the noise band and are recorded as consistent-with, not as evidence.

### V.7 Deferring or eliding the CALL return-address store: measured, unsound, and it does not pay (2026-08-19, `work/j/retaddr`)

Plan item 7 of `docs/aot-size-and-coverage.md`. Under the new oracle (§5.1) the bytes a `CALL` writes
to the guest stack need not exist — provided **nothing else reads them**. That proviso is the whole
item, and it is where the work went. Result: **it is false often enough to break the guest, the
elision is worth at most −16.6 % on `CALL_Jq` and −11.1 % on `RET_Op64` (≈ −4.4 % of a codex
session's emitted bytes), and no configuration that removes the store keeps the guest alive.**

Flags, all AOT-only and all default OFF (`nanobox_jit_flags`, `NANOBOX_FLAGS=`):

| bit | value | what |
|---|---|---|
| 11 | 2048 | **bookkeeping**: a CALL records `{rsp_after, return VA, cr3}` on a host shadow stack *as well as* storing it; a RET reports whether the shadow would have answered, and whether its answer equals what the guest actually has. Zero behaviour change — this is the measurement. |
| 12 | 4096 | with 11: **elide** the store. `CALL` writes nothing to emulated memory; `RET` has no inline stack read, only the shadow plus one outlined arm. |
| 13 | 8192 | with 11: count (and, with 12, materialise) guest loads/stores that touch a still-deferred slot. A span test in front of every access — measurement only. |
| 14 | 16384 | keep the liveness filter when materialising (A/B; it made no difference). |
| 15 | 32768 | pair the shadow with the **direct call** (`emitDirectCall`/`L_direct`, bit 9) instead of with RSP: the caller truncates the shadow to its own depth when its `call_indirect` returns, so the shadow nests with the host wasm stack. |
| 16 | 65536 | do not flush in `exception()`/`interrupt()` (A/B; no difference — the shadow is empty there 4 times per run). |
| 17 | 131072 | with 12: the shadow push out of line (`nanobox_ra_push_fn`) instead of ~20 inline ops. **This is the only bit that made `CALL_Jq` smaller.** |

Materialisation ("escape") points, which is what the previous attempt (S.1, `NANOBOX_AOT_NOSTACK`)
did not have: `nanobox_cold_sync` (every merged slow arm and handler step), `nanobox_helper_sync`
(every `syncBefore`), `nanobox_helper_step_pre`, the top of cpu_loop's trace loop, `BX_CPU_C::
exception()` and `interrupt()`, a RET whose shadow entry is not its partner, and the direct-call
unwind. Entries below RSP (frame already popped) or more than 1 MiB from it (the guest switched
stacks) are dropped rather than written back, because writing them would clobber whatever the guest
has since put there.

**Applicability, measured on a codex session** (bookkeeping + watch, `NANOBOX_FLAGS=10831`, AOT, level 3,
`work/prof/ra-run.sh`; the guest is unmodified, so its own stack is the ground truth):

| | count | of |
|---|---|---|
| CALL sites that pushed a shadow entry | 16,841,887 | |
| RETs whose top shadow entry matched RSP | 15,011,291 | **69.1 %** of 21,721,431 RETs |
| ... and whose shadow address **differs from the guest's own stack** | **24,954** | **0.166 %** of those hits |
| pairs whose slot was read or written by other guest code in between | 183,178 | **1.22 %** of hits |
| guest reads / writes of a still-deferred slot | 1,182,175 / 982,711 | 1,666,389 of them of a NON-innermost frame |
| flushes / entries materialised / dropped | 849,701 / 1,830,172 / 158,516 | drops: 119,231 dead frame, 38,861 stack switched |

On the `fib`+`call` kernel workload the wrong-answer rate is **0.55 %** (5,055 of 921,415). **An RSP
match is not a proof of partnership** — the guest rewrites return addresses (retpoline thunks do
`mov %rax,(%rsp); ret`), returns through addresses it pushed itself, and leaves unmatched entries
behind after longjmp/unwinding that later alias by address. 0.17-0.55 % of 15 M RETs is hundreds of
thousands of jumps to a wrong address per session, which is exactly why every eliding configuration
hangs.

**Every elision configuration hangs the guest**, at the same place, before the shell prints anything
(`work/prof/ra-mini.sh`, `/bin/sh -c "echo MINI-OK"`; baseline 0.96 s):

| flags | | result |
|---|---|---|
| 591 (AOT, flag off) | | MINI-OK, 0.96 s |
| 2639 (bookkeeping) | store kept | MINI-OK, 1.26 s |
| 6735 (elide) | | **hangs**, spinning on PAUSE/LFENCE/RDTSCP (17 M handler steps each) |
| 23119 (elide, liveness filter on materialise) | | hangs |
| 14927 (elide + watch materialises on touch) | 21,147 slots materialised on touch | hangs |
| 39503 / 47695 (elide, paired with the direct call) | 15,709 unwinds, shadowWrong 0 | hangs |
| 72271 (elide, no exception flush) | | hangs (the shadow is empty at 4 exceptions/run) |

The PAUSE+LFENCE spin is the retpoline speculation trap, which is the signature of a return landing
in the wrong place. Closing the read hole (bit 13 materialises before the access) does not fix it,
and neither does pairing by the wasm call stack instead of by RSP — so the failure is not one missed
escape but the general one: **the guest treats the return-address slot as ordinary memory and there
is no cheap way to know when it is doing so.**

Honest gap: in the direct-call-paired configuration (39503) the shadow is almost never consulted
(5,605 hits against 48.76 M flushes and 48.97 M outlined RET reads) — i.e. nearly every address IS
materialised before it is read — and the guest still hangs. The counted reads (1) do not explain
that, so a residual defect in the deferral machinery cannot be excluded on top of the measured
unsoundness of the pairing. It does not change the recommendation: the sound version costs more than
it saves whether or not that residual exists.

**The bytes, if it did work** (AOT, level 2, same workload so the same ~510-site population,
`work/prof/ra-mini.sh --tpl-bytes`):

| opcode | flag OFF | elide, inline push | elide, **outlined push (bit 17)** |
|---|---|---|---|
| `CALL_Jq` | 567 B | 571 B (+0.7 %) | **473 B (−16.6 %)** |
| `RET_Op64` | 350 B | 311 B (−11.1 %) | **311 B (−11.1 %)** |

The inline shadow push costs exactly as much as the store it replaces — the store's slow
arm is already outlined (`nanobox_jit_outline`), so there was nothing to win until the push was
outlined too. Applied to a whole codex session (`CALL_Jq` 3.3 MB, `RET_Op64` 0.79 MB of 14.6 MB
emitted) the ceiling is **0.64 MB, i.e. −4.4 % of emitted bytes** — a third of what §4.2 projected
from the 190 B `RET` figure, because that figure is the trace-JIT template and most of the AOT one is
exit/deopt/direct-call machinery, not the memory access.

**Speed** (`work/prof/dcall-bench2.sh`, `work/fib/call.x86`, 10.22 guest instructions per iteration,
AOT + direct calls, interleaved A,B,A,B under `work/prof/timelock.sh`):

| | call+ret ns/it | call-free fib ns/it |
|---|---|---|
| flag OFF | 18.08 / 18.32 | 0.58 / 0.58 |
| bookkeeping (bit 11) | 19.20 / 20.00 (+6 %) | 0.58 / 0.59 |
| elide (bits 11+12) | not measurable — the guest hangs | |

**Gate.** Both legs run against `build/retaddr` / `build/retaddr-nowiz` (logs
`work/prof/ra-gate{1,2}.log`; note `work/gate/latest.md` is shared and another agent's gate
overwrote it while these ran — the per-leg logs are the record).

* **Flag OFF, default RAM oracle: `IDENTITY: identical (codex + agy)`, `BISECT: no divergence`, exit 0.**
  Carrying the machinery costs the shipped configuration nothing: the emitted code is unchanged
  (every predicate is `nanobox_jit_aot && flag`) and the C++ escape points are a load-and-branch on
  a counter that is zero.
* **Flag ON (`NANOBOX_AOT=1 NANOBOX_FLAGS=137807`), `--criteria heap+syscalls`:
  `IDENTITY(heap+syscalls): DIFFERENT`, `BISECT: DIVERGENCE`, exit 1** — and NOT because pages or
  syscalls differ: the optimized side never reaches the codex prompt at all. It sat in the retpoline
  spin for seven minutes and had to be killed (`test/identity.sh` sets no run timeout). **This is a
  real failure of the new oracle with the flag on, reported as one.**

**What this says about plan item 7.** The relaxation §5.1 grants is real but it is not the binding
constraint: the constraint is that guest code reads its own return addresses, and detecting that
needs a check on every guest memory access whose cost exceeds the ≤ 4.4 % the elision buys. The
sound version of "defer" is therefore a net size **loss**, and the unsound version does not run.
Item 7 should be marked as measured-and-rejected, not deferred. What remains worth doing on these
two opcodes is the exit/deopt machinery they carry (the majority of both templates), not the store.

Files: `nanobox_jit.cc` (`NbRaEnt`/`nanobox_ra*`, `nanobox_ra_flush`/`_check`/`_watch`/`_unwind`/
`_ret`/`_push_fn`/`_push_slow`, `raOn`/`raElide`/`raWatch`/`raV1`, `emitRaPush`/`emitRaPop`/
`emitRaRetSlow`/`emitRaWatch`, `BX_IA_CALL_Jq`/`BX_IA_RET_Op64`, `emitDirectCall`, `tlbProbe`),
`cpu/cpu.cc` + `cpu/exception.cc` (the C++ escape points), `harness/run.mjs` (`summary.raStats`).
Scripts: `work/prof/ra-{run,mini,correct,gate}.sh`.

### V.8 Decode-time attach: it does not pay, and the premise it was written on is wrong (2026-08-19, `work/j/attach`)

Plan item 4 of `docs/aot-size-and-coverage.md`, behind `nanobox_jit_attach_decode`
(`NANOBOX_ATTACH=<mask>`, AOT-only, **default 0** — `NANOBOX_AOT=1` alone changes nothing). From
`serveICacheMiss` → `nanobox_jit_after_decode`, i.e. before the block has ever executed:
**1** attach the live region that already covers this address (attach registry, no forming);
**2** + sweep the containing FUNCTION exactly as the artifact's producer swept it
(`nb_aot_sweep_function`) **with the compiler switched off** (`nb_attach_nocompile`), so every region
the sweep forms is looked up and attached if the artifact holds it and thrown away if it does not —
nothing is ever translated from inside the decoder; **4** do all of that and keep nothing (cost
isolation); **8**/**16** kernel/user only; **32** the cheap variant, one region formed at the function
entry instead of the sweep. Diff `work/prof/attach.diff`, scripts `work/prof/attach-*.sh`.

**Correction to §4.3 item 2 of the doc: "every block's first run is interpreted because compilation is
triggered BY that execution" is false for artifact HITS.** `cpu_loop` calls `nanobox_jit_maybe_compile`
*before* `execute1`, and `nanobox_jit_try_cached` attaches a bundle hit synchronously there, so at
threshold 1 a served block already runs compiled the first time. The residual traces are the artifact
MISSES: they must be compiled, the compile is queued in a batch, and the block runs interpreted exactly
once while the batch is open. Decode-time attach cannot remove those without compiling — which is the
one thing it must not do.

**Every row below is one binary, `build/attach`, codex to the sign-in prompt then 20 keystrokes 1.2 s
apart (`work/prof/bootlat.sh`), two interleaved passes, artifacts regenerated against this engine
(kernel 229.9 MB / 294,634 translations, codex 303.6 MB / 178,948 over the converged 5,572-function
list).** `interp` = in-run interpreted traces / instructions.

| | ATTACH | boot | wall | MIPS | interp traces | interp instr | wasm compiled | kernel served | user served |
|---|---|---|---|---|---|---|---|---|---|
| **A** shipped (AOT, thr 2000, no detform, no artifact) | – | 6.7 s | 26.7 s | 155 | 28.58 M | 205.5 M | 15.1 MB | – | – |
| **Aa** + detform 63 + both artifacts = **flag OFF** | 0 | 8.4 s | 28.0 s | 146 | 32.40 M | 227.9 M | 11.9 MB | 82 % | 46 % |
| **Ad** member attach only | 1 | 7.8 s | 27.4 s | 161 | 28.61 M | 199.5 M | 11.7 MB | 84 % | 46 % |
| **Ae** member + one region at the function entry | 33 | 10.2 s | 30.0 s | 144 | 24.76 M | 170.4 M | 11.5 MB | 14 % | 20 % |
| **Ab** member + lookup-only function sweep | 3 | **16.1 s** | 36.5 s | **112** | **19.74 M** | **133.2 M** | **3.6 MB** | **91 %** | **54 %** |
| **Af** the same, kernel only | 11 | 10.3 s | 30.2 s | 146 | 24.69 M | 179.3 M | 11.5 MB | 91 % | 45 % |
| **Ag** the same, user only | 19 | 12.6 s | 32.6 s | 130 | 28.47 M | 187.9 M | 4.2 MB | 82 % | 54 % |
| **Ac** find everything, **keep nothing** (cost isolation) | 7 | 8.9 s | 28.6 s | 150 | 36.39 M | 259.1 M | 7.8 MB | – | – |
| **C** threshold 1 + detform 63 + both artifacts | 0 | 22.9 s | 43.3 s | 94 | 0.149 M | 1.16 M | 142.1 MB | 77 % | 51 % |
| **Cb** the same + decode-time attach | 3 | 21.2 s | 41.2 s | 99 | 0.124 M | 0.97 M | **74.5 MB** | 77 % | 42 % |

**The verdict: no policy I could find pays.** The best coverage policy (Ab) removes **39 % of
interpreted trace executions and 42 % of interpreted instructions**, raises the artifact serve rate
82 → 91 % (kernel) and 46 → 54 % (user), and cuts runtime compilation **11.9 → 3.6 MB (-70 %)** — and
costs **boot 8.4 → 16.1 s and session MIPS 146 → 112**. Keystroke latency is unchanged (median 10-13 ms
either way; the worst key moves 26-32 → 160-167 ms). Restricting it to the kernel (Af) or to user space
(Ag) buys proportionally less for proportionally less; neither turns positive.

**Where the time goes — and it is not the lookup.** Ab and Ac differ in exactly one thing: whether the
translation that was found is kept. They do the same 12.4 k function sweeps and Ac does 328 k artifact
lookups against Ab's 151 k.

| | wall | artifact lookups | V8 module instantiate | interpreted traces |
|---|---|---|---|---|
| Aa (flag off) | 28.0 s | 16,899 | 449 ms | 32.40 M |
| Ac find, keep nothing | 28.6 s | 328,066 | 1,547 ms | 36.39 M |
| Ab find and keep | 36.5 s | 150,569 | 2,704 ms | 19.74 M |

So **finding the code costs 0.6 s; keeping it costs 7.9 s.** `NANOBOX_CACHEPROF=1` splits the lookup
itself out: 150,565 lookups / 2,870.8 ms of which 2,683.1 ms is the module compile+instantiate nested
inside the first hit of each module ⇒ **1.25 µs per artifact lookup** (1.15 µs in the flag-off run,
17,249 lookups / 421.5 ms with 401.6 ms nested). The 133 k extra lookups are **160 ms — 2 % of the
price**. Subtracting the lookups (0.6 s) and V8's module work (+2.26 s) from the +8.5 s leaves
5.6 s over the 12.66 M trace executions moved out of the interpreter = **446 ns each**; the Ab-vs-Ac
pair gives 402 ns over 16.65 M. **R.5's ~400 ns cold-entry price, reproduced by a completely different
mechanism.** That price, not matching and not coverage, is what decides this item.

**Would plan item 8 (per-function profile data) rescue it? No, and here is the number.** Profile data
would cut *sweep scope* — fewer regions formed, fewer artifact modules instantiated. That is the
0.6 s of forming plus at most the 1.16 s of module instantiation Ab pays over Ac: **≤ 22 % of the
7.9 s.** The remaining 6.7 s is the entry price of blocks that *do* run, just not often, and a profile
recorded in another run cannot make an entry cheaper. The quantity that decides is "does this block
repeat", and the runtime hotness counter already estimates it better than any static profile can.

**The one place it does help: the "nothing interpreted" mode.** On row C, decode-time attach claims each
function with a lookup-only sweep, so the threshold-1 path afterwards compiles only the blocks that
actually run: **runtime compilation 142.1 → 74.5 MB (-48 %), boot 22.9 → 21.2 s, interpreted traces
149 k → 124 k (-17 %)**. If that mode is ever wanted, `NANOBOX_ATTACH=3` makes it materially cheaper.
`NANOBOX_ATTACH=1` alone (member attach, no sweep, no extra lookups) is free — 32.40 → 28.61 M
interpreted traces at no measurable time cost — and equally worth nothing, which is one more instance
of the standing finding that interpretation VOLUME is not what costs.

**Gate, flag OFF (`build/attach` / `build/attach-nowiz`): `IDENTITY: identical (codex + agy)`,
`BISECT: no divergence`, rc=0.** Guest exact in every configuration with the flag ON, with the sweep
firing (3,423 sweeps, 3,153 of them handing the entry code): `fib(10) = 55`,
`fib(2000000) = 17141820111795327685`, `call(200000) = 15034622464419917381`.

**Gate, flag ON (`--criteria heap+syscalls`): DIFFERENT — and it is AOT's difference, not the flag's.**
Run with `NANOBOX_AOT=1 NANOBOX_AOT_DETFORM=63 NANOBOX_ATTACH=3` it reports
`IDENTITY(heap+syscalls): DIFFERENT` (codex: 43,220 non-stack pages, ticks 2,942,837,561 vs
2,945,550,625) and `SYSCALLS: DIFFER at trace line 77`. **The control with `NANOBOX_ATTACH` unset
reports the byte-identical failure** — same line 77, same two lines:
`A: S 40 9 2e286c000000 …` vs `B: S 40 9 1e26b0000000 …`, an `mmap` hint the guest derives from its own
clock. So §5.1's caveat is worse than stated: for AOT mode the heap half fails as predicted **and the
syscall half fails too**, at call 77 of 18,053, because the guest's own addresses depend on the tick
count. `--criteria heap+syscalls` is therefore NOT a usable oracle for an AOT-mode engine on this image;
what actually gates AOT-only work is the guest-result check plus the scenario reaching its prompt.

**A pre-existing latent fault, found on the way and proved not to be mine.** Row C (AOT, threshold 1,
detform 63, **both** artifacts) traps deterministically — `memory access out of bounds`, or
`null function or function signature mismatch` — right after the single `nanobox_jit_cache_clear` that
run performs (`cache:[…,…,1]`, 67,660 functions released). It reproduces on the ATTACH build and it
reproduces on a **layout control**: the pristine tree plus nothing but two unused globals and their two
exports (`work/prof/attach-ctl2.sh`), which cannot change behaviour. The pristine tree itself completes
(22.8 s). It needs detform bit 16 (the user-space member attach): with `NANOBOX_AOT_DETFORM=47` the same
build finishes in 26.0 s, and with the kernel artifact alone or with no artifact it finishes too. So
some entry or inline cache survives the cache clear holding a released region, and which build hits it
is decided by code layout. Not fixed here — it is in the threshold-1 mode, not in anything shipped —
but it should be fixed before that mode is used, and it is why C's numbers above come from the pristine
control and from an earlier ATTACH build rather than from the final one.

Files: `nanobox_jit.cc` (`nanobox_jit_attach_decode`, `nanobox_attach_stats`, `nb_attach_at_decode`,
`nb_attach_nocompile`/`nb_attach_discard` in `nanobox_jit_compile_one`/`nanobox_jit_try_cached`,
the hook in `nanobox_jit_after_decode`), `harness/run.mjs` (`NANOBOX_ATTACH`, `summary.attachStats`).
Scripts: `work/prof/attach-{cfg,sweep,art,correct,ctl,ctl2,diag}.sh`.

### V.9 A tick-insensitive syscall comparison: shipped and proved sharp — and AOT still cannot be gated by it (2026-08-19, `harness/sysnorm.mjs`)

Plan item 10 of `docs/aot-size-and-coverage.md`, which V.8 made the blocker for all AOT work: the
`heap+syscalls` oracle cannot judge an AOT-mode engine because *both* halves fail for non-bug reasons
once the tick count legitimately differs — the syscall half at line 77 of 37,193, on an `mmap` hint the
guest derived from its own clock (`2e286c000000` vs `1e26b0000000`), byte-identically with the flag set
and unset.

**Shipped behind a flag, default OFF.** `harness/compare-heap.mjs --normalise-addresses [delta|bij]`,
exposed as `test/identity.sh` / `test/gate.sh --criteria heap+syscalls-norm` (and `-normbij`). `ram`
and `heap+syscalls` are untouched: `./test/identity.sh both` still prints `RESULT: IDENTICAL` on both
guests and `--criteria heap+syscalls` still prints `SYSCALLS: IDENTICAL (37193 trace lines)`
(`work/prof/sysnorm-verify.log`). Only the syscall half is normalised; the heap half is unchanged.

#### The measurement that decided the design: **0 of 18,053 syscalls carry a run-varying address**

Two runs of the SAME reference engine, cold, full oracle instrumentation: the two 37,193-line traces
are **byte-identical**, 18,053 calls / 1,246 payloads / 17,894 returns on each side, heap digest
`8f98ca49bfc430f3` both times. So under the deterministic harness *nothing* varies run to run; an
address varies **only** when the tick count varies. In the AOT pair exactly **one** syscall invents a
new address — call #40, the Go runtime's arena hint — and every later difference is derived from it.

That killed the general "bijection over anything address-shaped" design the brief started from: a
bijection wide enough to cover 18,053 calls would be excusing differences that in practice never occur.
What shipped instead is far narrower.

#### The design

Compare up to a **consistent renaming of a small number of explicitly-created regions**, not up to a
free bijection:

* **Structure is literal, always**: line kind, ordering, sequence number, syscall number, the write
  payload's buffer index / length / `got` / FNV-1a.
* **A renamed region can only be created at a site where the guest legitimately invents an address**:
  the `addr` hint of `mmap`/`mremap`, and the return of `mmap`/`brk`/`mremap`/`shmat`. The region
  carries the length the guest asked for, so it is a bounded window.
* **Every other differing value — any argument, any return value, the RIP — is a violation unless an
  already-established region explains it.** `delta` (the default) explains a pair only when
  `vA − baseA == vB − baseB`: the same offset in the same renamed window. `bij` additionally lets two
  values inside one region pair bind 1:1 on first sight, injectively in both directions.
* Two rules close the binder sites, and they are what make it sharp rather than merely tolerant:
  a region may **not** be created for an address that already lies inside one (a "hint" pointing into
  a live arena is a value the guest *computed*, so it must be explained, not allowed to invent a second
  mapping), and a value that is **equal on both sides but lies inside a renamed region is itself a
  violation** — the region asserts the two sides hold that window at different addresses, so an equal
  value there contradicts it. Before these two rules the battery below caught 8 of 44 mutated `mmap`
  hints; after them, 37 of 37 and 200 of 200.
* **Registers past a call's arity are not compared** (counted and reported). The trace always prints
  six registers; for `sigaltstack` the last four are leftovers the kernel never reads. This is the one
  relaxation that is not a renaming — a static per-number fact, with unknown numbers defaulting to 6.
* **Write payloads stay literal.** A differing FNV is excused only if the 48 recorded bytes differ
  *only* in aligned 8-byte words that a region explains (a pointer inside the buffer); a differing FNV
  with an identical snippet is always a violation.

**The property that makes it safe:** on a pair whose ticks match, nothing differs at a binding site, so
**zero regions are created and the comparison degenerates exactly to the literal one.** Every green run
below reports `0 renamed region(s), 0 value(s) explained, 0 register(s) past the call's arity ignored`.

#### The four proofs

**1. The deliberately broken engine is still DIFFERENT.** `build/oracle-bug-nowiz` (T.1's miscompile:
32-byte AVX accesses folded onto the 16-byte helper) through the shipped criterion,
`OPT=build/oracle-bug-nowiz/out.wasm ./test/identity.sh agy --criteria heap+syscalls-norm` → **rc=1**:

```
  normalised (delta): 0 renamed region(s), 0 value(s) explained by a region offset, 0 register(s) past the call's arity ignored
SYSCALLS: **DIFFER** at trace line 10453 (line kind R vs S)
  last identical: S 5263 35 7fffb11988b8 0 0 0 276e03d4e1e0 a rip=55555b43bed7
  A: R 5263 0
  B: S 5264 309 7fffffffebb8 0 0 55556048b300 1 0 rip=55555b43c6d6
```

Same line, same evidence as the literal oracle, and **nothing was excused** (0 regions). The heap half
also reports 38,697 differing non-stack pages. On codex the broken engine is identical under the
normalised comparison exactly as it is under the literal one and under the RAM oracle — V.1's table is
reproduced row for row, not weakened.

**2. No false negative on the sharp path.** `./test/gate.sh --criteria heap+syscalls-norm --skip-bisect`
→ **`IDENTITY(heap+syscalls-norm): identical (codex + agy)`, rc=0** (`work/prof/sysnorm-gate.md`):
codex `HEAP IDENTICAL over 261746 non-stack pages` + `SYSCALLS: IDENTICAL UP TO RENAMING (37194 trace
lines)`, agy `261444` pages + `17273` lines, both with 0 regions / 0 renamed values / 0 ignored
registers. Bit-for-bit the `heap+syscalls` verdict, arrived at through the new code path.

**3. AOT: the failure moves 5.4x further in and then stops on something no renaming can fix.**
`NANOBOX_AOT=1 ./test/identity.sh both --criteria heap+syscalls-norm` (ticks 2,942,837,561 vs
2,945,550,617 on codex):

| comparison | codex fails at | agy fails at | on what |
|---|---|---|---|
| literal (`heap+syscalls`) | line 77 | line 77 | the `mmap` arena hint `2e286c000000` vs `1e26b0000000` |
| `-norm` (delta) | line 85 | line 85 | `S 44 9 2e286cc00000 …` vs `1e26b2c00000 …` — a *sub-range* of the arena at offset `c00000` vs `2c00000` |
| `-normbij` | **line 414** | **line 414** | `R 209 0` vs `R 209 1` |

Line 85 is a real behavioural difference, not an address: Go asks for a sub-range of the arena it
already reserved, and the offset differs because the runtime had allocated a different amount by then —
tick-derived, and `delta` correctly refuses to excuse it. `bij` binds it and reaches line 414, which is
**`futex(0x696d38, FUTEX_WAKE_PRIVATE, 1)` returning 0 on the reference and 1 under AOT** — a wake that
found a parked thread on one side and not on the other. **I believe this is a tick artefact, not a
defect**: it is a scheduling race in the guest's own runtime, it reproduces identically on both guests
and on V.8's independent AOT run, and no address normalisation can or should excuse a different return
value from `futex`.

It gets worse downstream, and this is the finding that matters most: **585 of the 1,246 codex write
payloads (158 of 323 on agy) differ**, starting at payload #31, which is
`'\r[OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOooOOOO…'` vs `'\r[OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOooOO…'` —
**the boot progress bar, whose marker position is a function of elapsed guest time.** The guest
*renders time* onto the console. No relaxation of a comparison can make those two byte streams equal
without discarding the payload check that carries most of the oracle's value.

**Conclusion for plan item 10: normalisation is necessary but not sufficient, and the remaining gap is
not in the comparison.** `--criteria heap+syscalls-norm` makes an AOT pair *comparable* (the verified prefix goes
from 76 lines to 84 in delta mode and 413 in bij) and it is now the right criterion to run on an AOT engine,
but on these two images it cannot certify one, because the guests observe time and change their
behaviour when it changes. What would actually close it is making the AOT run's **tick stream** match
the reference (tick accounting as a function of guest instructions rather than of how they were
executed) — that restores *both* halves at once — or a workload that does not read the clock, which is
what the guest-exactness kernels already are. Relaxing the comparison further only buys blunt.

**4. Synthetic mutations: 5,037 tried, 4,636 caught by `delta`, and every miss is a declared blind
spot.** `work/j/sysnorm/mutate.mjs` first builds a **legitimately relocated** trace — the three Go
arenas this guest reserves, moved the way the AOT run moved the first one — and checks the normalised
comparison accepts it (`literal: DIFFER at line 77`, `norm: IDENTICAL UP TO RENAMING`, 3 regions, 2,345
values renamed by offset). It then injects one point mutation at a time into that relocated trace and
counts. 200 attempts per class per guest:

| mutation class | tried (codex+agy) | literal | `-norm` delta | `-normbij` |
|---|---|---|---|---|
| in-arity arg → another address in the SAME renamed arena | 400 | 400 | **400** | 254 |
| in-arity arg → +0x1000 (pointer off by one page) | 400 | 400 | **400** | 329 |
| in-arity arg → value+1 (wrong length / flag / fd) | 400 | 400 | **400** | 387 |
| `mmap`/`mremap` hint arg0 (a binder site) | 237 | 237 | **237** | 230 |
| syscall number | 400 | 400 | **400** | 400 |
| RIP | 400 | 400 | **400** | 400 |
| return value +1 | 400 | 400 | **399** | 399 |
| write payload, one byte of the recorded snippet | 400 | 400 | **400** | 400 |
| write payload, FNV only (difference past the 48 bytes) | 400 | 400 | **400** | 400 |
| write payload, length | 400 | 400 | **400** | 400 |
| drop one line | 400 | 400 | **400** | 400 |
| duplicate one line | 400 | 400 | **400** | 400 |
| **register BEYOND the call's arity (declared blind spot)** | 400 | 400 | **0** | 0 |
| **total** | **5,037** | **5,037** | **4,636** | **4,399** |

**Excluding the one declared blind spot, `delta` catches 4,636 of 4,637** (the single miss is a
`brk`/`mmap` return value, i.e. the other declared binder site). `bij` costs 237 more misses, almost all
in "a pointer replaced by another pointer in the same arena" (400 → 254) — that is the price of the
extra 329 lines of AOT prefix (84 → 413), stated so the choice is explicit. **`delta` is the default.**

#### What the oracle still cannot see

* **Registers past a syscall's arity** — 0 of 400 mutations caught. Note this blind spot only exists on
  a pair that already differs: on a tick-matched pair the count is 0, because those registers *do*
  match and are never skipped.
* **Anything after the first violation** — the comparison stops at the first differing line, as before.
* **A wrong value at a binder site whose consequences never appear**: an `mmap` hint or a `brk` result
  can still invent a region if nothing later contradicts it (1 of 400 return-value mutations).
* **Everything the pre-existing oracle could not see**, unchanged: call-stack bytes (398 codex / 700 agy
  masked pages), the 159 syscalls that return via IRET and have no `R` line, and any behaviour that
  never reaches a syscall.
* **An AOT engine's actual correctness on codex/agy**, for the reason in proof 3 — the images render
  elapsed time, so their own output is not tick-invariant.

Files: `harness/sysnorm.mjs` (new), `harness/compare-heap.mjs` (`--normalise-addresses`, default off),
`test/identity.sh` + `test/gate.sh` (`--criteria heap+syscalls-norm` / `-normbij`).
Harness and logs: `work/j/sysnorm/{runs.sh,verify.sh,mutate.mjs,syscmp.mjs}`,
`work/prof/sysnorm-{runs,verify,mutate,bug,gate}.log`, `work/prof/sysnorm-gate.md`.

### V.10 The per-site fault/exit arm: attributed byte by byte, and it is already outlined (2026-08-19, `work/j/faultarm`)

**Merged into `bochs/bochs` on 2026-08-19, default OFF.** The phase-op accounting (`nanobox_jit_phase_op`
+ the harness's opcode x phase matrix) comes with it -- that is the part worth keeping regardless of the
flag, since it is what produced the table above. Gate on the merged tree: `IDENTITY: identical (codex +
agy)`, `BISECT: no divergence`, rc=0; hot loop unchanged (fib 2.17 ns/it, call+ret 30.03 ns/it with the
stack window on). `NANOBOX_FAULTARM=5` is the -1.7 % lever, kept off because bytes are not the speed
mechanism (V.2) and 1.7 % of an artifact is not worth a default change.

Plan item 5 of `docs/aot-size-and-coverage.md`, briefed as "the same private-copy-of-shared-machinery
pattern that yielded 43-46 % on the DTLB miss path". **Measured: the fault/exit arm is 31.8 % of every
emitted byte — and the machinery inside it is already shared. What is still inline at each site is
per-site DATA, not a copy of a routine, and narrowing all of it is worth -1.7 %.**

#### The instrument (this is the primary result)

`--tpl-bytes` printed bytes per OPCODE and, separately, bytes per PHASE summed over the whole module.
Neither can answer "how much of `MOV_GqEq`'s bytes are the fault arm", which is the question item 5
turns on. The phase accounting is now two-dimensional: every phase record carries the guest opcode
whose template was being emitted, so `--tpl-bytes` prints an **opcode x phase matrix**.
`nanobox_jit_phase_op(ia, phase)` exports it, with the final-pass instance count at `phase == PH_N`
and `nanobox_jit_phase_drop()` reporting any record-buffer overflow. It is pure accounting: it emits
nothing, and the flag-off engine is bit-identical (gate below).

Two mechanical corrections fell out of building it:

* **`--tpl-bytes`' "bytes per site" is a pass-1 + pass-2 SUM.** `nanobox_tpl_bytes` and
  `nanobox_inline_count` are bumped on every compile pass; the installed module is only the final
  pass, which is what the phase accounting counts. On one codex session that is 10.9 MB over 128,564
  counted instances against **7.30 MB installed over 64,255 real ones**. Doc section 2's headline
  **85.2 B per compiled instance is really 112.3 B** — pass 1 emits ~0.86x pass 2 per instruction, so
  the two inflations do not cancel. Shares and rankings are unaffected; the absolute per-site numbers
  in section 2 and in T.1/V.6 are all ~1.2x low for the same reason.
* the async-event exit arm's register spill had been pooled with the fault arm's under `spill-cold`.
  Split: `spill-fault` (slow arm / handler step / transition / direct call) and `spill-async`.

#### The table — where a site's bytes are

Default engine, `--jit 2:2000`, real codex session (sign-in + 5 keystrokes), B per compiled guest
instruction on the final pass. The address-resolution columns are omitted (the phase columns no longer
sum to B/site).

| opcode | inst | B/site | other | eff-addr | access | slow-arm | spill-fault | async-check | exit | handler-step | rest |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `MOV_GqEq` | 5232 | **144.7** | 10.2 | 5.3 | 10.0 | 14.3 | 16.0 | 15.2 | 8.0 | 0.0 | 1.8 |
| `CALL_Jq` | 2263 | **220.2** | 59.4 | 0.0 | 12.0 | 16.2 | 33.0 | 0.0 | 15.9 | 14.1 | 7.3 |
| `RET_Op64` | 1088 | **204.9** | 42.2 | 0.0 | 10.0 | 14.3 | 41.0 | 0.0 | 16.0 | 14.4 | 5.3 |
| `PUSH_Eq` | 2660 | **154.3** | 21.1 | 0.1 | 12.2 | 16.3 | 14.5 | 15.1 | 8.0 | 0.0 | 6.4 |
| `POP_Eq` | 3233 | **150.9** | 22.9 | 0.0 | 10.0 | 14.3 | 19.1 | 15.2 | 8.0 | 0.2 | 1.1 |
| `MOV_EqGq` | 7477 | **57.3** | 6.7 | 1.8 | 4.1 | 5.6 | 6.8 | 5.2 | 2.7 | 0.0 | 2.7 |
| `JZ_Jbq` | 2712 | **79.9** | 32.5 | 0.0 | 0.0 | 0.0 | 17.0 | 0.0 | 7.9 | 14.2 | 8.3 |

Whole session, 7.30 MB installed: `other` (the guest semantics themselves) 26.5 %,
**spill-fault 9.4 %, exit 8.5 %, slow-arm 5.0 %, handler-step 4.5 %, async-check 4.4 %**,
prologue 5.1 %, access 3.8 %, common-tail 2.9 %, conform 2.0 %, lazy-flags 1.7 %, reg-load 1.4 %,
eff-addr 1.4 %, transition 1.1 %, tpl-wrapper 0.8 %, spill(exit)+spill-async 0.4 %, link-epilogue 0.0 %.

**So the fault/exit arm is genuinely the biggest thing at a memory site**: slow-arm + spill-fault +
async-check + exit + handler-step = **31.8 % of all emitted bytes**, 37 % of a `MOV_GqEq` site, 36 % of
`CALL_Jq`, **42 % of `RET_Op64`**. Section 4.2's bullet was right about the size of the target and
wrong about the shape of it.

#### Why the 43-46 % pattern does not repeat: it is already outlined

* the **slow arm** is one call (`nanobox_slow_rd/wr` via `mergeSlow`, `nanobox_jit_outline` bit 18);
  its 14.3 B is `local.get la` + `L_base` + `L_ic0` + two packed constants + `call`,
* the **handler step** is one call (bits 3|17),
* the **register spill** is one call (bit 11),
* and the **exit** is the shared tail after `$body` plus the spill chain. **99.4 % of all exits
  (84,539 of 85,042) take a chain position**, so an exit's whole register spill is `br` and nothing
  else — `spill-async` measures 0.00 MB and the exit-arm `spill` 0.03 MB of 7.30.

What remains per site is the parameterisation, and it is not shareable: the register values (they
live in wasm locals, so they must travel as arguments), the RIP offset, the icount delta, the
accessor selector. **`nanobox_jit_outline` bit 13** ("outline a cold EXIT arm's spill", shipped OFF)
was measured for the first time here and is a **no-op for exactly this reason**: 112.1 vs 112.3
B/instruction, 99.4 % chained either way.

#### What was implemented: `NANOBOX_FAULTARM=<mask>` (default 0, its own env)

This is its own flag word with its own env, as `NANOBOX_STACKTAG` is. Mask 0 reproduces the shipping
emission bit for bit.

* **bit 0 — widen the outlined cold spill from 3-10 registers to 2-18.** The old range was not a
  measured optimum, it was the set of helpers that existed; `nanobox_spill2` and
  `nanobox_spill11..18` fill it in (a 2-register spill is 12 emitted bytes against 18 inline, and the
  11+ cases are deopts after long templates). `char sig[16]` had to become `sig[24]`.
* **bit 1 — outline a cold EXIT arm's spill as well** (bit 13's idea over the widened range). **Null,
  as predicted by the 99.4 % chain rate.**
* **bit 2 — the exit descriptor carries the RIP as an OFFSET from `L_base`**, so a constant-RIP exit
  is `i64.const off; local.set T7` instead of `local.get L_base; i64.const off; i64.add; local.set T7`;
  the common tail adds `L_base` back once per unit. The three emitter sites whose exit RIP is computed
  at run time (indirect JMP/CALL, RET) pay one `local.get L_base; i64.sub` each.

| codex session | mask 0 | mask 1 | mask 4 | **mask 5** | mask 7 |
|---|---|---|---|---|---|
| B per compiled guest instruction | 112.3 | 110.4 | 112.1 | **110.4 (-1.7 %)** | 110.4 |
| `MOV_GqEq` B/site | 144.7 | — | 141.7 | **138.8 (-4.1 %)** | — |
| `CALL_Jq` / `RET_Op64` | 220.2 / 204.9 | — | — | **215.9 / 199.1 (-2.0 / -2.8 %)** | — |
| `PUSH_Eq` / `POP_Eq` | 154.3 / 150.9 | — | — | **146.1 / 145.8 (-5.3 / -3.4 %)** | — |
| `MOV_EqGq` | 57.3 | — | — | **54.9 (-4.2 %)** | — |
| `spill-fault` share | 9.4 % | — | 9.4 % | **8.0 %** | — |
| `async-check` share | 4.4 % | — | 3.6 % | **3.6 %** | — |

Installed session wasm 7.264 -> 7.246 MB, but read the B/instruction column instead: the session
compiles a slightly different amount of code every run (5,184-5,271 functions), so the normalised
figure is the honest one. **Mask 5 is the recommended mask**; bit 1 is kept only because it is free
and disproves its own hypothesis.

#### Speed: unchanged, which is the requirement

Everything the flag touches is on a cold arm except bit 2's four extra ops in the common tail, and
that is paid once per trace exit. Interleaved ABBA, `work/prof/timelock.sh` held throughout:

| | mask 0 | mask 5 |
|---|---|---|
| fib loop, n = 1e9 (trace JIT) | 2.17 / 2.14 ns/it | 2.15 / 2.16 ns/it |
| call+ret, 100 M iterations | 33.77 ns/it | 32.97 / 33.25 ns/it |
| codex session boot-to-prompt | 6327 / 6507 ms | 6397 / 6643 ms |
| codex session MIPS | 106.94 / 105.46 | 106.70 / 107.32 |
| guest kernels (`fib(10)`, `fib(2e6)`, `call(2e5)`) | exact | exact, same values |

A first, non-ABBA session pass read **-6 % MIPS with the flag on** and was an artefact: the four runs
declined monotonically (106.6 -> 100.0 -> 97.8 -> 91.5) as other agents' builds loaded the machine.
Re-run ABBA, the same comparison is +0.8 %. Interleaving is not optional on this box.

#### Measured and rejected, with the reason

* **`nanobox_jit_outline` bit 13** (outline a cold exit arm's spill): null, 99.4 % of exits are already
  chained. It should stay OFF and the doc should stop describing it as an untried lever.
* **Outlining the exit arm as a CALL** (`call nanobox_exit_sync(base, ic0, p1, p2)` in place of the
  inline RIP/icount handoff): counted, not built — the arm is 13 emitted bytes and the call form is
  13-15, because the shared tail already does the stores. The exit arm is not a private copy of
  anything; it is a `br` plus a descriptor.
* **Dropping the async-event check after a memory READ.** A read's fast path provably cannot set
  `async_event` (a read never touches a write stamp: no `decWriteStamp`, no `handleSMC`),
  so 15.2 + 8.0 B/site look free on `MOV_GqEq`. They are not: the check must fire AFTER the
  instruction commits, the value the slow arm produces is mid-block on the wasm stack, and exiting
  before the destination register is written re-executes the load — not idempotent for MMIO. Moving
  the check into the slow arm needs a flag local that costs what the check costs.
* **Packing the RIP offset and the icount delta into one `i64` constant** (~-7 B/exit, ~-5 % of a
  session): not attempted. It needs `L_xic` to be a compile-time constant, which `icDeferred()`
  (the AOT deferred clock) breaks, and it rewrites the contract of the shared tail that every exit in
  the engine goes through. Bit 2 is the safe half of it and delivered -0.2 %; the packed form is the
  remaining ~-4 % and is the one piece of item 5 left on the table.
* **Hoisting `L_base`/`L_ic0` out of `coldArgs` into engine globals** (4 B at every cold arm, ~-1.5 %
  net): rejected on arithmetic — it adds two stores to every function ENTRY, which is executed code,
  to save bytes on arms that are not.

#### Gates

* flag OFF, RAM oracle, `OPT/IOPT=build/faultarm{,-nowiz}`: **`IDENTITY: identical (codex + agy)`**,
  **`BISECT: no divergence`** (`work/prof/fa-gate-off.md`).
* **flag ON, `NANOBOX_FAULTARM=5`, the same RAM oracle**: **`IDENTITY: identical (codex + agy)`**,
  **`BISECT: no divergence`** (`work/prof/fa-gate-on.md`). This is the stronger check and it applies
  because the flag is not AOT-only — the tick count is unchanged, so V.9/5.1's AOT caveat does not
  bite. `--criteria heap+syscalls` was not needed.
* guest kernels identical on both masks (`work/prof/fa-cor2.log`).

Files: `nanobox_jit.cc` (per-opcode phase accounting + `nanobox_jit_phase_op/_drop`,
`nanobox_jit_faultarm` + `nanobox_set_jit_faultarm`, `nanobox_spill2/11..18`, `pushExitRip`),
`harness/run.mjs` (`--tpl-bytes` opcode x phase matrix, `NANOBOX_FAULTARM` env, cold-spill chain
stats). Tree `work/j/faultarm/bochs`, builds `build/faultarm{,-nowiz}`. Logs:
`work/prof/fa-{ab,ab2,cor2,speed,speed3,sess,gate-off,gate-on}.*`,
`work/prof/outline-data/tpl-fa2-*.txt`.

### V.11 The `nanobox_jit_cache_clear` fault: a re-entrancy double free, and the SHIPPED engine has it (2026-08-19, `work/j/clearbug`)

**Merged into `bochs/bochs` on 2026-08-19, fix ON by default (`NANOBOX_JITCLEARFIX=0` restores the
pre-fix control flow for an in-binary A/B).** Re-verified on the merged main engine, shipped JIT
configuration (`--jit 2:2000`, no AOT, no artifact, no bundle), with only the clear limit lowered to
force the trigger a long session reaches on its own:

| `NANOBOX_JITCACHE_LIMIT=3000` | exit | outcome |
|---|---|---|
| `NANOBOX_JITCLEARFIX=0` | **125** | **`RuntimeError: memory access out of bounds`** after 6 of 20 keystrokes |
| `NANOBOX_JITCLEARFIX=1` (default) | 0 | completes, 206 MB / 165,023 modules |

Gate on the merged tree: `IDENTITY: identical (codex + agy)`, `BISECT: no divergence`, rc=0.

**User-facing consequence, stated plainly:** this is a crash the shipped browser sandbox could reach in
a long session. It is bounded by a capacity trigger, not by a mode — a codex boot plus 20 keystrokes
leaves 7,649 live content keys against a 131,072 limit, so it needs roughly 17x that workload (or a
full attach registry) before the first clear fires, and the first clear is fatal as soon as a batch
flush has published a region, which after ~2 entries it always has. Every clear measured in the shipped
configuration (156/156) happened with a flush on the stack.

Plan item 11 of `docs/aot-size-and-coverage.md`, the live defect recorded at the end of V.8. **It is not
a threshold-1 defect and nothing "survives" the clear.** The clear is re-entrant: it is called from
*inside* two producers that are half way through publishing a translation, and it frees the objects
they are still holding — the arrow points the other way round from the V.8 guess.

**The three faults.** `nanobox_jit_cache_clear()` (`nanobox_jit.cc:5177`) frees every `Region` in the
content cache, frees every `Region` still listed in `nb_pending` (through `nanobox_jit_batch_drop()`,
`:5179` / `:5958`) and, through `hook_release_all()`, invalidates every function-table index the engine
has installed. It is reached from exactly two places, **both of which `nanobox_jit_batch_flush()` calls
once per queued entry**: `nanobox_jit_cache_put` when the cache reaches `JITCACHE_LIMIT` (`:5952`) and
`nanobox_region_attach` when the attach-registry pool is full (`:5798`).

1. **Double free — the one that kills.** `nanobox_jit_batch_flush` (`:5962`) hands `nb_pending[i].reg`
   to the content cache as it walks the batch (`:5980` → `c->region = reg` at `:5954`) but leaves the
   pointer in `nb_pending`. A clear at entry *i* therefore frees entries 0..*i*-1 **twice**: once
   through `nanobox_jit_batch_drop`'s `delete nb_pending[i].reg` (`:5958`), once through the clear's
   own jitcache sweep. `~Region` also `delete[]`s each block's decoded-instruction array, so the second
   free hands live emitter input back to the allocator.
2. **A released function index published into the FRESH cache.** Both the flush (`:5977`/`:5980`) and
   the non-batched compile (`:6048`/`:6050`) call `nanobox_jit_attach` **before**
   `nanobox_jit_cache_put`. A clear inside the attach releases `fn` with everything else, and the put
   then re-publishes that dead index under its content key in the now-empty cache. The next entry that
   looks the key up gets `e->jitfn = <released slot>`: `call_indirect` traps with **"null function or
   function signature mismatch"** while the slot is still null, and silently runs the wrong translation
   once the host has recycled it (`web/jit-host.js` pushes released slots onto `state.free`). The
   existing guard `if (jitcache_count == 0) e->jitfn = 0;` only catches a clear raised by the *put*,
   not one raised by the attach — the put afterwards puts the count back to 1.
3. **A dangling `Region` published.** The same put also stores `pd.reg`, already freed by (1).
   (Plus `nanobox_jit_promote` `:5872-5877`, which restores the saved `oldfn` when the compile it just
   ran cleared the cache. Tier-0 is off by default, so that one is latent only.)

**Minimal reproducer — and it is the SHIPPED configuration, not row C.** `--jit 2:2000`, **no AOT, no
artifact, no bundle**; the only thing changed is the debug knob that decides *when* the content cache
reaches its clear limit (`NANOBOX_JITCACHE_LIMIT`, added for this diagnosis; a long enough session
reaches the shipping 131,072 on its own):

```
NANOBOX_JITCLEARFIX=0 NANOBOX_JITCACHE_LIMIT=3000 TMO=200 \
  work/prof/bootlat.sh cb-S2-0 build/clearbug/out.wasm            # traps at boot, every time
NANOBOX_JITCLEARFIX=1 NANOBOX_JITCACHE_LIMIT=3000 TMO=200 \
  work/prof/bootlat.sh cb-S2-1 build/clearbug/out.wasm            # completes
```

The engine now counts the fault directly (`nanobox_jit_cache_stat` 3..10; harness
`statsEnd.cache`): `[jitcache_count, hits, clears, from-put, from-attach, **while a flush was on the
stack**, regions the flush had already published, released-fn publications avoided, flushes abandoned,
other, **DOUBLE FREES**]`. `nanobox_jit_batch_drop` measures the last one exactly — for each queued
region it asks whether the content cache already holds *that same pointer* under *that same key*.

| shipped config (`--jit 2:2000`, no AOT, no artifact) | fix | exit | clears | in a flush | already published | **double frees** |
|---|---|---|---|---|---|---|
| clear limit **131,072** (the shipping value) | 1 | 0, boot 6.3 s | 0 | 0 | 0 | 0 |
| clear limit 3,000 | **0** | **125 — `memory access out of bounds`, during boot** | 1 | 1 | 2 | **2** |
| clear limit 3,000, repeat | **0** | **125, byte-identical counters** | 1 | 1 | 2 | **2** |
| clear limit 3,000 | 1 | 0, boot 6.3 s | 52 | 52 | 115 | **0** |
| clear limit 3,000, repeat | 1 | 0, boot 7.0 s | 48 | 48 | 112 | **0** |
| clear limit 3,000, third | 1 | 0, boot 6.2 s | 56 | 56 | 137 | **0** |

**So: yes, the shipped engine is affected, and here is the condition.** Every clear the shipped engine
performs is raised by `nanobox_jit_cache_put`, which the batch flush calls per entry — so *every* clear
in the shipping configuration happens with a flush on the stack (52/52, 48/48, 56/56 above), and it is
fatal as soon as that flush has published at least one region, which after ~2 entries it always has.
The only reason it is not seen today is that the trigger is a capacity limit a short session never
reaches: a codex boot + 20 keystrokes leaves **7,649 live content keys**, and the clear fires at
**131,072**. It is therefore a long-session fault — a browser tab that runs ~17x that scenario's worth
of distinct code, or one that fills the 131,072-record attach registry — and when it fires the outcome
is a coin flip decided by the allocator, which is exactly the layout sensitivity V.8 saw. **Threshold 1
is not the bug; it is a way of reaching 131,072 keys in 20 s.**

**Row C (AOT, threshold 1, detform 63, both artifacts), as reported in V.8.** It reproduces: on the V.8
layout control `build/attach-ctl2` (`null function or function signature mismatch`, twice) and on the
first `build/clearbug` (`memory access out of bounds`; counters: the single clear came from the put,
landed inside a flush, 5 regions already published). With the fix that same binary **completes: boot
23.4 s, wall 43.7 s** (V.8's pristine control: 22.9 s / 43.3 s — the fix costs nothing). On the FINAL
binary the single clear happens to land *outside* a flush and both arms complete (boot 23.0 s, wall
43.3 s both ways) — the layout sensitivity, demonstrated rather than argued. Forcing the clear limit to
20,000 makes row C deterministic again on that binary too: **fix 0 → trap at 4.5 s, 2 clears, 4 double
frees; fix 1 → completes, boot 38.2 s, wall 60.3 s, 47 clears, 0 double frees** (the 38 s boot is the
tiny cache limit recompiling 556 MB, not the fix).

**The fix.** `nanobox_jit_batch_flush` takes the batch **out of the globals** (`nb_npending = 0`,
`nb_batch = NULL`) before anything it calls can re-enter the clear, so a re-entrant
`nanobox_jit_batch_drop` sees nothing and the queued regions are owned by that one frame; the frame
then watches `jitcache_clears` and, if a clear happened under it, disposes of its own region, disposes
of the rest of the batch and returns without publishing anything — because `hook_release_all()` has
just released every `out[]` of that batch. `nanobox_jit_compile_one` and `nanobox_jit_promote` take the
same generation check. **`NANOBOX_JITCLEARFIX` / `nanobox_jit_clearfix`, default 1 = ON.** This is a
pure correctness fix with no measurable cost — two stores and one 64-bit compare per batch entry, on
the compile path only, nothing in emitted code and nothing in the steady state — so it ships on; the
flag exists only so both arms can be A/B'd inside one binary, and 0 restores the pre-fix behaviour
exactly (the OFF arm's control flow, including the old `jitcache_count == 0` test, is untouched).

**Gate, fix ON (the default), `build/clearbug` / `build/clearbug-nowiz`: `IDENTITY: identical (codex +
agy)`, `BISECT: no divergence`, rc=0.** Guest exact in every configuration
(`work/prof/clearbug-correct.sh`, fix on/off, small clear limit, and AOT threshold 1 + detform 63):
`fib(10) = 55`, `fib(2000000) = 17141820111795327685`, `call(200000) = 15034622464419917381`.

**What turned out to be false.** (a) "Something survives the cache clear holding a released region" —
no: nothing outside survives, the clear reaches *into* its own caller. (b) "It is in the threshold-1
mode, not in anything shipped" (V.8) — false, see the table. (c) The
`JIT module rejected: expected 0 elements on the stack for fallthru, found 1` line that accompanies the
V.8 trap is not a separate emitter bug: it never appears with the fix on, and it is what a
double-freed `Region` looks like once the allocator has handed its `bxInstruction_c` array to the
batch module's buffer.

Files: `nanobox_jit.cc` (`nanobox_jit_clearfix` + `nanobox_set_jit_clearfix`, `nb_clear_diag` /
`nb_clear_why` / `nb_in_flush` / `nb_flush_published` / `nb_put_stored`, the rewritten
`nanobox_jit_batch_flush`, the generation checks in `nanobox_jit_compile_one` and
`nanobox_jit_promote`, the debug `nanobox_jit_cache_lim` + `nanobox_set_jit_cache_limit`),
`harness/run.mjs` (`NANOBOX_JITCLEARFIX`, `NANOBOX_JITCACHE_LIMIT`, `cache` stat widened to 12).
Tree `work/j/clearbug/bochs`, builds `build/clearbug{,-nowiz}`, artifacts `work/prof/cb{k,u-codex}.nbjb`.
The change as a self-applying script (verified to apply cleanly to today's `bochs/bochs`):
`work/prof/clearbug-fix.py`. Scripts `work/prof/clearbug-{repro,C,C2,ship,ship2,correct,gate,final}.sh`,
logs of the same names, gate report `work/prof/clearbug-gate.md`.

### V.12 AOT mode made TICK-EXACT: the RAM oracle now gates an AOT engine, with no relaxation and no measurable cost (2026-08-19, `work/j/tickexact`)

**Merged into `bochs/bochs` on 2026-08-19, default 0, and re-verified on the merged tree** (which also
carries V.6's stack window, V.10's fault-arm flag and V.11's clear fix):

```
REF=../build/ref-nowiz/out.wasm OPT=../build/eh-nowiz/out.wasm NANOBOX_AOT=1 NANOBOX_TICKEXACT=11 ./test/identity.sh both
  -> RESULT: IDENTICAL   (codex)
  -> RESULT: IDENTICAL   (agy)
control, same pair, NANOBOX_AOT=1 with the flag OFF
  -> DIFF ticks: 2942837561 != 2945550617   RESULT: DIFFERENT
```

The control matters: without it the run proves nothing. `./test/gate.sh` with the flag off on the
merged tree: `IDENTITY: identical (codex + agy)`, `BISECT: no divergence`, rc=0.

**A wrong result I published and then chased down**: my first attempt reported DIFFERENT. It used the
default REF/OPT pair (`ref-nb` / `eh-nb`), which are the WIZER builds -- the two wizer versions give the
two builds different pre-init snapshot phases on this kernel, which is exactly why `test/gate.sh` uses
the cold-boot `*-nowiz` pair for identity. The flag was never the problem; the engine pair was.

Plan item 12 of `docs/aot-size-and-coverage.md` — V.9's own conclusion ("the fix is a tick stream that
matches the reference, not a looser oracle"). **Result: `./test/gate.sh` with the ordinary `ram`
criteria reports `IDENTITY: identical (codex + agy)` and `BISECT: no divergence` for an engine running
`NANOBOX_AOT=1`.** The oracle problem is retired rather than worked around: no normalisation, no
stack mask, no syscall relaxation — ticks + RIP + SHA-256 of all guest RAM, bit for bit.

#### Why AOT ticks differ: it is not accounting, it is WHERE the boundary decision is taken

icount is charged correctly in AOT mode everywhere (that was fixed once already, hence the warning in
`emitLoopBack`). What AOT moves is the set of points at which `cpu_loop`'s between-traces work runs —
`delta >= currCountdown` (is a timer due) and `async_event` (is an interrupt pending). Miss one and the
guest takes its timer interrupt at a *different guest instruction*, its scheduler makes a different
decision, and every count downstream drifts. Three places do it, and **all three are load-bearing**:

1. the **self-loop back edge** runs the whole boundary once every `nanobox_jit_aot_tick` (64) iterations;
2. **forward in-region edges** (`aotFwd`) skip it entirely;
3. a **direct call** (`nanobox_jit_flags` bit 9) enters the callee with no boundary at all — a guest
   `CALL` ends a trace in the interpreter, and `cpu_loop` takes the decision at the callee's first
   instruction.

The fetch-window check is NOT one of them (see the ablation): skipping it can only cause or omit an
exit to `cpu_loop`, which re-does the same work at the same instruction.

#### The flag

`nanobox_jit_tickexact` — `NANOBOX_TICKEXACT=<mask>`, **AOT-only, default 0**; with the mask unset the
emitted code is unchanged (every use is inside an `if`, and `nanobox_jit_call`'s signature choice is
guarded the same way). Bits: **1** self-loop back edge syncs every iteration; **2** forward in-region
edges take the full boundary; **4** the fetch-window check on every in-region edge; **8** direct calls
off; **16** direct calls KEPT with `timer-due || async-pending` folded into the site's validity chain
(a due site falls through to the ordinary exit); **32** self-loop window *sized from the countdown*
(`ceil(currCountdown / instructions-per-iteration)`) plus a per-iteration `async_event` test, so the
sync lands on the iteration the interpreter would have taken it while the fast path keeps its
5-instruction countdown.

**`NANOBOX_TICKEXACT=11` (bits 1|2|8) is the exact mask, and it is minimal** — dropping any of the
three loses exactness.

#### Ablation: one binary (`build/tickexact`), codex to the sign-in prompt, `NANOBOX_AOT=0` is the reference

Reference: **icount 1,193,590,865, ticks 2,946,719,496**. These runs are deterministic — the same
configuration twice gives the same digits, and `NANOBOX_AOT_DETFORM=63` (the artifact configuration)
gives the same verdict as detform 0.

| TICKEXACT | what it restores | icount | ticks | ticks exact? |
|---|---|---|---|---|
| – (`NANOBOX_AOT=0`) | reference | 1,193,590,865 | 2,946,719,496 | – |
| 0 | AOT as shipped | 1,189,848,221 | 2,942,716,575 | no |
| 1 | loop | 1,191,632,938 | 2,944,840,127 | no |
| 2 | forward edges | 1,191,652,636 | 2,944,718,701 | no |
| 3 | loop + forward | 1,190,011,788 | 2,942,836,637 | no |
| 8 | dcall off | 1,189,717,961 | 2,942,841,469 | no |
| 10 | forward + dcall off | 1,189,717,964 | 2,942,841,469 | no |
| 9 | loop + dcall off | 1,193,590,880 | **2,946,719,496** | here yes — **cold boot NO** |
| **11** | **loop + forward + dcall off** | **1,193,590,865** | **2,946,719,496** | **YES** |
| 15 | + fetch window | 1,193,590,865 | 2,946,719,496 | yes (bit 4 buys nothing) |
| 19 | loop + forward + dcall boundary test | 1,193,590,595 | **2,946,719,496** | here yes — **cold boot NO** |
| 50 | forward + dcall test + dynamic window | 1,191,549,283 | 2,944,719,715 | no |

icount is not part of the identity criteria (`compare.mjs`: label/ticks/rip/sha256/blocks — Bochs'
fast-string chunking makes icount host-dependent); where it differs above it is by 15-286 in 1.19e9.

#### The oracle result, on the cold-boot pair the gate actually uses

`REF=build/ref-nowiz OPT=build/tickexact-nowiz ./test/identity.sh both`, i.e. the reference *engine*
(legacy toolchain, interpreter only) vs the AOT engine, full RAM criteria. The reference numbers
reproduce V.9's to the digit (codex ref 2,942,837,561; AOT as shipped 2,945,550,617).

| run | codex | agy |
|---|---|---|
| `NANOBOX_AOT=1`, flag unset | DIFFERENT (ticks 2,945,550,617) | DIFFERENT (3,663,773,199) |
| + `TICKEXACT=3` | DIFFERENT (2,943,662,635) | – |
| + `TICKEXACT=9` | DIFFERENT (2,942,718,149) | – |
| + `TICKEXACT=19` | DIFFERENT (2,917,646,860) | DIFFERENT (3,637,660,355) |
| + `TICKEXACT=23`, and also with the direct RET disabled (`NANOBOX_FLAGS=1615`) | DIFFERENT (2,917,646,860) | – |
| **+ `TICKEXACT=11`** | **IDENTICAL** ticks 2,942,837,561 sha `b880eb9b1be5` | **IDENTICAL** ticks 3,684,200,090 sha `8692e3a71a5b` |
| flag off, `NANOBOX_AOT=0` (control) | IDENTICAL | IDENTICAL |

**Gate, flag ON** (`NANOBOX_AOT=1 NANOBOX_TICKEXACT=11 ./test/gate.sh`, criteria `ram`):
`IDENTITY: identical (codex + agy)`, `BISECT: no divergence`, **rc=0** (`work/prof/tickexact-gate-on.md`).
**Gate, flag OFF**: `IDENTITY: identical (codex + agy)`, `BISECT: no divergence`, rc=0
(`work/prof/tickexact-gate-off.md`). Guest kernels exact in every mask: `fib(10) = 55`,
`fib(2000000) = 17141820111795327685`, `call(200000) = 15034622464419917381`.

The bisect leg is worth stating separately because it is much stronger than a tick count: A = the
interpreter, B = the AOT engine, **939 blocks × 100,000 traces with identical chained state
fingerprints** (all GPRs, RIP, prev_rip, lazy flags, eflags, icount, ticks, async_event hashed after
every trace), both ending at ticks 2,946,719,496. The AOT engine is state-identical to the interpreter
at 93.9 M consecutive trace boundaries.

#### What it costs: everything on the synthetic loops, nothing on the workload

`work/prof/dcall-bench2.sh` (fib.x86 call-free loop, 398 M iterations; call.x86 call+ret, 98 M
iterations), two interleaved rounds, under `work/prof/timelock.sh`:

| TICKEXACT | call-free loop ns/it | call+ret ns/it |
|---|---|---|
| 0 (AOT as shipped) | 0.58 / 0.58 | 12.05 / 12.29 |
| **11 (exact)** | **1.10 / 1.12** | **34.38 / 33.74** |
| 19 (dcall boundary test instead of bit 8) | 1.11 / 1.12 | 14.59 / 14.18 |
| 50 (dynamic loop window) | 0.68 / 0.67 | 14.16 / 14.29 |

(the mask-50 row was taken one edit earlier, before the per-iteration `async_event` test was added
to the dynamic window — it is a lower bound for a variant that is not exact anyway; masks 0/11/19
are code-identical between the two builds.)

`work/prof/bootlat.sh` (codex to the prompt + 20 keystrokes 1.2 s apart), two interleaved rounds, same lock:

| TICKEXACT | boot | session MIPS | keystroke med / med of last half / max | wasm emitted |
|---|---|---|---|---|
| 0 | 6.3 / 6.3 s | 175.5 / 173.2 | 10-11 / 12-13 / 27-51 ms | 15 MB |
| **11** | **6.3 / 6.2 s** | **179.0 / 178.7** | 7-10 / 2-11 / 51-328 ms | 14 / 13 MB |
| 19 | 6.4 / 6.3 s | 174.0 / 173.9 | 11 / 11-12 / 35-362 ms | 15 MB |

**So the honest answer to "what does exactness cost": on a tight loop 1.9x and on a call+ret loop 2.8x;
on the real workload, nothing measurable** — boot is flat, session MIPS moves +2 % (inside the ±4 %
noise floor, and in the *good* direction), and the emitted code is **8 % smaller** with detform 63
(6,153,603 → 5,661,333 bytes for a codex boot: the direct-call sites are large). This is S.9 again —
instruction-level speed is a poor proxy for time on this workload — and it is why the mask is worth
having even though its microbenchmarks look terrible.

#### Three things that did NOT work, and they are the interesting part

* **Keeping direct calls and putting the boundary test at the call site (bit 16) is not exact.** The
  test itself is right (`icount - icount_last_sync >= currCountdown || async_event`, and the predicate
  is invariant under `cpu_loop`'s `currCountdown -= delta; icount_last_sync = now`, so no update is
  needed) and it is cheap — call+ret 12.2 → 14.4 ns, i.e. it keeps 2.4x of the 2.2x direct-call win
  instead of giving it all back. It matches the reference tick for tick on the wizer scenario and it
  is still DIFFERENT on a cold boot, at ticks 2,917,646,860 — *further* from the reference than doing
  nothing. Disabling the direct RET as well (`NANOBOX_FLAGS=1615`) changes nothing, byte for byte, so
  the residual is not the return path. Something else on the direct-call path moves a boundary and I
  did not find it; bit 8 (no direct calls at all) is what closes it.
* **Sizing the self-loop window from the countdown (bit 32) is not exact either.** The idea is sound on
  paper — set the window to `ceil(currCountdown / instructions-per-iteration)` so it always expires at
  or before the iteration the timer is due, keep the 5-instruction countdown on the fast path, and it
  costs only 0.58 → 0.68 ns/iteration instead of 1.10. Adding a per-iteration `async_event` test (the
  one boundary decision that is not a function of the countdown) moved the number but did not close it:
  2,944,719,715 vs 2,946,719,496. Worth another look if the loop cost ever matters — it is 3 % of the
  ticks away and it is the only cheap form of bit 1 I found.
* **The fetch-window check (bit 4) is not a boundary decision.** Masks 11 and 15 give byte-identical
  results. Skipping it can only add or remove an exit to `cpu_loop`, which resumes at the same
  instruction.

#### Localising the divergence, for the record

`harness/bisect.mjs` with A = interpreter and B = AOT on the cold boot, `--ignore-icount`: with bits
1|2 (`--dbg` turns direct calls off by itself, so this is effectively mask 11) the run ends on the
reference's tick count **exactly** (2,942,837,561) and the only fingerprint difference in 190 M traces
is at trace **#86,984,939**: `rbp` = 0 on the interpreter, `7f7e7e7e05607f01` under AOT, with rip,
prev_rip, icount, ticks, lazy flags and every other register identical, in a trace both sides execute
as the same 17 opcodes. That is a *dead* register — AOT's live-only spills (section N) are the obvious
explanation, though I did not prove it — and it does not move the clock or the RAM digest: the same
pair is IDENTICAL under the full RAM oracle. Without bits 1|2 the divergence is a `tk` difference and
arrives far earlier.

#### What this unblocks

`--criteria heap+syscalls` and `heap+syscalls-norm` (V.1, V.9) were built because an AOT engine could
not be compared at all; V.9 measured that even the normalised oracle cannot certify one, because
585/1,246 write payloads legitimately differ (the guest renders elapsed time). With
`NANOBOX_TICKEXACT=11` the tick stream matches, so **all three oracles apply to an AOT engine
unchanged** — and the strongest of them, plain `ram`, is green. Any future AOT-only change can now be
gated the same way every non-AOT flag in this document is. The cost of validating that way is the
mask: 1.9x on a tight loop, unmeasurable on the workload.

Files: `nanobox_jit.cc` (`nanobox_jit_tickexact`, `tickExact()`, `tickWindowDyn()`, the guards in
`emitTransition`/`emitLoopBack`/`emitDirectCall`/`dcallOn`/`dcallSig`/`outlineDcall`,
`nanobox_set_jit_tickexact`), `nanobox_jit.h` (`nanobox_jit_call`'s signature choice), `harness/run.mjs`
(`NANOBOX_TICKEXACT`, applied after `NANOBOX_FLAGS` — bit 8 changes the shared wasm signature, so it
must be set before anything is compiled). Tree `work/j/tickexact`, engines `build/tickexact` +
`build/tickexact-nowiz`. Scripts `work/prof/tickexact-{tick,probe,probe2,probe3,speed,boot,correct}.sh`,
logs `work/prof/tickexact-*.log`, gate reports `work/prof/tickexact-gate-{off,on}.md`.

### V.13 Function count is NOT the mechanism either: 16x more live wasm functions costs nothing, and an entry's *call* is 9 ns of the 400 (2026-08-19, `work/j/density`)

Plan item 13 of `docs/aot-size-and-coverage.md` — the last speed hypothesis left standing after V.2
eliminated byte volume. **It is refuted, by three independent measurements, and the quantity that does
predict the time is the number of ENTRIES (transitions into compiled code), which is not the same thing.**

#### 1. What a transition actually costs on this host V8 (`work/prof/callbench.mjs`, no engine involved)

Hand-built wasm modules, node v24.19.0, 10 M iterations, median of 5, spreads < 1 %. Every variant runs
the SAME per-iteration body and the SAME index arithmetic and differs only in how the body is reached;
the callee signature is the engine's real `nanobox_jitfn_t` (11 params) unless stated. The number in the
last column is the cost of the transition, i.e. the row minus the `inline` baseline (0.38 ns).

| how the body is reached | ns/iter | transition |
|---|---|---|
| inline in the loop (no transition) | 0.38 | — |
| in-function `br_table`, 2 / 4 / 8 / 16 arms | 0.48 / 0.78 / 0.94 / 0.95 | **+0.09 / +0.40 / +0.56 / +0.56** |
| in-function `br_table`, 32 arms | 2.43 | +2.05 |
| direct `call` to a function in the SAME module | 0.38 | **+0.00** (V8 inlines it) |
| direct `call` to an import (another module) | 3.68 | +3.29 |
| `call_indirect` through the table, **1 / 2 / 4** live fns | 3.41 / 3.29 / 3.12 | +3.02 / +2.91 / +2.74 |
| `call_indirect`, **6 / 8 / 16 / 64 / 256** live fns | 9.10 / 9.17 / 9.33 / 9.32 / 9.29 | +8.72 / +8.79 / +8.95 / +8.94 / +8.90 |
| `call_indirect`, **1 k / 4 k / 16 k / 64 k** live fns | 9.29 / 9.31 / 9.38 / 9.36 | **+8.90 / +8.92 / +9.00 / +8.98** |

**The cost of an indirect entry is flat, to within 1 %, from 6 to 65,536 distinct live callees.** It is
also flat in the signature (1 param 8.90, 4 params 9.07, 11 params 8.98, 13 params 9.04 at K ≥ 64) and
in the wasm tier (`--liftoff --no-wasm-tier-up` 8.85, `--no-liftoff` 8.86). The one place function count
shows up at all is the step between 4 and 6 targets: with `--no-wasm-inlining` that step moves to
between 2 and 4, so it is V8's **feedback-driven speculative devirtualisation of an indirect call with
at most 4 recorded targets** — a window a 5,000-function engine is permanently outside. Dispatch
diversity above four targets is free.

Two numbers from that table matter for what to build:
* **an intra-function transition is 15-100x cheaper than a table entry** (0.09-0.56 ns vs 8.9 ns), and
* **a direct call between functions in the SAME module is FREE** — V8 inlines it. Cross-module, the same
  call is +3.3 ns. Today every translation is its own module, so every direct call (S.6) pays that.

#### 2. The engine A/B: `NANOBOX_FNDUP`, default 0 (off)

The content cache hands ONE compiled function to every site whose trace decodes to the same bytes
(5,230 compiles serving 96,314 hits in a codex session). Three knobs, all in one binary, all default off:

* **low 16 bits** = how many sites one compiled function may serve. `1` = no sharing: every site gets its
  own byte-identical copy, so the number of *dispatched* distinct functions ~doubles.
* **bits 16-23** = BALLAST: install each flushed batch module this many EXTRA times. The copies are
  byte-identical and **never called**, so coverage, the executed guest instruction stream and the
  executed wasm are unchanged while the number of *live* functions multiplies by 1 + ballast.
* **bit 24** = DISCARD: pay for the copies (emit + install) and release them again. This is the control
  that removes compilation time as the explanation: same compile cost as the keep arm, same live
  function count as flag-off.

`build/density`, codex to the sign-in prompt + 5 keystrokes, **4 runs per arm, interleaved forward then
reverse in two passes** (`work/prof/dens-matrix.sh`), medians:

| arm | live wasm fns | installed fns | installed MB | V8 compile ms | compiled entries | interp instr | boot | MIPS |
|---|---|---|---|---|---|---|---|---|
| **OFF** (today) | 5,229 | 5,230 | 7.2 | 166 | 5.91 M | 720 M | **5.99 s** | **111.8** |
| **DUP** no sharing | 9,265 | 9,266 | 11.5 | 271 | 8.06 M | 738 M | 6.42 s | 108.1 |
| **DUPDIS** the same copies, released | 4,986 | 9,264 | 11.5 | 269 | 8.06 M | 738 M | 6.29 s | 109.1 |
| **BAL15** 16 installs, 15 uncalled | **83,472** | 83,473 | **113.5** | 383 | 5.91 M | 720 M | 6.21 s | 109.1 |
| **BAL15D** the same 16, 15 released | 5,249 | 83,985 | 114.1 | 358 | 5.93 M | 720 M | 6.11 s | 111.6 |

The two matched pairs are the experiment:

* **BAL15 vs BAL15D — 15.9x the live wasm functions (83,472 vs 5,249) and nothing else different**: the
  same 114 MB emitted, the same 84 k modules compiled and installed by V8, the same 5.9 M entries, the
  same 720 M instructions interpreted. **boot +1.6 %, MIPS −2.2 %** — inside the ±8 %/±4 % floor. **Null.**
* **DUP vs DUPDIS — 1.86x the *dispatched* distinct functions (9,265 vs 4,986)**, identical compile cost,
  identical 8.06 M entries, identical 738 M interpreted. **boot +2.1 %, MIPS −0.9 %.** **Null.**
* BAL15 vs OFF also varies **emitted bytes 15.8x** (7.2 → 113.5 MB) for boot +3.7 %, MIPS −2.4 %, which
  re-confirms V.2's byte-volume null at 15.8x instead of 6.8x.
* The one real gap in the table — DUP/DUPDIS boot 6.3-6.4 s against OFF's 6.0 s — is **compilation**, not
  function count: DUPDIS shows it in full while ending with flag-off's function count.

#### 3. What DOES move with the time: entries, i.e. transitions

Same binary, AOT mode with the function sweep (`NANOBOX_AOT=1 NANOBOX_AOT_DETFORM=63
NANOBOX_AOT_SWEEP=1`), which translates the whole containing function either way, so `--jit-region`
changes **only how many wasm functions the same blocks are packed into** — and with it how many
block-to-block transitions are an intra-function `br` rather than an exit plus a fresh entry.
6 runs per arm, interleaved (`work/prof/dens-region.sh`):

| arm | blocks/function | live fns | MB | compiled entries | interp instr | boot | MIPS |
|---|---|---|---|---|---|---|---|
| `--jit-region 24` | 2.67 | 3,153 | 8.0 | 7.22 M | 169 M | 6.02 s | **113.3** |
| `--jit-region 1` | 1.00 | 4,733 | 5.7 | **8.16 M** | 174 M | 6.09 s | **109.9** |

**+50 % functions, −29 % bytes, +13 % entries → MIPS −3.0 %.** The sign is the opposite of what a
byte-volume story predicts and the function-count arms above are 10-30x larger with no effect, so the
entries are the only quantity that moves with it. R.5/V.8's ~400 ns per entry predicts −2.6 % from
+0.94 M entries on a 14.3 s session; −3.0 % is what was measured. This arm is at the noise edge on its
own (R24 109.9-114.9, R1 107.0-111.7) — it is the corroboration, not the proof; the proof is that the
two much larger function-count multipliers are flat.

#### 4. So where does the ~400 ns of an entry go? Not into the call

A `call_indirect` into a compiled function is **9 ns**. R.5 and V.8 measured a compiled entry costing
**~400 ns** more than interpreting a one-shot trace. **The dispatch mechanism is 2.2 % of the entry
price.** The other ~390 ns is what the translation does at its own boundaries — the prologue that
materialises the entry state, and the epilogue that commits 12 registers + RIP +
icount — which is exactly what section K measured from the other side ("~half is store bookkeeping:
committing 12 registers + RIP + icount at each of 5 boundaries is 70 stores per iteration and costs
1.9x"). **The unit that costs is the boundary, not the function and not the byte.**

That also says what a *cheap* entry would look like, and both halves are measured above: keep the
transition inside one wasm function (0.09-0.56 ns) or, failing that, inside one MODULE where V8 can
inline the direct call (0.00 ns) instead of crossing modules through the table (8.9 ns) — and carry no
state across it.

#### 5. The doc's closing guess, tested: a dense pre-decoded IR in linear memory does NOT reach speed

§4.1 closes with "the shape that reaches both size and speed is a dense pre-decoded IR in linear
memory". Measured directly: an opcode byte read from linear memory and dispatched through an
in-function `br_table` whose arms do the same work as the inline baseline costs
**+4.79 ns (16 opcodes), +5.18 (64), +5.25 (128), +5.25 (200)** per instruction, and +5.16 even when the
opcode stream is perfectly cyclic. The engine's whole per-guest-instruction budget at 112 MIPS is
**8.9 ns**, so such an IR spends **~60 % of it on dispatch before doing any work** — the same failure
mode as tier 0 (V.2: 43 ns/iteration, 25 % slower than not compiling at all), merely 8x cheaper because
the dispatch stays inside one function. It reaches SIZE, as tier 0 does. **It does not reach speed, and
the premise should be struck from the doc.** Where the constraint is bytes, tier 0 already exists.

#### 6. What could not be held constant (honestly)

* **DUP** refuses the decode-time cache hand-out too, so more traces fall through to the hotness
  threshold: interpreted instructions 720 → 738 M (+2.5 %) and compiled entries 5.91 → 8.06 M (+36 %).
  That is precisely why DUP is compared against **DUPDIS**, which has the same 738 M and the same
  8.06 M — the pair is matched on everything except how many functions stay live.
* **BALLAST** raises emitted bytes with function count (both 16x) against OFF. Within the BAL15/BAL15D
  pair the bytes emitted and compiled are equal (114 MB both) and only residency differs, so bytes are
  held there; against OFF they are not, and that comparison is reported as a bytes result, not a
  function-count one.
* In the **region** arm bytes fall while functions rise, so those two are anti-correlated; entries are
  the only quantity whose sign matches the effect.
* Session `icount` wanders ±3 % run to run (the guest does clock-dependent work); it is uncorrelated
  with the arm. Three other agents were building and gating on the same 8 cores throughout, which is
  what the interleaving and `work/prof/timelock.sh` are for.
* Everything here is the **shipped trace JIT's** function granularity. Section K's 9x came from a
  translation shape this engine cannot emit (a 41-instruction, 12-block region as one function with
  registers in locals across it); nothing measured here contradicts K, and §4 says why: K's win is
  boundaries removed, not functions merged.

#### 7. Gates and files

`build/density` (from `work/j/density/bochs`, forked from `bochs/` at 14:11 today, i.e. **before**
V.11's clearfix landed in the main tree). Both legs are the **RAM oracle** — ticks + SHA-256 of all
guest RAM, the stronger criterion, which applies because the flag cannot change a tick:

* **flag OFF** (`work/prof/dens-gate-off.md`): `IDENTITY: identical (codex + agy)`,
  `BISECT: no divergence`, rc=0.
* **flag ON** (`NANOBOX_FNDUP=196609` = ballast 3 + no sharing, `work/prof/dens-gate-on.md`):
  `IDENTITY: identical (codex + agy)`, `BISECT: no divergence`, rc=0.
* Guest exact in all three arms (`work/prof/dens-correct.sh`): `fib(10) = 55`,
  `fib(2000000) = 17141820111795327685`, `call(200000) = 15034622464419917381`, off / no-sharing /
  no-sharing+discard alike.

Files: `work/j/density/bochs/bochs/nanobox_jit.cc` (`nanobox_jit_fndup`, `nanobox_set_jit_fndup`,
`nanobox_jit_fndup_stat`, `nb_fndup_refuse`, `JitCacheEntry::reuse`, `Pending::dup`, the ballast and
discard arms in `nanobox_jit_batch_flush`); `harness/run.mjs` (two additive lines: `NANOBOX_FNDUP`,
`summary.fndup`). Scripts: `work/prof/callbench.mjs`, `callbench-sweep.sh`, `dens-run.sh`,
`dens-matrix.sh`, `dens-region.sh`, `dens-correct.sh`, `dens-agg.mjs`; raw runs in
`work/prof/dens-data/`. Nothing is committed.

#### 8. What this leaves open

Byte volume (V.2, and 15.8x here) and the number of distinct compiled functions (16x here) are both
eliminated. What is left is the **per-boundary state materialisation** — the prologue/epilogue an entry
pays, ~390 ns of the ~400. The levers that follow from §1 and §4, in the order the measurements support
them: (a) fewer boundaries, i.e. genuinely coarser regions — note `--jit-region 24` never binds
(`regionStats[13] = 0`, mean 2.67 blocks), so the cap is not what limits region size and raising it buys
nothing; the limiters are the successor rules (function bounds, dedupe, the claim mark, self-loops).
(b) Cheaper boundaries: carry less state across them. (c) Pack translations into FEWER modules so a
direct call between them is inlined by V8 rather than crossing a module boundary — 8.9 ns → 0.

### V.14 The bundle recordings have been truncated since ~03:05: the eager sweep stalls the boot (2026-08-19)

Found while refreshing what the browser sandbox serves after the day's merges. `test/record-bundles.sh`
sets `NANOBOX_JIT_EAGER=1` (compile every trace reachable in a page once one trace in it is hot) so a
bundle covers whole pages. That sweep now **stalls the guest boot**:

| `--cmd /bin/true`, `build/eh-nb` | wall | guest bytes read |
|---|---|---|
| `--jit 2:500`, no eager | **1.44 s, rc=0** | 1,829,112 |
| `--jit 2:2000` + `NANOBOX_JIT_EAGER=1` | **timeout at 20 s** | 3,512 |
| `--jit 2:500` + `NANOBOX_JIT_EAGER=1` | timeout at 40 s | 0 |

The guest never reaches `/bin/true`. It is NOT one of today's merges: it reproduces identically on
`build/{probe,ops,tier,stacktag,faultarm,clearbug,tickexact}` and on the merged engine -- i.e. back to
03:05, the oldest build still on disk. The last known-good recording (`work/prof/record-flags.log`,
an engine since deleted) did the same kernel run in **1.3 s producing 215 modules / 9.41 MB**.

**Consequence: every bundle recorded since has been a partial written at the timeout**, which is why
`kernel.nbjb` had been 1.85 MB / 119 modules. Recording with the sweep OFF is both fast and MORE
complete than the truncated eager runs: kernel **206 modules / 3.33 MB**, codex 785 / 5.31 MB, agy
1,030 / 8.84 MB, claude 2,181 / 26.88 MB, all four in ~90 s. Those are now what the server serves, and
`test/e2e-split-shell.mjs` passes on them.

`EAGER=0` is now honoured by `test/record-bundles.sh`. Two mechanical notes: the harness tested
`process.env.NANOBOX_JIT_EAGER` for truthiness, so `NANOBOX_JIT_EAGER=0` turned the sweep ON (`"0"` is a
non-empty string) -- fixed, and it is what made the first eager-free attempt look like another stall.
And `pkill -f "[r]ecord-bundles.sh"` killed my own shell, again.

Open: why the sweep stalls. It is the recording path only -- nothing shipped runs with it -- so it does
not affect the engine or the gate, but until it is fixed the bundles are smaller than they should be.

### V.15 The eager sweep stall, root-caused and fixed: the sweep fed the region former the CPU's RIP as a foreign entry's linear address (2026-08-19, `work/j/eagerfix`)

**Merged into `bochs/bochs` on 2026-08-19 (no flag -- the sweep is off unless `NANOBOX_JIT_EAGER=1`).**
On the merged engine, `--cmd /bin/true --jit 2:500`, all four configurations now boot in ~1.5 s with
**the same icount, 629,591,848**: default, `NANOBOX_JIT_EAGER=1`, `NANOBOX_STACKTAG=0`, and
`NANOBOX_JITCLEARFIX=0 NANOBOX_JITCACHE_LIMIT=3000`. `EAGER=1 ./test/record-bundles.sh all` completes:
kernel 207 modules / 3.88 MB, codex 776 / 6.05, agy 1,026 / 10.83, claude 2,206 / 31.38. Module counts
are back to their historical values; the byte column is smaller than Aug 18 because of the day's
density work, not missing coverage. Gate: `IDENTITY: identical (codex + agy)`, `BISECT: no divergence`.
AOT tick-exactness re-checked on the same binary: `RESULT: IDENTICAL`. Served engine and bundles
refreshed; `test/e2e-split-shell.mjs` passes.

Two things this hands forward: `gate.sh`'s identity leg takes **`IOPT`**, not `OPT` -- with only `OPT`
set it silently gates `build/eh-nowiz`, and `identity.sh` has no timeout, so a bad engine hangs it
forever. And the sweep still calls `serveICacheMiss()` raw, so a sweep that exhausts the iCache
instruction pool would flush entries underneath `cpu_loop` -- the hazard `nanobox_decode_ahead()`
documents and refuses. It did not fire in any run; left as a known latent, not fixed blind.

Fix for V.14. One line in `nanobox_eager_sweep()`; the sweep is off unless `NANOBOX_JIT_EAGER=1`, so this
is a pure bug fix in the recording path and needs no flag -- with the sweep off the engine is unchanged.

**Root cause.** The sweep compiled each swept entry through `nanobox_jit_maybe_compile_inner(se)`, which
derives the entry's linear address as `RIP - se->i[0].ilen()`. That is only correct for the ONE trace
cpu_loop is executing; every other entry in the page got the *current RIP* as its linear base. Until
2026-08-18 ~18:00 that was harmless, because `nanobox_form_region(e)` resolved successors physically --
`pageOff = (e->pAddr & 0xfff) + roff`, correct for any entry (see the snapshot
`work/prof/preflags-nanobox_jit.cc:3318`, Aug 18 18:02, which still has that form; the last good
recording is `work/prof/record-flags.log`, Aug 18 18:03). The function-rooted former that landed after
it takes `entryLin` and resolves successors *linearly*:

    bx_address lin = entryLin + (bx_address) roff;                       // nanobox_jit.cc ~5500
    ...
    bx_phy_address pa = ((bx_phy_address) r->ppf[p] << 12) + (bx_phy_address)(lin & 0xfff);

With a bogus `entryLin`, `lin & 0xfff` is the wrong offset, so every block after the first was copied
out of the iCache **from the wrong address in the page** (and a base whose low bits pushed `lin` over a
page boundary added a second page with a wrong frame). The region -- built from code that was never at
those addresses -- was then attached to the swept entry and executed. Result: the boot went off the
rails in early kernel code and never came back.

**Evidence, in this order.**
1. The stalled guest is not blocked, it is *spinning*: `--jit 2:500` + eager on `build/eh-nb`, harness
   `--timeout 15`, gives `icount 4,754,874,280` (7.5x the whole successful boot's 629 M) with
   `loopbacks 34,483,898` against 300,559, and `fs opens/reads/readBytes 0`.
2. `--pages` + `--focus` localise it exactly: **2.97e9 of 3.89e9 instructions on one kernel page**,
   `0xffffffff8101d000` (tsc.c: `sched_clock` / `read_tsc` / `pit_hpet_ptimer_calibrate_cpu`), 542,754
   entries to the trace at `sched_clock+0xc`, ~5,500 instructions per entry. The same page takes 49,543
   instructions in the healthy run.
3. Decisive: **`NANOBOX_JIT_EAGER=1 --jit-region 1` (regions off) boots in 1.06 s and reproduces the
   non-eager `icount` exactly, 629,527,470** -- the sweep is guest-invisible without regions. With
   `--jit-region 2` it stalls again. So the fault is in region formation for swept entries, not in the
   sweep's decode, the content cache, the attach registry or the bundle writer (all four were on the
   suspect list; all four are innocent). `NANOBOX_JITCLEARFIX` / `NANOBOX_STACKTAG` were already ruled
   out by `work/prof/eagerbisect.sh`.

**The change** (`work/j/eagerfix/bochs/bochs/nanobox_jit.cc`, `nanobox_eager_sweep`): the sweep already
computes `pageLin`, the linear base of the page it is sweeping, so it can hand over the right address:

    -    if (!se->jitfn) { nanobox_jit_maybe_compile_inner(se); ... }
    +    if (!se->jitfn) { nanobox_jit_maybe_compile_at(se, pageLin + off, NULL); ... }

**After (`build/eagerfix`, `--cmd /bin/true`, `--jit 2:500`):**

| | wall | rc | icount | guest bytes read |
|---|---|---|---|---|
| no eager | 1.06 s | 0 | 629,578,221 | 1,829,112 |
| `NANOBOX_JIT_EAGER=1` | 1.11 s | 0 | **629,578,221** (identical) | 1,829,112 |

`ticks` match too. `EAGER=1 ./test/record-bundles.sh all` now completes -- all four images in **46 s**:

| bundle | eager-free (V.14, the floor to beat) | eager, fixed | Aug-18 18:03, last good |
|---|---|---|---|
| kernel | 206 mod / 3.33 MB | **208 / 3.89 MB** | 215 / 9.41 MB |
| codex  | 785 / 5.31 MB | **781 / 6.01 MB** | 802 / 14.77 MB |
| agy    | 1,030 / 8.84 MB | **1,062 / 11.17 MB** | 1,071 / 26.05 MB |
| claude | 2,181 / 26.88 MB | **2,343 / 32.07 MB** | 2,237 / 77.49 MB |

Module counts are back to the historical figures; the byte column is 2.4-3.1x smaller than August 18
because of the day's density work (T.1 outlining -43 %, U.6 -29 %), not because of missing coverage.
The claude leg reads the same 303,826,755 guest bytes as the Aug-16 good recording, i.e. it reaches the
same point.

**Gate** (`OPT=build/eagerfix/out.wasm IOPT=build/eagerfix-nowiz/out.wasm`; note the identity leg takes
`IOPT`, not `OPT` -- with only `OPT` set it silently gates `build/eh-nowiz` instead, which cost me one
run): sweep OFF `IDENTITY: identical (codex + agy)`, `BISECT: no divergence`. And, new, sweep **ON**:
`IDENTITY: identical (codex + agy)` -- the recording knob no longer perturbs the guest at all, which was
not true before (V.14's stall was a guest-visible corruption, not a slow sweep).

**Negative result: the sweep buys almost nothing.** Now that it works it can finally be measured, and
the premise behind B5 does not hold up:
* replaying the run it was recorded from, the *eager-free* codex bundle serves `bundleHits 3632 /
  misses 0`; the eager one `3612 / 32`. Speculative page coverage is slightly WORSE on its own workload,
  because a region's content key depends on which neighbours the iCache holds, and pre-compiling
  neighbours changes which regions form at replay time;
* cross-workload, which is what the sweep is for -- booting agy against the kernel bundle alone --
  eager gives `hits 1234 / misses 5832 / 3,785 runtime installs` against `1219 / 5858 / 3,801`. **+1.2 %
  hits** for +17 % bundle bytes.
So the sweep is now correct and free (kernel 1.11 s vs 1.09 s), but `EAGER=0` remains a perfectly good
recording policy; nobody should expect coverage wins from turning it on.

**Latent, not triggered, worth knowing:** the sweep still calls `serveICacheMiss()` raw, so a sweep that
exhausts the iCache instruction pool will `flushICacheEntries()` underneath cpu_loop -- exactly the
hazard `nanobox_decode_ahead()` documents and refuses (`nb_protect_entry`, mpool headroom check). It did
not fire in any run here (the kernel recording is icount/tick-identical to its non-eager counterpart
and the sweep-on gate is RAM-identical on codex and agy), so it
is left alone rather than fixed blind; if a future eager recording goes strange, that is the first place
to look.

### V.16 A whole-file copy silently reverted two merges (2026-08-19)

Recording this because the failure is invisible and I nearly shipped it. The five engine changes today
were merged by copying `work/j/<name>/bochs/bochs/nanobox_jit.cc` over `bochs/bochs/nanobox_jit.cc`.
That is only safe when the variant tree was forked from the CURRENT main. `eagerfix` was forked before
`faultarm` and `clearbug` landed, so copying its file **reverted both** -- including V.11's crash fix --
while the build stayed green and the gate stayed green, because both reverted features are default-off
or invisible to the gate.

It was caught by a feature census (`grep -c nanobox_jit_<flag>`) after the copy, not by any test. The
tree was reassembled by re-deriving `faultarm` as a diff against its own base and re-running
`work/prof/clearbug-fix.py`; one hunk of the faultarm diff conflicted with `tickexact`'s rewrite of
`emitLoopBack` and was re-applied by hand after checking the two forms are identical when the flag is
off (`pushVA(0)` is `L_base + boff`; `pushExitRip((Bit64s) boff)` with `faRipOffset()` false is
`pushRegionVA(boff)` = `L_base + boff`).

**Rules that follow.** Never merge a variant by copying a whole file -- take `diff` against the tree's
own base and apply it. After ANY merge, census every flag the tree is supposed to have
(`for f in stacktag faultarm clearfix tickexact eager; do grep -c ...`) and check every default line,
because a silent revert of a default-off feature passes every gate we have.


### V.17 `NANOBOX_COLDOUT`: the packed exit descriptor pays (2026-08-20, `work/j/coldout`)

**Merged into `bochs/bochs` on 2026-08-21, default 0 (NOT enabled), and here is the measurement that
decided it.** The flag is generic: `work/prof/mg-0.txt` vs `mg-3.txt` shows **14 of 14 opcodes change,
none unchanged** -- `JMP_Jbq` -13.1 B/site, `CALL_Jq` -8.8, `PUSH_Eq`/`POP_Eq` -7.5, `MOV_GqEq` -7.4,
`MOVUPS_*` -6.2, `RET_Op64` -3.8, `JZ_Jbq` -3.4; total 112.7 -> 110.6 B/instruction.

Per-opcode-class microbenchmark on the merged binary (`work/prof/opbench.sh`, one binary, three passes):

| shape | off | off (replicate) | **on** |
|---|---|---|---|
| register | 2.89 | 2.93 | **2.96 ns/it** |
| load | 3.00 | 3.04 | **3.07** |
| store | 6.80 | 6.85 | **6.90** |
| call+ret | 34.06 | 34.17 | **35.31 (+3.4 %)** |

The two off-replicates bracket within 0.4 % and the on-arm sits outside that bracket on **all four**
shapes. Individually each is inside the +-4 % band; four independent shapes agreeing in sign is not.

**Why it loses, quantified.** The packed descriptor removes four instructions from each exit SITE and
adds an unpack in the shared tail that runs on every exit TAKEN. Codex boot, level 3
(`work/prof/l3-jit.log`): **3,847 exit sites emitted against 66,449,257 link hops executed** -- a
17,000:1 ratio against the trade. For scale, the slow arm runs 151,838 times, 0.2 % of the exit path.
This is the general shape of every emit-time-for-run-time trade in this engine and is worth
remembering before proposing another.

Reverted default, rebuilt, re-verified: bisect `no divergence` (111 blocks x 100,000 traces),
`./test/identity.sh codex` and `agy` both **`RESULT: IDENTICAL`** against the cold-boot reference pair.

**The latency instrument had a defect, found before the grant was spent.** `work/prof/keylat.sh`
originally cycled the keys `a`..`z`. That cycle contains `q`, **which quits codex**: a 60-key run
delivered only 20 keys, and the io log shows the terminal leaving raw mode
(`\e[?2004l \e[?1004l ... \e[J`) 2,483 ms after the prompt -- exactly where key 16 = `q` lands --
after which the remaining keys echo against the shell. A 600-key run would have died the same way and
produced a distribution over the first 3 % of its samples. Fixed by injecting one inert character
(`KEYCHAR`, default `x`); the same 60-key run now delivers **60 of 60**. `KEYS` sets the sample count
so the instrument can be smoke-tested inside the 30 s cap.

**60-sample preliminary (NOT the deliverable, which is 600):**

| mask | delivery p50/p90/p99/max | echo p50/p90/p99/max | keys over 100 ms |
|---|---|---|---|
| 0 | 0 / 1 / 2 / 2 ms | 8 / 11 / 13 / 13 ms | 0 |
| 3 | 0 / 1 / 2 / 2 ms | 8 / 11 / 11 / 11 ms | 0 |

Indistinguishable, as a -1.9 % byte change should be. The 600-sample run at 0.1 s needs ~66 s of wall
time by construction and is blocked on a watchdog grant for `work/prof/keylat.sh`.

**Speed legs, run after the fact (they fit the 30 s cap; the keystroke distribution does not and is
blocked on a grant).** All on `build/coldout/out.wasm`, one binary, interleaved A,B,A,B.

| measurement | mask 0 | mask 3 |
|---|---|---|
| hot loop `fib`, 398 M it | 2.14 / 2.13 ns/it | 2.12 / 2.12 ns/it |
| hot loop `call`, 98 M it | 29.63 / 29.44 ns/it | 30.03 / 29.72 ns/it |
| boot to `/bin/true` | 1433 / 1415 ms | 1418 / 1409 ms |
| guest icount | 629,798,598 | **629,798,598** (identical) |
| installed wasm | 3,289,094 B | **3,238,406 B (-1.5 %)** |

Every difference is inside the +-4 % noise band; `call` is 1 % the wrong way, `fib` 1 % the right way.
The identical icount across masks is the useful part: the flag changes emission only.

**Full per-phase table, final pass, `/bin/true` boot (`work/prof/co-m{0,3}.txt`).** Columns: other,
spill-fault, slow-arm, exit, async-check, access, handler-step.

| opcode | mask 0 B/site | phases | mask 3 B/site | phases |
|---|---|---|---|---|
| `CALL_Jq` | 190.1 | 59.5 / 31.9 / 16.2 / 16.0 / 0.0 / 16.0 / 14.2 | **181.2** | 64.0 / 31.9 / 15.0 / 0.0 / 16.0 / 14.0 / 4.0 |
| `RET_Op64` | 175.4 | 42.2 / 39.4 / 14.2 / 16.0 / 0.0 / 14.0 / 14.3 | **171.6** | 42.1 / 39.4 / 12.9 / 0.0 / 14.0 / 13.9 / 14.0 |
| `MOV_GqEq` | 145.2 | 10.2 / 16.4 / 14.3 / 8.0 / 15.1 / 10.0 / 0.0 | **137.8** | 10.2 / 16.4 / 13.0 / 15.0 / 10.0 / 0.0 / 2.0 |
| `PUSH_Eq` | 129.7 | 21.1 / 15.0 / 16.4 / 8.0 / 15.1 / 16.2 / 0.0 | **122.3** | 21.1 / 15.0 / 14.9 / 15.1 / 16.2 / 0.0 / 2.0 |
| `POP_Eq` | 123.2 | 22.9 / 17.9 / 14.1 / 8.0 / 15.1 / 13.9 / 0.4 | **115.7** | 22.9 / 17.9 / 12.7 / 15.0 / 13.9 / 0.4 / 2.0 |
| `MOV_EqGq` | 69.4 | 7.3 / 9.4 / 6.8 / 3.3 / 6.3 / 5.0 / 0.0 | **66.2** | 7.3 / 9.4 / 6.2 / 6.3 / 5.0 / 0.0 / 0.8 |
| `MOVUPS_VpsWps` | 176.1 | 72.5 / 0.0 / 0.0 / 8.0 / 15.4 / 0.0 / 0.0 | **169.9** | 72.5 / 0.0 / 0.0 / 15.2 / 0.0 / 0.0 / 2.0 |
| **all** | **112.6** | | **110.5 (-1.9 %)** | |

**The verdict on the premise.** "Move everything off the fast path into called functions" was estimated
at a 43.1 % upper bound and delivers **1.9 %**. The gap is entirely the assumption that call sites are
free: the arms were already calls before this work, and the bytes charged to them are the ARGUMENT
SETUP, which is the live state the arm needs to reconstruct the instruction. What bit 0 removed was not
an arm, it was a per-site exit descriptor -- two constants -- and that is why the `exit` column falls
8.0 -> 2.0 on the load and 16.0 -> 4.0 on `CALL_Jq` while nothing else moves.

**Not merged, not committed.** New flag word `NANOBOX_COLDOUT=<mask>` (its own env, as
`NANOBOX_FAULTARM` and `NANOBOX_STACKTAG` are), **default 0, and mask 0 reproduces today's
emission**: every emitter change is behind `coPack()` / `coMergeArgs()`, and the four gate legs below
run green with the flag off.

Method note: the numbers here are the 1.7 s `/bin/true` phase-matrix run (`--jit 2:500`,
`build/coldout`), not the codex session of V.10, so the absolute B/instruction (112.6) is not
comparable to V.10's 112.3 by accident -- it is a different workload with a different opcode mix.
Compare within the table only.

#### The bits

* **bit 0 -- the packed exit descriptor.** A constant-RIP exit hands the common tail its RIP offset
  and its icount delta in ONE i32 constant (`i32.const (roff<<6)|(k+1); local.set L_pk`) instead of
  `local.get L_base; i64.const roff; i64.add; local.set T7; i64.const k+1; local.set L_xic`. The tail
  unpacks with a shift and a mask, and `select`s against T[7]/L_xic only when a run-time-RIP exit
  (indirect JMP/CALL, RET) also reached it. This is the half of V.10's item 5 that was left on the
  table ("needs `L_xic` to be a compile-time constant, and it rewrites the shared tail's contract").
  It does rewrite the contract; the contract change is 20 bytes of `select` once per function.
  `exitToOffset` was moved onto it too: a direct branch's target is a compile-time offset even though
  the emitter had already materialised it into a local, so JZ/JNZ/JMP/CALL exits were paying the
  run-time-RIP path for no reason.
* **bit 1 -- one packed constant for the merged cold arms.** `coldArgs` pushed `L_base`, the icount
  base, `coldP1` (the RIP end offset) and `coldP2` (ilen | k | seg | size | kind); bit 1 sends
  `p1<<17 | p2` as one i32 and calls the `_p` flavour of `nanobox_slow_rd/wr` /
  `nanobox_helper_step_all`, which unpack it.

#### Sizes (B per compiled guest instruction, final pass; identical icount on every arm)

| mask | what | B/instr | vs mask 0 |
|---|---|---|---|
| 0 | today's engine | **112.6** | — |
| 1 | packed exit descriptor | **111.2** | **-1.2 %** |
| 2 | packed cold-arm constant | 112.0 | -0.5 % |
| **3** | **both (recommended)** | **110.5** | **-1.9 %** |

Per opcode, mask 0 -> mask 3 (a selection of the phase columns; they sum to B/site):

| opcode | inst | B/site 0 | B/site 3 | spill-fault | slow-arm | exit | async-check |
|---|---|---|---|---|---|---|---|
| `MOV_GqEq` | 2655 | 145.2 | **137.8 (-5.1 %)** | 16.4 | 14.3 -> 13.0 | **8.0 -> 2.0** | 15.1 -> 15.0 |
| `MOV_EqGq` | 4022 | 69.4 | **66.2 (-4.6 %)** | 9.4 | 6.8 -> 6.2 | **3.3 -> 0.8** | 6.3 |
| `PUSH_Eq` | 792 | 129.7 | **122.3 (-5.7 %)** | 15.0 | 16.4 -> 14.9 | **8.0 -> 2.0** | 15.1 |
| `POP_Eq` | 966 | 123.2 | **115.7 (-6.1 %)** | 17.9 | 14.1 -> 12.7 | **8.0 -> 2.0** | 15.1 |
| `CALL_Jq` | 1333 | 190.1 | **181.2 (-4.7 %)** | 31.9 | 16.2 -> 15.0 | **16.0 -> 4.0** | 0 |
| `RET_Op64` | 576 | 175.4 | **171.6 (-2.2 %)** | 39.4 | 14.2 -> 12.9 | 16.0 -> 14.0 | 0 |
| `JZ_Jbq` | 1230 | 79.0 | **75.6 (-4.3 %)** | 16.4 | 0 | **8.1 -> 2.0** | 0 |

`exit` is 8.7 % -> 5.4 % of all emitted bytes; the `common-tail` grows 2.9 % -> 4.6 % because nearly
every function also has a run-time-RIP exit (a RET), so the tail keeps its `select`. `RET_Op64` gains
least for exactly that reason -- its own exit is the unpacked one.

#### Method worth reusing: the cold boot diverges where the wizer build does not

Every emission defect found in this section was found the same way, and it is cheap: a **cold boot**
(`build/coldout-nowiz`, `--cmd /bin/true`, ~7 s a side) diverges on icount where the wizer build does
not -- 629,323,672 vs 619,150,441 -- so an emission defect a wizer run cannot see shows up as a single
number in one run. One run, one number, no bisect.

#### Not built, with the arithmetic that says why

* **item 3 (sink the async check by duplicating the commit into the cold arm)**: not built. The
  commit is not the template's to duplicate -- `emitRead` returns a value on the wasm stack and each
  of ~40 template call sites commits it differently (`regSetFromStack`, `regSet32FromStack`, an SSE
  lane store, a flags update, a stack-run's N stores). Duplicating it means giving every one of them
  a re-entrant commit callback. The prize is bounded by `async-check` = 4.6 % of bytes.
* **item 4 (a shared async-exit chain per block)**: measured as arithmetic and rejected. A chain
  position per site RELOCATES the per-site descriptor, it does not remove it -- the RIP offset and
  the icount delta differ per site, so each position needs its own constants and its own `br`. Bit 0
  is the form that actually removes them (23 B -> 17 B at an async site), which is why it exists.
* **a linear-memory table of cold-arm descriptors** (the coordinator's original item 2): capped at
  1-2 B/arm by LEB, not by the table. The two constants already encode to 5-6 bytes, and an index
  that distinguishes N sites needs ceil(log2(N)/7) LEB bytes -- 3 bytes at 20k distinct descriptors.
  Bit 1 gets the same 1-2 B with no allocator, no lifetime and no growth.

#### Gates

* flag OFF: `IDENTITY: identical (codex + agy)`, `BISECT: no divergence`.
* **`NANOBOX_COLDOUT=3` (recommended): `IDENTITY: identical (codex + agy)`, `BISECT: no divergence`.**

#### Open: the keystroke-latency distribution

The success metric changed to the p50/p90/p99/max of 600 keystrokes at 100 ms. That run is ~90 s and
does not fit the 30 s watchdog, so it has NOT been run. `work/prof/co-keylat.sh <tag> <mask>` and
`work/prof/co-keylat.mjs` are in the tree ready for it (600 `--after-expect` injections, `--io-log`,
per-key `delivery` and `echo` percentiles). It needs a grant for that exact command.

Files: `nanobox_jit.cc` (`nanobox_coldout` + `nanobox_set_jit_coldout`, `exitAt`/`exitTail`/`L_pk`,
`coldArgs` returning "merged", `nanobox_slow_rd_p`/`_wr_p`/`nanobox_helper_step_all_p`),
`harness/run.mjs` (`NANOBOX_COLDOUT` env + `--coldout` flag, so bisect can
put the two masks on the two sides). Tree `work/j/coldout/bochs`, builds `build/coldout{,-nowiz}`.

### V.19 A per-opcode execution census: where each opcode's accesses, slow arms and exits actually go (2026-08-20, `work/j/opcensus`)

Instrumentation, not an optimisation. Before this the engine could say *how much* of a boot goes down
each slow path (address resolution, `nanobox_stats.slow`, 66 M link hops) but never *which opcode*
pays for it, so a slow-path share could not be attributed to `MOV_GqEq` rather than `PUSH_Eq` — and
the user's hypothesis ("sites that walk structures behave differently from sites that do not") had no
data to be tested against.

**Mechanism — no packed constant had to be widened.** Every one of those counters is emitted, or
called, from a site whose guest opcode is *already* known at emit time: `nanobox_ph_ia`, the opcode
the phase accounting attributes bytes to (V.10). So the per-opcode half is the same emitted
increment `profCount()` already emits, with the counter ADDRESS pointing at the per-opcode slot
instead of the global one. One new member (`profCountOp(slot)`), 20 call sites, no new helper
parameter, no wider `p1|p2`. Level 3 only, because `profCount()` is already gated on
`nanobox_jit_level >= 3`.

Counted per opcode, into `nanobox_op_census[BX_IA_LAST + 1][8]`
(`nanobox_jit_opcensus(ia, slot)`; `[BX_IA_LAST]` = emitted outside any guest instruction):

| slot | what | where it is emitted |
| --- | --- | --- |
| `dtlb` | accesses that resolve their address against the guest DTLB | `tlbProbe` |
| `stk` / `stkmiss` | stack-window accesses / refills (`NANOBOX_STACKTAG`, V.6) | `stackWindow()` |
| `slow` | slow-arm executions | `profSlow()` + the four merged cold arms (`mergeSlow`), whose global count is inside `nanobox_slow_rd/wr` |
| `exit` | exits through the exit chain / common tail | `exitTail()` + the two `bodyDepth < 0` inline-commit returns |
| `trans` | in-region block transitions | `emitTransition()`, beside `jit_intrans` |

Counts are taken directly (an increment in the fast path, exactly as the global counters already do
at level 3) — the derive-from-`opstat(ia,3)` fallback the task allowed was not needed. The stack
window counts every access and every refill, and hits are the difference.

Reported by `harness/run.mjs` next to the existing per-opcode table (a 40-row table, ranked by
absolute slow-path executions), plus `--op-census <file>` for the full CSV. The block is guarded on
the export, so older engines simply skip it.

**PUSH/POP/CALL/RET run on the stack window, and the window is near-perfect.** With
`NANOBOX_STACKTAG` on (V.6) they are pure stack-window sites:

| opcode | executed | DTLB accesses | stack-window | refills | refill % |
| --- | ---: | ---: | ---: | ---: | ---: |
| `PUSH_Eq` | 24,548,258 | 250,092 (the multi-push run form) | 24,548,258 | 31,413 | 0.13 % |
| `POP_Eq` | 24,520,022 | 0 | 24,520,022 | 30,637 | 0.12 % |
| `CALL_Jq` | 12,480,046 | 0 | 12,480,046 | 23,957 | 0.19 % |
| `RET_Op64` | 15,949,944 | 0 | 15,949,944 | 3,827 | 0.02 % |
| `LEA_GqM` | 12,691,002 | 0 (computes an address, never touches memory) | 0 | 0 | — |

So the answer to "which opcodes would be better off without a fast path" is **not** the stack ones:
their fast path is a 5-instruction window compare that hits 99.87 % of the time. V.6 gave them a
window of their own, and this census is what proves the move was complete.

**43 % of all exits are one CALL and one RET.** `CALL_Jq` (12,480,046) and `RET_Op64` (15,949,944)
exit on **every single execution** — 28.4 M of the 65.8 M exits. The conditional branches are the
rest (`JZ_Jbq` 9.8 M, `JNZ_Jbq` 8.0 M, ...), and they exit roughly half the time (`JZ_Jbq`: 9.8 M
exits on 22.5 M executions). Direct calls (`nanobox_jit_flags` bit 9) are AOT-only, so in the
shipping engine a guest call/return pair costs two full exit epilogues plus two link lookups.
Per-opcode this is the single largest concentrated exit cost in the boot.

**Verification that the instrumentation does not perturb what it measures.**
* Level 2 emits **nothing** new: every added statement is inside `profCountOp()`, whose body is
  `if (nanobox_jit_level >= 3)`.
* Empirically, compiled functions were compared **per function key** across three builds (`eh-nb`,
  a control build carrying the census array and exports but none of the 20 call sites, and
  `opcensus`) by decoding both `--jit-bundle-out` bundles and extracting each exported function's
  code-section body. **Zero length mismatches** in every pair: 741/741 (ctl vs census), 663/663
  (eh-nb vs census), 667/667 (eh-nb vs ctl). The residual 0.2–0.5 % of differing bytes are LEB
  immediates of *runtime* addresses that move whenever the binary's data layout moves — the eh-nb
  vs control pair, which contains no emission change at all, shows the same 0.196 %. Comparing whole
  MODULES is meaningless here: modules are batches whose composition varies run to run
  (`work/j/opcensus` scratch: `cmp3.mjs`).
* `--tpl-bytes` at level 2 is unchanged per template (`MOV_GqEq` 121 B/instance, `CALL_Jq` 179 B in
  both builds); the aggregate differs only because a boot compiles a slightly different instance mix.
* Bisect on the census build: `no divergence` at **both** levels — 111 blocks x 100,000 traces of
  identical chained state hashes at `--jit 2:200` and at `--jit 3:200`.
* Caveat on wizer builds: a rebuilt engine's pre-init snapshot lands at a different icount
  (563,296,677 vs 563,319,414), so a raw icount comparison against `eh-nb` is meaningless — the
  known artifact, use the `--no-wizer` cold-boot pair for identity.

**What level 3 costs.** Codex boot to the sign-in prompt, interleaved A,B,A,B, same engine:

| engine | level 2 | level 3 | level 3 penalty |
| --- | ---: | ---: | ---: |
| `eh-nb` (no census) | 6,300 ms | 6,592 ms (4 runs) | +4.6 % |
| `opcensus` (census) | 6,223 ms | 6,781 ms (4 runs) | +9.0 % |

So the census adds **+2.9 %** on top of level 3's existing +4.6 %, and level 3 as a whole is
**+9 %** slower than the shipping level 2 — roughly the ±8 % boot noise band, which is why the
census is a level-3-only diagnostic and not a thing to leave on. Emitted bytes at level 3 go
7.4 MB -> 9.0 MB (+21 %); at level 2 they are byte-length identical (above).

Files: `work/j/opcensus/bochs/bochs/nanobox_jit.cc` (`nanobox_op_census`, `nanobox_jit_opcensus`,
`TraceCompiler::profCountOp`), `harness/run.mjs` (`--op-census`, the census table). Control tree:
`work/j/opcensus/bochs-ctl`. Builds `build/opcensus`, `build/opcensus-ctl`. NOT merged into
`bochs/` — the harness half is, and degrades to a no-op on engines without the export.

### V.21 Address resolution: every memory site indexes the guest's own DTLB and tests the entry inline (2026-08-21, `work/j/opcensus`)

A memory site resolves its address against the guest's own 2,048-entry DTLB, indexed by page. **No
field had to be added to `bx_TLB_entry`**, because the classification is exactly two tests, and both
are emitted at the site:

1. `entry->lpf == (la & (LPF_MASK | (acm & (size-1))))` is page identity **and** "no alignment check
   pending" in one compare (a pending check folds the low operand bits into the compared value, which
   a page-aligned `lpf` can then never match), **and** the span test — the index is built from
   `la + size - 1`, so an access running off the page end looks up the *next* page's entry, whose
   `lpf` cannot equal this page's.
2. `entry->accessBits & (bit << user_pl)` is permission at this CPL **and** host-pointer availability:
   Bochs clears the access bits of a page it has no host pointer for, so "real RAM with a host
   pointer" is never a separate case (census: `nohost` = 0 across a whole boot).

Either test failing branches to the site's slow arm. The only genuinely dynamic condition left is the
iCache write stamp, which `serveICacheMiss` can add under a live entry, so it stays a per-access test
(`fgm[ppf >> 12]`, and `nanobox_helper_dec_write_stamp` inside the `if`). Nothing travels between
translations: the trace signature is `(arg i32)`, plus `(rip i64, ic0 i64)` under direct calls, and a
site's scratch is its own — `L_host` for the host pointer, `P_off` for the page offset and the `W`
i64 scratch for the ppf.

#### Slow-arm reasons (`nanobox_jit_opreason(ia, r)`, level 3 only)

The slow arm is entered exactly when one of the two tests fails, so the reason counters are
exhaustive over it and reconcile with the per-opcode slow-arm count. On a codex boot the reason is
"another page frame" (`lpf`) for essentially every slow-arm entry: `MOV_GqEq` 49,019 entries, 100.0 %
`lpf`; the write-side opcodes split between `lpf` and `perm` (`MOV_Op64_EdGd` 97.0 % `perm`,
`CMPXCHG_EdGd` 98.9 %). `acm` and `nohost` are 0 across a whole boot, and span was never a reason.

#### Where it lands

`build/opcensus` / `build/opcensus-nowiz`, codex, `--jit 2:2000`:

| | |
| --- | ---: |
| boot to sign-in, wizer, interleaved x2 | 5,236 ms |
| boot to sign-in, cold | 10,275 ms |
| slow-arm executions, codex boot | 146,409 |
| emitted wasm, `/bin/true`, 18,280 instances | 1,085,661 B |
| `MOV_GqEq` / `MOV_EqGq` B/instance | 132 / 80 |

Keystroke echo, pooled 3 sessions x 140 keys: p50 **7.3 ms**, p90 **9.8 ms**, p99 **13.1 ms**. `max`
is a one-sample statistic and is not usable at three sessions (per-session maxima 43.8 / 13.7 / 13.1).
`opbench.sh` is flat: the micro-kernels loop on ONE page, so they measure the inline arithmetic and
nothing else, and it costs nothing measurable.

Cold-boot RAM identity, both guests, run as separate commands (`REF=../build/ref-nowiz/out.wasm
OPT=../build/opcensus-nowiz/out.wasm`): codex `ticks=2942837561 sha=b880eb9b1be5` **IDENTICAL**, agy
`ticks=3684200090 sha=8692e3a71a5b` **IDENTICAL**. Bisect on the wizer engine: `no divergence`, 110
blocks x 100,000 traces.

#### Two rules this cost a day of measurement to relearn

Both were already written down in this file and both were re-broken anyway.

1. **A wizer engine cannot gate a codegen change.** Every gate available on a wizer build (bisect,
   wizer identity on both arms, census, opbench, keylat) can pass on an engine that corrupts guest
   memory, because only `--no-wizer` runs the early boot — and the failure it hides is a hard cold-boot
   hang: no SUMMARY, the harness' own `--timeout` never fires, the log stops after `SNAPSHOT icount=0`,
   because control never returns to the JS event loop. Put the cold-boot pair in front of the numbers,
   not after them.
2. **Any local the trace signature or the link tail call carries is shared state, not scratch.** A new
   emission path must allocate its own locals; before writing one that the signature might carry,
   check `pushEntryStateFromMem()` and `jitFuncType()` for what the link hop hands on. Writing half of
   a multi-local invariant (a host pointer without the page identity that describes it) is a silent
   miscompile, not a crash.

Files: `bochs/bochs/nanobox_jit.cc` (`tlbProbe`, `dtlbLookup`). Superseded in part by **V.25**, which
deleted the flag this shipped behind and shrank the trace signature.

### V.22 The async check off the fast path: it is provably movable, and moving it buys nothing (2026-08-22, `work/j/asyncsink`, `NANOBOX_ASYNCSINK`)

**The premise, restated and verified.** Every memory instruction that can raise
`BX_ASYNC_EVENT_STOP_TRACE` ends today with a test of `async_event` on its SHARED TAIL, after the
fast and cold arms rejoin, so the fast path falls through it: one i32 load plus one branch on all
104.7 M memory accesses of a codex boot. The fast path cannot raise the event —

* a read never touches a write stamp, so it never calls `decWriteStamp`;
* the write path tests the page's iCache write-stamp state per access, so the only fast-path-reachable
  raiser is that test. Bit 1 makes the write site DECLINE a stamped page instead of stamping it
  inline, so the site's existing `br_if` — the address test's ordinary failure branch — carries the
  SMC case out to the slow arm, where the accessor does the dance itself. Zero extra bytes and zero
  extra loads at the site.

so the check belongs to the cold arms alone.

**What was built.** The blocker named in the brief was real: `emitRead()`/`emitWrite()` leave the
value on the wasm stack and the CALLER commits it after the join, so exiting inside an arm would
re-execute the access on resume (rejected as V.10). The memory helpers grew a *tail functor* —
`emitReadThen`, `emitWriteThen`, `emitStackReadThen`, `emitStackWriteThen` — which is the rest of
the instruction, emitted in BOTH arms. The cold arm then completes the instruction, tests
`async_event`, exits, and the fast path carries nothing. The two arms are snapshotted and
`memcmp`-compared (`sinkJoin`), and a mismatch fails the compile rather than publishing it, exactly
as `emitStackRun` already does with its own two arms.

Sunk (mask bit -> opcodes): **0** MOV_GqEq, MOV_Op64_GdEd, MOV_GbEb, MOV_GwEw, MOVZX_G{d,q}E{b,w},
MOVSX_G{d,q}E{b,w}, MOVSXD_GqEd. **1** MOV_EqGq, MOV_EqId, MOV_Op64_EdGd, MOV_EdId, MOV_EbGb,
MOV_EbIb, MOV_EwGw, MOV_EwIw. **2** PUSH_Eq, PUSH_Op64_Id, POP_Eq (through the stack window).

**Skipped, and why.** The ALU-with-memory forms (ADD/SUB/CMP/AND/OR/XOR/TEST, the shifts, INC/DEC)
are where the tail is the *whole operation* — the flag computation and, for the RMW forms, the
write-back — so emitting it in both arms doubles the template. They are left alone. Anything with
TWO accesses is refused automatically: `asyncSinkOn()` declines when `needAsyncCheck` is already
set, because a fall-through exit past instruction k is only legal once k is complete. That covers
PUSH_Eq with a memory source and every RMW form without a special case. `last` stays exempt.

**Correctness.** `bisect` interpreter vs JIT, mask 7: no divergence over 111 blocks x 100 000
traces. `--no-wizer` cold-boot RAM identity with mask 7 (and `NANOBOX_NEWOPS=15`):
`RESULT: IDENTICAL` on **codex** (ticks 2 942 837 561, sha b880eb9b1be5) and on **agy**
(ticks 3 684 200 090, sha 8692e3a71a5b).

**Bytes — it does not shrink, it moves, and the move costs.**

| `npm run analyze`, codex     | flags off | ASYNCSINK=7 |
| ---------------------------- | --------- | ----------- |
| emitted bytes / instruction  | 109.0     | **111.0** (+1.8 %) |
| executed template bytes      | 27.36 G   | **28.22 G** (+3.1 %) |
| MOV_GqEq B/site              | 146.8     | 151.6 (`other` 10.2 -> 12.2) |
| POP_Eq B/site                | 124.7     | 140.3 (`other` 22.9 -> 35.8) |
| PUSH_Eq B/site               | 129.7     | 136.4 |
| MOV_EqGq B/site              | 55.9      | 56.9 |
| `async-check` B/site, MOV_GqEq | 15.2    | 15.2 |

The `async-check` column is unchanged **because the check is the same code in a different place**.
The 0.24 MB the brief costed is not deleted by relocating it; what IS new is the tail the cold arm
now needs (2 B for a MOV_GqEq `local.set`, 13 B for POP_Eq's RSP+dst commit), which is exactly the
`other` column moving.

**Speed — flat for reads/stack, a measured loss for writes.** `opbench.sh`, interleaved, three
runs per arm:

| ns/iteration | off | mask 5 (rd+stack) | mask 2 (wr) | mask 7 |
| ------------ | --- | ----------------- | ----------- | ------ |
| reg          | 2.99 – 3.00 | 2.98 | 3.01 | 2.96 – 3.05 |
| load         | 3.06 – 3.13 | 3.12 | 3.15 | 3.08 – 3.21 |
| store        | 7.02 – 7.08 | 7.00 | **7.40** | **7.34 – 7.63** |
| call         | 35.2 – 35.4 | 36.1 | 37.8 | 35.5 – 36.8 |

Pooled keystroke latency, 3 independent sessions per arm, 140 keys each (`--coldout 3`, the
shipping default):

| arm     | echo p50 | p90 | p99 | max | delivery p50 |
| ------- | -------- | --- | --- | --- | ------------ |
| off     | 9.1 | 12.2 | 20.7 | 53.8 | 0.5 |
| sink 5  | 9.2 | 12.1 | 16.8 | 47.4 | 0.5 |

Boot MIPS, 3 interleaved reps of a `/bin/true` codex boot: off 660.4/665.9/671.1, sink 5
670.6/677.7/663.4, i.e. inside the +-4 % MIPS noise.

**Verdict: rejected, default stays 0.** Bit 1 (writes) is a rejection on the stated bar — it is not
smaller AND it is 5-8 % slower on the store kernel, reproduced across two builds. Bits 0|2 are
free of that but buy nothing: they cost +1.8 % of emitted bytes for a latency change inside noise.
The reason is the same one this file keeps finding: **the fast path was already paying ~0 for the
check.** `async_event` is the hottest possible word in linear memory and the branch is perfectly
predicted, so removing one load and one never-taken branch from 104.7 M accesses is not a
measurable amount of work — while the duplicated commit it costs is real bytes on every site.
Byte volume did not predict time here either (V.2, V.13), and this time neither did instruction
count on the fast path.

The code stays behind the flag: it is correct, gate-green on both guests, and it is the only
mechanism in the tree that can complete an instruction inside a cold arm — which is the thing a
future deopt/exit experiment would need.

Files: `work/j/asyncsink/bochs/bochs/nanobox_jit.cc` (`emitReadThen`/`emitWriteThen`/
`emitStackReadThen`/`emitStackWriteThen`, `emitAsyncCheck`, `sinkJoin`, `nanobox_probe_x*`,
`tlbProbe(..., stampToSlow)`); `harness/run.mjs` (`--asyncsink` / `NANOBOX_ASYNCSINK`).
Builds `build/asyncsink`, `build/asyncsink-nowiz`. Data `work/prof/op-data/{off1,sink7c,sink5,sink2}.log`,
`work/prof/aot-data/io-as-{off,s5}-{1,2,3}.jsonl`.

### V.23 Templates for the instructions that had none: 34 % of the handler steps deleted, and the workload does not notice (2026-08-22, `work/j/asyncsink`, `NANOBOX_NEWOPS`)

**What was implemented** (mask bit -> opcodes, all default off):

* **0 — PAUSE** (43 164 executions). `BX_SUPPORT_VMX` and `BX_SUPPORT_SVM` are both 0 in this build
  (`config.h:634-635`), so `BX_CPU_C::PAUSE` is `BX_NEXT_INSTR(i)` and nothing else. The template is
  the empty program.
* **1 — CLD / STD** (7 502). One EFLAGS.DF bit, read-modify-write in memory.
* **2 — CLI / STI** (253 173 + 211 333 = 464 506). **CPL == 0 is the whole guard.** At CPL 0 the PVI
  branches of `BX_CPU_C::CLI`/`::STI` cannot be taken (they need CPL == 3), `IOPL < CPL` and
  `CPL > IOPL` are false, and v8086 mode runs at CPL 3 — so what is left is `clear_IF()` for CLI and
  `if (!get_IF()) { assert_IF(); inhibit_interrupts(BX_INHIBIT_INTERRUPTS); }` for STI. Emitted as an
  8-bit load of `sregs[CS].selector.rpl`, `emitDeoptAndReturn` when it is non-zero (so Bochs' own
  guards, including the #GP, still decide every other CPL), and otherwise a **direct call to a
  two-line helper** — a call, not a handler step, so no state sync, no spill, no reload.
  `inhibit_interrupts` reads `get_icount()`, which inside a trace is stale until an exit commits it,
  so the site passes its own `L_ic0 + k`; its MOVSS special case cannot apply to this mask, so the
  helper is exactly the two stores. `needAsyncCheck` is set, because `handleInterruptMaskChange()`
  re-evaluates the pending events.
* **3 — SWAPGS** (35 894). Same CPL guard, then `sregs[GS].cache.u.segment.base` and
  `msr.kernelgsbase` exchanged inline — two loads, two stores.

**Skipped, with the reason.**

| opcode | executions | why not |
| --- | --- | --- |
| `REP_MOVSB_YbXb` | 511 393 | **already templated** (`emitTemplateRep`). Its dynamic count is that template's runtime DEOPTS — DF set, the count crossing a page, a code-marked destination, an overlapping copy, RCX above 32 bits — not a missing template. Widening those conditions is a separate project. |
| `REP_STOSD_YdEAX` / `REP_STOSQ` | 72 421 / 12 443 | `memory.fill` fills BYTES; a dword/qword pattern needs a loop, which is the interpreter's own loop. |
| `XCHG_EdGd` / `XCHG_EbGb` (memory) | 86 188 / 374 | implicitly LOCKed: needs the atomic RMW path. |
| `CMPXCHG16B` | 49 553 | the lock path, as the brief allowed. |
| `POP_Eq` | 82 483 | `POP_EqM`, whose effective address is RSP-speculative. |
| `SYSRET`, `IRET_Op64`, `MOV_EwSw`, `MOV_SwEw` | 14 065 / 7 749 / … | full mode + segment reload; the interpreter is the semantics. |
| `DIV_EAXEd`, `DIV_RAXEq`, `IDIV_*` | 10 513 / 3 948 / … | the #DE path. |
| `SAR_EwI1`, `BT_EqGq` | 40 932 / 33 422 | genuine candidates I did not reach: both templates exist and bail with `if (!R) return false`, so what is missing is a memory-RMW form of an existing template, not semantics. |
| `AESENC`, `PUNPCKLBW`, `PSHUFD`, `MOVSD_VsdWsd` | 26 633 / 24 599 / 13 200 / 9 876 | SIMD. PUNPCKLBW and PSHUFD are `i8x16.shuffle` with a compile-time mask and are the obvious next additions to `emitTemplateSimd`. |

**Result.** Codex boot to the sign-in prompt, `--jit 3:2000`:

|                                   | off | NEWOPS=15 |
| --------------------------------- | --- | --------- |
| dynamic instructions, inline      | 490 673 836 | 491 224 902 |
| dynamic instructions, **handler step** | **1 607 177** | **1 056 111** (−34.3 %) |
| compile-time fallback instructions | 1 086 | 856 (−21 %) |
| emitted bytes / instruction       | 109.0 | 109.1 |

CLI, STI, PAUSE, SWAPGS and CLD are gone from the `top DYNAMIC fallbacks` list entirely.

**Speed: nothing.** Pooled keystroke, 3 sessions x 140 keys: `newops 15` echo p50 9.6 / p90 12.2 /
p99 18.6 vs off 9.1 / 12.2 / 20.7. Boot MIPS, 3 interleaved reps: 662.6 vs 665.8. Both inside the
+-8 % / +-4 % noise floors. Bytes are flat because a handler step is already compact — a direct
call — so replacing it with a template of similar size is a wash.

**Correctness.** `bisect` interpreter vs JIT, mask 15: no divergence over 111 x 100 000 traces.
Cold-boot `--no-wizer` identity (together with `NANOBOX_ASYNCSINK=7`): IDENTICAL on codex and agy.

**Verdict: default stays 0, keep the flag.** The templates are correct, cheap and gate-green, and
they are the right thing to have if the fallback tail ever grows (a SIMD-heavy guest, a different
program). But the win is not there, and the reason is arithmetic that the ranking hid:

> **The "top DYNAMIC fallbacks" list is a bad priority list.** 1.6 M handler steps reads like a big
> number; against the 492 M instructions executed inside JIT'd traces it is **0.33 %**, and the five
> easiest entries on it are **0.11 %**. Even at a generous 30 ns saved per handler step, deleting
> 551 k of them is 17 ms of a 6 500 ms boot — an order of magnitude under the measurement noise.
> Rank fallback work by *share of executions*, not by rank in the list; on this workload nothing
> below `REP_MOVSB` (0.10 % on its own) can move the number, and `REP_MOVSB` is already templated.

Files: `work/j/asyncsink/bochs/bochs/nanobox_jit.cc` (`nanobox_helper_cli`, `nanobox_helper_sti`,
the `BX_IA_PAUSE`/`CLD`/`STD`/`CLI`/`STI`/`SWAPGS` cases in `emitTemplate`, `newOp()`);
`harness/run.mjs` (`--newops` / `NANOBOX_NEWOPS`). Builds `build/asyncsink`, `build/asyncsink-nowiz`.

#### Note: the default path, and a build-reproducibility gotcha found while checking it

Both flags are default 0 and every new behaviour sits behind `newOp()` / `asyncSinkOn()`, so the
shipping emission is untouched. Verified against a **pristine control build** of the same base
(`work/j/asyncsinkctl`, an unmodified copy of `bochs/bochs` built as `build/asyncsinkctl`): boot
MIPS over three interleaved reps of a `/bin/true` codex boot, control 667.1 / 651.3 / 671.7 vs
flags-off 669.9 / 655.1 / 658.0 — inside noise.

While doing that, a trap worth writing down: **a `/bin/true` codex boot is deterministic per binary
but NOT reproducible across separate builds of the same source.** `build/eh-nb`, the pristine
control and the variant give three different final icounts (629 465 361 / 629 416 880 /
629 526 522) and three different compiled-trace sets, and each is exactly repeatable on re-run. The
run uses a LIVE host clock, so the guest's wall-clock-driven loops iterate a different number of
times when the host is a few per cent faster or slower, and the trace set — hence every `--tpl-bytes`
per-opcode average — moves with it. Consequences:

* **`bisect A.wasm B.wasm` between two different BUILDS reports a spurious divergence** (`ic` and
  `tk` differing at an `ae=1` boundary in an idle loop) even when the two builds are the same
  source. Bisect is only meaningful with the SAME binary on both sides (`--b-args` for the variant
  flag) — which is the form the brief prescribes, and now there is a reason for it in writing.
* **A `npm run analyze` byte delta below ~1 % between two builds is trace-mix, not emission.**
  Compare the same binary with the flag off and on, never two builds.
* The frozen-clock path (`test/identity.sh`) does not have this problem, which is the other reason
  it is the gate.

### V.24 The cold arm completes the instruction and leaves: it works, it is worth 3.1 % of emitted bytes — and leaving UNCONDITIONALLY is not identity-preserving (2026-08-22, `work/j/coldcall`, `NANOBOX_COLDCALL`)

**The design as briefed.** On the cold path of a memory instruction, call a helper that (1) performs
the access the slow way, (2) *completes the instruction against the CPU struct* — writes the
destination register rather than returning a value — and (3) leaves the translated function, so the
caller needs nothing from it. The caller's fast path then keeps only the address, one compare, the
`br_if`, the access and its own commit; the shared tail loses the `async_event` test entirely,
because the only path that could raise it no longer comes back.

The blocker every earlier attempt hit — *a called function cannot write its caller's locals* — is
answered by the descriptor: `c = commit-code | dst<<4`, where the code is one of `R64 / R16 / R8L /
R8H / S8_32 / S8_64 / S16_32 / S16_64 / S32_64` and each arm of `nanobox_cold_commit()` reproduces
the emitted template's own commit exactly (`writeReg8`/`writeReg16` are read-modify-writes of
`gen_reg[].rrx`, so these are too). Two extra site bytes buy the whole tail.

**Built** (`NANOBOX_COLDCALL`, default 0):

* **bit 0 — loads whose whole commit is a register write**: `MOV_GqEq`, `MOV_Op64_GdEd`,
  `MOV_GbEb`, `MOV_GwEw`, `MOVZX_G{d,q}E{b,w}`, `MOVSX_G{d,q}E{b,w}`, `MOVSXD_GqEd`.
* **bit 1 — stores, where the write IS the commit**: `MOV_EqGq`, `MOV_EqId`, `MOV_Op64_EdGd`,
  `MOV_EdId`, `MOV_EbGb`, `MOV_EbIb`, `MOV_EwGw`, `MOV_EwIw`. A store needs one more thing: the
  fast path's write-stamp dance is its last raiser of `async_event`, so under bit 1 the write site
  **declines** a stamped page down its existing `br_if` instead of stamping it inline, and the slow
  accessor does the SMC dance itself. That deletes an inline `if` + call from every store site and
  costs nothing (the `br_if` is the compare's existing consumer).
* **bit 2 — leave UNCONDITIONALLY** (the design exactly as briefed). Without it the helper reports
  `async_event` back and the arm leaves only where the shared tail would have.

**Skipped, with the reason.** The ALU-with-memory forms are where the tail is the whole operation
(flags, and for RMW the write-back), so the commit is not expressible as a descriptor — left alone,
as the brief allowed. `PUSH_Eq`/`POP_Eq` (a further 17.5 % of the cost share) go through
`emitStackWrite`/`emitStackRead` and `emitStackRun`, whose commit (`RSP -= 8` / `RSP += 8` plus the
destination) IS expressible; they were not reached. Anything with two accesses is refused, because a
fall-through exit past instruction *k* is only legal once *k* is complete — that covers `PUSH_Eq`
with a memory source and every RMW form.

#### The result that matters: an unconditional exit changes the guest

Cold-boot `--no-wizer` RAM identity, `REF=build/ref-nowiz`, `OPT=build/coldcall-nowiz`:

| arm | codex | agy |
| --- | --- | --- |
| as it stands | **IDENTICAL** (ticks 2 942 837 561, sha b880eb9b1be5) | — |
| `COLDCALL=3` (leave only where the tail would have) | **IDENTICAL** (same ticks, same sha) | **IDENTICAL** (ticks 3 684 200 090, sha 8692e3a71a5b) |
| `COLDCALL=7` (leave unconditionally) | **DIFFERENT** — ticks 2 944 718 845, icount 1 191 460 242 vs 1 189 899 833 (+0.13 %), sha 4f01a525e38d | — |

The commit descriptors are not the problem: mask 3 runs the same helper, writes the same registers
through the same code, and is bit-identical on both guests. **The extra trace boundary is the
problem.** `cpu_loop` runs `BX_SYNC_TIME_IF_SINGLE_PROCESSOR(0)` after *every* trace, ticking the
PIT by the instructions retired since the last sync. Splitting one trace into two leaves the tick
TOTAL unchanged — but it moves the moment at which a timer that expires inside the first half
raises its IRQ, so the guest takes the interrupt some instructions earlier than the reference does,
and from there the boot is a different boot. On the short `/bin/true` boot the same effect is
visible in miniature: icount 629 323 666 under mask 7 against 629 323 672 under every other arm.

> **Rule to keep: a compiled trace may only end where the interpreter's trace would end.** The
> engine's existing early exits all satisfy this — they fire on `async_event`, which is exactly
> `BX_NEXT_INSTR`'s own condition. An exit taken because *the emitter found it convenient* is
> guest-visible through interrupt delivery, however rare it is (146 k times in 104.7 M accesses
> here), and no amount of rarity makes it identity-preserving. This is the same class of finding as
> V.12: AOT's ticks moved because three BOUNDARY decisions moved, not because of accounting.

So the shipping shape is mask 3: the helper still does the access, still commits into the CPU
struct, still decides — and hands that decision back as its return value, `if / return`, with a
one-instruction reload of the destination local on the rejoining path.

#### Size

`npm run analyze`, codex, ONE binary (`build/coldcall-nowiz`) with the flags off and on, so the
trace mix is held fixed at 70 298 compiled instructions (V.23's rule). Mask 7 diverges, so its
column is a different mix (70 982) and is ~1 % contaminated — read it as a direction, not a figure.

| | as it stands | `+ COLDCALL=3` | `+ COLDCALL=7` |
| --- | --- | --- | --- |
| emitted bytes / instruction | 100.0 | **96.9** (−3.1 %) | 95.9 (−4.1 %) |
| executed template bytes | 43.74 G | **42.01 G** (−4.0 %) | 41.21 G |
| `MOV_GqEq` B/site | 154.3 | **144.6** (−6.3 %) | 134.9 (−12.6 %) |
| `MOV_EqGq` | 70.5 | **60.0** (−14.9 %) | 59.4 |
| `MOV_Op64_GdEd` | 157.4 | **147.6** (−6.2 %) | 137.6 |
| `MOV_Op64_EdGd` | 60.4 | **52.1** (−13.7 %) | 51.4 |
| `MOVZX_GdEb` | 107.6 | **101.1** (−6.0 %) | 94.4 |

`MOV_GqEq` by phase, as it stands → `COLDCALL=3` → `COLDCALL=7`:

| phase | as it stands | CC=3 | CC=7 |
| --- | --- | --- | --- |
| other | 10.2 | 8.2 | 8.2 |
| addr-resolve | 73.4 | 73.4 | 73.4 |
| stack-refill | 0.0 | 0.0 | 0.0 |
| spill-fault | 16.2 | 16.2 | 16.5 |
| slow-arm | 14.2 | 14.7 | 14.7 |
| exit | 8.0 | 13.0 | **3.0** |
| async-check | **15.2** | **0.0** | **0.0** |
| access | 10.0 | 12.0 | 12.0 |

The mechanism is exactly what was designed: `async-check` goes to zero, the commit moves inside the
fast arm (which is why `access` gains 2.0 and `other` loses 2.0 — pure re-attribution), and the
site's whole exit is what is left. Under mask 7 the exit is **3.0 bytes — a bare `return`**, because
the helper retires the instruction itself (`prev_rip = RIP`, `icount = ic0 + k + 1`); under mask 3 it
is 13.0, being the `if` / `return` / `end` plus the destination reload.

**The brief's estimate of ~60 bytes for a load against today's 146 is not met, and the census says
why.** The tail this removes is only worth 15.2 B/site. There was never 86 bytes on this path to
find: `addr-resolve` is 51 % of a load and it is address arithmetic, not bookkeeping.

#### Speed: nothing, in either direction

`work/prof/opbench.sh`, ns/iteration, two runs per arm interleaved. The kernels loop inside one page,
so the cold arm is essentially never executed — this measures the fast path only, which is the point:

| | reg | load | store | call |
| --- | --- | --- | --- | --- |
| as it stands | 2.99 / 3.04 | 3.10 / 3.15 | 6.92 / 6.89 | 35.38 / 35.20 |
| `COLDCALL=3` | 2.98 / 3.03 | 3.10 / 3.15 | 6.77 / 6.92 | 35.22 / 35.84 |
| `COLDCALL=7` | 3.13 / 3.01 | 3.26 / 3.15 | 6.60 / 6.39 | 37.86 / 34.70 |

**What the improvement should be, before looking at a clock.** `COLDCALL=3` deletes exactly one
thing from the executed stream: one i32 load of `async_event` and one never-taken branch, per
execution of a converted memory instruction. (The store-side stamp change collapses an inline `if` +
call into a `br_if` on the SAME compare, so the fgm load still runs and ~0 executed work is saved
there; the cold arm itself runs 131 k times, 0.15 %, and is irrelevant either way.) The cold-path
census gives the memory-operand execution counts for a codex boot -- `MOV_GqEq` 41.25 M,
`MOVZX_GdEb` 24.03 M, `MOV_EqGq` 19.46 M, `MOV_Op64_GdEd` 15.54 M, plus `MOV_Op64_EdGd` and the
smaller forms -- so **~130 M**. `async_event` is the hottest word in linear memory and the branch is
perfectly predicted, i.e. ~0.2-0.5 ns of throughput each:

> 130 M x ~0.35 ns = **~45 ms of a ~6 000 ms boot = ~0.8 %**, and the same fraction of a 7.6 ms
> keystroke echo = **~0.06 ms**.

The keystroke noise floor is +-8 % = +-0.6 ms, **ten times the predicted effect**. This measurement
is therefore impossible on that instrument by construction, not by bad luck -- resolving 0.8 %
against the observed session-to-session spread needs on the order of a thousand sessions.

Pooled keystroke echo latency, **6** independent sessions per arm, 120 keys each (ms):

| arm | p50 | p90 | p99 | max |
| --- | --- | --- | --- | --- |
| as it stands (n=720) | 7.6 | 10.9 | 18.3 | 52.7 |
| `+ COLDCALL=3` (n=720) | **7.2** | **10.8** | 23.4 | 51.6 |
| `+ COLDCALL=7` (n=360) | 7.0 | 10.7 | 16.9 | 43.8 |

**The gap shrinks as samples are added**, which is the signature of a small-sample artefact, not of an
effect: at 3 sessions it read 7.8 -> 7.2 (-7.7 %) and 11.3 -> 11.0 (-2.7 %); at 6 it is -5.3 % and
-0.9 %. Per-session p50s are 7/9/8/7/7/8 against 7/7/8/7/8/7 -- a difference of 0.33 +- 0.39 ms,
t = 0.85. Not distinguishable from zero, and equally not distinguishable from the predicted 0.06 ms.
The p99 column is dominated by which sessions happened to land badly (the baseline has 30.9 and 33.6
sessions of its own), so nothing in it is an arm effect.

**The boot is the better instrument**, because icount is bit-identical across arms (629 323 672 on
every `cc0` and `cc3` run), so host wall time is the only variable. Boot to exit, `/bin/true` codex,
wall ms, interleaved:

| arm | runs | icount |
| --- | --- | --- |
| as it stands | 5988.5 / 6027.1 / 6114.7 | 629 323 672 |
| `+ COLDCALL=3` | 5932.9 / 5941.7 / 6064.7 | 629 323 672 |
| `+ COLDCALL=7` | 6363.1 / 5916.9 | 629 323 666 |

Mask 3 is under its own baseline in **all three interleaved pairs** — −0.9 %, −1.4 %, −0.8 %, mean
−1.0 % — which lands on the ~0.8 % the instruction count predicts above. It is below the ±4 % floor,
so it cannot be *proved* here; but the direction is consistent on every instrument and the magnitude
agrees with the prediction, so the defensible claim is **~1 % faster**, not "flat". Mask 7's predicted cost is arithmetic rather than measurable: the
converted opcodes take the cold path **131 k times** in a codex boot (`MOV_GqEq` 62 663 of
41 314 487 accesses = 0.15 %, `MOV_EqGq` 25 066, `MOV_Op64_GdEd` 24 987, `MOVZX_GdEb` 17 900, and
every other access resolves inline), so at ~400 ns an exit it is ~52 ms
of a 6 000 ms boot, or 0.9 %.

#### Verdict

**Default stays 0; mask 3 is the form that could ship, mask 7 is a documented dead end.** Mask 3 is
correct, gate-green on both guests, and worth −3.1 % of emitted bytes, −4.0 % of executed template
bytes and **~1 % of time** on the engine as it stands — the last of those predicted from the
instruction count first and then observed 3/3 on boot, never resolvable on keystroke latency.

**What address resolution costs**, since the table invites the question: a site emits the DTLB
lookup itself — index arithmetic, folded-tag construction, compare, permission test, host-pointer
load, with `(BX_DTLB_SIZE-1)<<12`, `ADDR(DTLB.entry[0])` and `LPF_MASK` each a 5-byte LEB. **73.4 B
on `MOV_GqEq`, and no miss arm at all**, with zero cross-module calls.

What the exercise actually establishes is the boundary rule above, and one correction to the brief's
model: the reason a memory instruction costs 146 bytes is not the tail. It is `addr-resolve` — 73.4
bytes of index arithmetic, tag construction and permission test, half the instruction — and that is
where the next 40 bytes are, not in the cold arm.

**Not run: `bisect`.** Its interpreter chain alone takes 18.3–20.6 s on this machine (`--init-only`
and `--cmd /bin/true` both), and the tool runs two such chains in one process, so the command does
not fit the 30 s cap and was not split, backgrounded or retried. The two cold-boot RAM-identity runs
are the stronger check and both passed; bisect adds only *where* a divergence is, and there is none.

Files: `work/j/coldcall/bochs/bochs/nanobox_jit.cc` (`nanobox_cold_commit`, `nanobox_cold_retire`,
`nanobox_cold_rd_c`/`_x`, `nanobox_cold_wr_c`/`_x`, `TraceCompiler::Commit` + `emitCommit` +
`emitReadC`, `emitWrite(..., complete)`, `tlbProbe`'s `stampToSlow`);
`harness/run.mjs` (`NANOBOX_COLDCALL`). Build `build/coldcall-nowiz`. Data
`work/prof/coldcall/analyze-*.txt`,
`work/prof/op-data/cc-{off,di3,cc3,cc7}-*.log`, `work/prof/aot-data/io-cckl-{di3,cc3}-{a..f}.jsonl`
and `io-cckl-cc7-{a,b,c}.jsonl`.

### V.25 One way to resolve a guest address: the runtime switch and the redundant path deleted, trace signature 4 params -> 1 (2026-08-22, `work/j/memodelete`)

The engine carried a second, redundant way of turning a guest linear address into a host pointer and
a runtime flag to choose between it and the one in V.21. This entry deletes the flag and the
redundant path: there is now one way, no switch, no dead branch and nothing left that names the
alternative. **Deleted, not disabled**: `nanobox_jit.cc` 7,088 -> 6,322 lines and `nanobox_jit.h`
74 -> 64 (941 lines removed, 168 added, net **-776**).

#### What a memory site does now

```
entry = &DTLB.entry[((lo32(la) + size-1) & ((BX_DTLB_SIZE-1) << 12)) >> 12]
entry->lpf     != (la & (LPF_MASK | (acm & (size-1))))  -> slow arm
entry->accessBits & (bit << user_pl) == 0               -> slow arm
[write, or a caller that asked: the page's iCache write-stamp test]
L_host = entry->hostPageAddr ; P_off = la & 0xfff
```

Two compares are the whole classification; V.21 derives why. There is no state at the site to go
stale: it hits exactly when the guest's own TLB hits.

#### The trace signature shrank by three parameters

Every JIT function -- trace, region, link epilogue -- shared one wasm type. It was
`(i32, i64, i64, i32)`, four parameters, of which three carried state from one translation to the
next through the link tail call. It is now `(i32)`: the iCache entry argument and nothing else.
Direct calls still add the committed RIP and icount, so the direct-call type went `6 -> 3`. This
touched the link tail call, `call_indirect` at the direct-call site, `nanobox_jit_call`'s C function
pointers in `nanobox_jit.h`, and the entry prologue (which no longer stores anything at all beyond
the CPU-struct base, the alignment mask, `L_base`/`L_ic0` and `user_pl`).

#### Cold-boot RAM identity: IDENTICAL on both guests

Run first, before any measurement, `--no-wizer` on both sides against `build/ref-nowiz`:

| guest | icount | ticks | RAM sha |
|---|---|---|---|
| codex | 1,189,899,833 | 2,942,837,561 | `b880eb9b1be5` — **IDENTICAL** |
| agy | 1,933,637,056 | 3,684,200,090 | `8692e3a71a5b` — **IDENTICAL** |

Re-run after every later edit to the engine source, including the comment-only and phase-name-only
passes, and identical each time.

#### Emitted size: flat per opcode, -0.9 % overall

`npm run analyze`, codex boot, level-2 bytes. Per-opcode `B/site` is unchanged within the run-to-run
spread; the saving is in the shared prologue and link tail, which is where the deleted parameters
lived.

| | before | after |
|---|---|---|
| **emitted bytes per guest instruction** | **114.4** | **113.4** |
| `MOV_GqEq` | 154.9 | 154.9 |
| `MOV_EqGq` | 71.8 | 72.0 |
| `PUSH_Eq` | 129.6 | 129.8 |
| `POP_Eq` | 124.6 | 124.5 |
| `RET_Op64` | 177.4 | 177.1 |
| `CALL_Jq` | 192.9 | 193.0 |
| `MOV_Op64_GdEd` | 151.6 | 151.7 |
| `MOVZX_GdEb` | 113.0 | 113.3 |
| `MOV_Op64_EdGd` | 54.4 | 53.1 |

Where a load site's 154.9 B goes: 73.3 B `addr-resolve`, 16.8 B spill-fault, 15.2 B async-check,
14.3 B slow-arm, 10.2 B template body, 10.0 B the access, 8.0 B exit.

#### Speed: no change either way that the instruments can separate

`work/prof/opbench.sh`, two replicates per arm, ns/iteration:

| shape | before | after |
|---|---|---|
| reg | 3.02 / 3.04 | 2.92 / 3.04 |
| load | 3.15 / 3.15 | 3.03 / 3.18 |
| store | 6.95 / 6.90 | 6.71 / 6.94 |
| call | 35.22 / 37.91 | 36.41 / 36.62 |

Every shape's two arms overlap; on `call` the two same-binary replicates of the BEFORE arm
(35.22, 37.91) bracket both AFTER runs, which is the whole answer.

Keystroke echo latency, `KEYS=140` x 3 independent sessions per arm, pooled (420 keystrokes each):

| | p50 | p90 | p99 | per-session p99 |
|---|---|---|---|---|
| before | 7.6 | 10.7 | 30.9 | 37.3 / 32.4 / 17.3 |
| after | 8.0 | 10.8 | 16.9 | 17.3 / 16.9 / 15.8 |

p50 and p90 are indistinguishable. The pooled p99 is halved, and every after-session's p99 is below
every before-session's except the third, which ties -- consistent in direction on 3/3 but not
separable at n=3, so the defensible claim is "p50/p90 flat, p99 no worse".

#### The census now measures the engine that exists

`nanobox_jit_opcensus` slots are `dtlb / stk / stkmiss / slow / exit / trans`; the reason census is
`lpf / acm / perm / nohost / stamp`, emitted inline in the two miss arms at level 3 (there is no
helper left to count from). It reconciles: the reason columns sum to the opcode's slow-arm count.
On a codex boot 99.83 % of `MOV_GqEq` accesses are served by the inline test, and "another page
frame" is the reason for essentially all of the rest. The profiler's phases are `addr-resolve` and
`stack-refill`.

#### Files

`work/j/memodelete/bochs/bochs/nanobox_jit.cc` (`tlbProbe`, `dtlbLookup`, `reasonLpfOrAcm`,
`reasonPermOrNohost`, `jitFuncType`, `declareLocals`, `emitInvalidate`), `nanobox_jit.h`
(`nanobox_jitfn_t`, `nanobox_jitfn3_t`, `nanobox_jit_call`), `harness/run.mjs`, `tools/analyze.mjs`,
`test/gate.sh`. Engines `build/memodelete` and `build/memodelete-nowiz`. Not committed.

### V.26 Where the guest's data accesses actually land: the "one contiguous region" premise is false, and the direct-map window it motivated pays 13 % of emitted bytes for 15 % of the probes (2026-08-23, `work/j/addropts`, `NANOBOX_ADDRCENSUS`, `NANOBOX_DMAP`)

Every compiled memory access resolves its address by indexing the guest's own 2048-entry data TLB by
page, comparing `entry->lpf`, testing `entry->accessBits` against the privilege level and adding the
page offset — about 56 of the 154 bytes a load emits. The premise to test was that a large share of
those addresses lives in one contiguous kernel region (Linux's direct map of all physical memory),
where "host = base + (la - PAGE_OFFSET)" would be a range check and an add with no table at all.

#### The measurement: a per-access address census (`NANOBOX_ADDRCENSUS=1`, level 3 only)

One call in front of the address resolution of every compiled access — `tlbProbe` and the stack
window both know the linear address before they know anything else — classifying it by region,
counting distinct pages, same-page locality inside a compiled unit, and CR3. Nothing is emitted
below level 3 or with the census off, so the shipped engine is byte-identical.

Codex boot to the sign-in prompt, `--jit 3:2000`. **183,241,003 compiled data accesses, of which
104,472,515 (57.01 %) run the DTLB probe** — the other 43 % are PUSH/POP/CALL/RET and 8-byte SS
operands, which `NANOBOX_STACKTAG` already resolves through the CPU's own stack window and which no
change to the table probe can touch. Percentages below are of the **probed** accesses, the only
population that matters:

| region | accesses | of all | **of probed** | rd | wr | 4 KB pages | 2 MB | observed span |
|---|---|---|---|---|---|---|---|---|
| user | 101,023,839 | 55.13 % | **56.04 %** | 41.92 % | 14.12 % | 6,233 | 53 | `0x4cb100 .. 0x7fffffffefeb` |
| kernel direct map | 17,655,481 | 9.64 % | **16.90 %** | 9.63 % | 7.27 % | 7,992 | 74 | `0xffff88800200a822 .. 0xffff88803ffec000` |
| vmalloc (incl. kernel stacks) | 50,411,287 | 27.51 % | 13.80 % | 7.78 % | 6.03 % | 70 | 2 | `0xffffc900000038d8 .. 0xffffc9000021bff8` |
| kernel text + data | 9,960,827 | 5.44 % | 9.53 % | 8.03 % | 1.50 % | 84 | 3 | `0xffffffff81a00280 .. 0xffffffff81fb33d0` |
| vmemmap | 3,854,610 | 2.10 % | 3.69 % | 2.34 % | 1.35 % | 699 | 3 | `0xffffea0000064980 .. 0xffffea0000ff8ff8` |
| cpu_entry_area | 334,959 | 0.18 % | 0.04 % | — | — | 1 | 1 | `0xfffffe0000002f48 ..` |

**The direct-map base was measured, not assumed.** The PGD histogram (`(la>>39)&0x1ff`) puts every
kernel access in exactly five buckets and nowhere else: 273 (`0xffff888000000000`, the direct map),
402 (vmalloc), 468 (vmemmap), 508 (cpu_entry_area), 511 (text/data). 273 is the nokaslr
`PAGE_OFFSET`, and no other index in `[273, 400]` is ever touched. Kernel data lives in two 4 MB
buckets of the top 2 GB (`0xffffffff81800000`: 0.24 %, `0xffffffff81c00000`: 5.19 %).

**The headline is a refutation.** The largest contiguous region is *user space* at 56 % of the
probes — and user space is precisely the region that is not affine: scattered physical pages, per
process page tables. The largest *affine* window, the direct map, is **16.90 %**; adding kernel
text/data (also affine, `la - 0xffffffff80000000`) reaches 26.4 %. There is no region where a range
check plus an add would serve "a large share".

Three more numbers from the same run:

* **Distinct pages: 15,079 x 4 KB (59 MB) and 136 x 2 MB over the entire boot**, peak 44 distinct
  2 MB regions live inside any 1M-access window. The working set is tiny; the DTLB is not missing
  (`dtlb=104,329,802` of `104,473,865` = **99.86 % served inline**). The probe is a correctness tax,
  not a miss problem.
* **Same-page locality inside one compiled-unit invocation** (65.4 M unit entries, 2.80
  accesses/entry). Over probed accesses: first-in-unit 36.43 %, same page as the immediately
  preceding probe 31.60 %, an earlier page in the same unit 12.56 %, a new page 19.40 % — so
  **44.16 % could reuse an already-resolved entry**. That is 2.6x the direct map's coverage and is
  the one number that supports a change; see "what is left" below for why it is still not obvious.
* **Address spaces: 35 distinct CR3 values over 12 distinct page-table roots** (Linux runs PCID, the
  PCID being the low 12 bits), and one CR3 covers 94.93 % of all accesses. **Kernel addresses
  reached at CPL 3: 0** — so a kernel window may legitimately drop the permission test.

#### The window was built anyway, and it is identity-clean — after two real bugs

`NANOBOX_DMAP`, default 0. Bit 1 emits, in front of the DTLB probe, two tests on the linear address
alone (the top 32 bits name the direct map — `PAGE_OFFSET` is 4 GB aligned, so the low 32 bits *are*
the guest-physical address — and that physical address is inside RAM and above 1 MB), then
`L_host = vector + (phys & ~0xfff)`. No DTLB entry, no `lpf` compare, no permission test. The
write-stamp dance is kept: the kernel patches code through this very alias and the stamp table is
indexed by the physical address the window already has.

Two things had to be fixed before it was sound, and both are the interesting part of this entry:

1. **Guest-physical -> host is not affine in stock Bochs.** `allocate_block` hands out
   `vector + used_blocks++ * block_size`, i.e. the host arena is *compacted in first-touch order*.
   "One add, no table" simply does not exist against that mapping. `NANOBOX_DMAP` bit 0 makes
   `init_memory` place every block at `vector + block * block_size` up front. The arena is already
   allocated at full size, so this costs one `memset` of guest RAM (1 GB here), not an allocation —
   but it does commit all of it, and it gives up the `BX_LARGE_RAMFILE` overcommit, so it is refused
   unless host RAM covers guest RAM. Lazy placement is *not* an option: the window hands out an
   address without consulting `blocks[]`, so it would read the arena before `allocate_block` had
   zeroed it and write bytes a later `allocate_block` would then zero away. Mixing the two
   placements is corruption, not a slow path (the two allocators collide), which is why
   `nanobox_set_jit_dmap` refuses outright if any block is already placed compactly — as it is on
   any Wizer-snapshotted engine, whose blocks were allocated before the setter runs. **The window
   therefore only works on a `--no-wizer` build today.**
2. **The direct map aliases physical addresses Bochs does not serve from the RAM arena.** With the
   window covering all of `[0, len)`, codex booted, started, and exited without ever printing its
   prompt — deterministically, at 854,617,034 instructions. The legacy hole below 1 MB (VGA
   aperture, shadowed option/BIOS ROM, memory handlers) is aliased by the direct map like any other
   physical address, and `vector + phys` hands back RAM where the guest must see ROM. Excluding
   `phys < 1 MB` fixed it. Restricting the window to reads did *not* fix it, which is what pointed
   at a read of ROM rather than at dirty-bit maintenance.

#### Identity: clean on both guests (step 3, before any performance claim)

The comparison has to be flag-vs-flag on the *same* engine, because bit 0 changes
`blocks.allocated` from 1806/8192 to 8192/8192 and `test/identity.sh` reports that as a difference.
Both sides pre-allocate; only the window differs:

| | ticks | RAM sha256 | verdict |
|---|---|---|---|
| codex, `NANOBOX_DMAP=1` vs `=3` | 2942837561 = 2942837561 | `b880eb9b1be5` = | **IDENTICAL** |
| agy, `NANOBOX_DMAP=1` vs `=3` | 3684200090 = 3684200090 | `8692e3a71a5b` = | **IDENTICAL** |

And the refactor itself is behaviour-neutral with the flag off: `ref-nowiz` vs `addropts-nowiz`,
`--jit 2:2000`, **IDENTICAL** on codex (`sha=b880eb9b1be5`) and on agy (`sha=8692e3a71a5b`).
`NANOBOX_DMAP=1` alone (identity placement, no window) is also tick- and sha-identical to the
reference; only the block map differs. Note the guest executes ~1300 fewer instructions out of
1.19 G with the window on (0.0001 %) at the same tick and the same RIP — inside the oracle's
criterion, but not zero.

#### What it costs, measured

Emitted bytes, codex boot, `--jit 2:2000`, same engine, same 5193 installed functions, flag-only:

| | emitted JIT bytes | delta |
|---|---|---|
| `NANOBOX_DMAP=1` (window off) | 7,229,389 | — |
| `NANOBOX_DMAP=7` (window, reads only) | 7,710,692 | +6.7 % |
| `NANOBOX_DMAP=3` (window, reads and writes) | 8,174,796 | **+13.1 %** |

With the flag off the engine is unchanged: `npm run analyze` gives **113.5** emitted bytes per guest
instruction against the 113.4 of V.25, and `MOV_GqEq` 154.5 B/site.

Runtime coverage confirms the census: **17,971,122 window hits out of 120,639,845 probed accesses
(14.90 %)** on a level-3 codex boot.

#### The verdict: it does not pay, and the numbers say why

The window costs ~30 bytes at **every** memory site — it cannot know at compile time which sites are
direct-map, so it is an *addition* to the probe, never a replacement — and it removes ~70 bytes of
executed probe on **one access in six**. Expected executed bytes per load site go from 154.5 to
`154.5 + 30 - 0.169 x 70 ≈ 173`: it loses on emitted size *and* on expected executed work. The time
side has no room either — V.25's `opbench` puts a load at 3.02-3.15 ns against a register op at
2.90-3.04 ns, so the entire address resolution is worth ~0.1 ns, of which the window could take at
most a sixth. One `opbench` arm was taken before this was stopped (`dmoff-a`, window off: reg 2.90,
load 3.02, store 6.67, call 36.37 ns/it) and is recorded for whoever continues; **no performance
claim is made for the window on the strength of one arm.**

Two related options do not need a build to be dismissed, by byte count:

* **Packing the permission bits into the spare low 12 bits of the stored host pointer** is a wash.
  It replaces two `i32.load`s (accessBits, hostPageAddr) with one — 4 bytes saved — and then needs
  `i32.const -4096; i32.and` to recover the page base, which costs the same 4 bytes back at the use
  site. 20 bytes before, 20 bytes after.
* **Hoisting the resolved entry across accesses that share a page** is the only option the census
  supports (44.16 % of probes could reuse), but the cache is only valid across a straight-line run
  with no call, slow arm or exit between the two accesses, and it must be keyed on the permission
  bit that was validated (a read-validated page is not write-validated). Both narrow the 44 % by an
  unmeasured amount, and the ~20 bytes of compare-and-reuse are again emitted at every site.

#### What is left for whoever picks this up

1. **Measure the *achievable* hoist coverage before building it.** The census's "unit" is a JIT
   function invocation, bumped by `nanobox_ac_unit_seq` in the prologue. Bump that same counter at
   every point the emitter loses confidence in the DTLB — slow arms, helper calls, handler steps,
   exits — and `ACM_PSAMEPREV + ACM_PREVISIT` becomes exactly the fraction a hoist could serve,
   instead of the 44.16 % upper bound it is today. That is a handful of `profCount(&nanobox_ac_unit_seq)`
   calls and one boot; it decides the option without writing the optimisation.
2. **Finish the `opbench` and pooled keystroke-latency arms** for `NANOBOX_DMAP=1` vs `=3` on
   `build/addropts-nowiz` (both arms need bit 0 so the block placement matches). One `opbench` arm
   is done; it needs a second replicate per arm and three keystroke sessions per arm.
3. **The window cannot run on a Wizer build.** If it is ever wanted for real, `nanobox_mem_identity`
   has to be set before Wizer snapshots (a build-time default rather than a runtime setter), or the
   already-placed blocks have to be permuted into identity order at setter time followed by a full
   TLB flush.
4. **`vmemmap` (3.69 % of probes) was left out of the window on purpose.** Unlike the direct map it
   is a virtually-mapped sparse array whose linear-to-physical map is an allocation artefact, so it
   is affine only by accident. Kernel text/data (9.53 %) *is* affine and would be a second window at
   the same per-site cost — worth it only if the per-site cost problem above is solved first.
5. **The real target the census points at is user space: 56 % of the probes, 41.92 % of them reads.**
   Nothing in this entry touches it. A per-site profile-guided choice (the level-3 census made
   per-site rather than per-opcode, feeding the existing `NANOBOX_JIT_TIER` recompile) is the only
   shape that removes the "emitted at every site" tax, and it would apply to user space too.

#### Files

`work/j/addropts/bochs/bochs/nanobox_jit.cc` (the census block and
`nanobox_helper_addr_census`/`nanobox_jit_addrstat`; `dmapWindow`, `tlbProbe` split into
`tlbProbeTable`/`emitStampDance`/`tlbProbeOffset`; `nanobox_set_addrcensus`,
`nanobox_set_jit_dmap`), `work/j/addropts/bochs/bochs/memory/misc_mem.cc` +
`memory/memory-bochs.h` (`nanobox_mem_identity`, `nanobox_vector`, `nanobox_ram_len`),
`work/j/addropts/addrcensus-report.mjs` (the report), `harness/run.mjs` (three additive hooks).
A self-contained diff of the engine changes is at `work/j/addropts/addropts.patch`; raw census
output at `work/j/addropts/census2.log`. Engines `build/addropts` (Wizer, census only — the window
is refused there) and `build/addropts-nowiz` (census + window). Engine sources are under the
gitignored `work/`, as with every other `work/j/*` entry.

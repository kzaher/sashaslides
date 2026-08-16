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

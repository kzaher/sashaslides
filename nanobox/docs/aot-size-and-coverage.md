# AOT emitted-size and coverage: analysis, proposals, and plan

*2026-08-19. Measurements are reproducible with the commands given; every number here came from this
tree on this machine. The engine referenced is `build/eh-nb` at commit 9002dc40.*

## 0. Why this document exists

The translator emits **85 bytes of wasm per guest instruction** after two rounds of size work today
(down from ~290 this morning). That is still monstrous: a three-instruction guest function emits ~200
wasm instructions, of which about 30 execute. The user's targets for the next phase are **another 10x
reduction in emitted size** and **10x more coverage** (i.e. cut the headroom between what we translate
and what the guest runs by an order of magnitude), with every change behind a flag.

The identity criteria have also changed, which matters because it changes what is *legal* to emit:
**call-stack contents no longer have to match the reference; only heap content and the syscall stream
do.** Section 5 lists what that unlocks.

## 0.1 What the day settled (added at the end, from the measurements below)

Both of the user's targets were pursued to a definite answer rather than left open:

* **Size: 10x is reachable and it is not worth taking.** Two-tier emission delivers **8.7x fewer bytes
  per guest instruction** (84.9 -> 9.8 on the pass-1+2 counter; installed wasm 7.23 -> 0.59 MB, 12.2x)
  and is **20x slower than the shipped emission and 25 % slower than not compiling at all** (§4.1).
  Every other size lever measured since is small: the stack window -4 %, the fault arm -1.7 %, the
  return-address store -4.4 % *and unsound* (§4.6, §4.7, TASKS.md V.10).
* **Coverage: the headroom is priced, and the price is why it stays.** Decode-time attach removes 42 %
  of interpretation and 70 % of runtime compilation for **1.9x the boot** (§4.3, TASKS.md V.8),
  because a compiled entry costs ~400 ns more than interpreting a one-shot trace and a boot runs 22.3 M
  of them. Per-function profile data would recover at most 22 % of that.
* **What actually sets the speed was found by elimination.** Byte volume: null at 6.8x and at 15.8x.
  Number of distinct compiled functions: null at 15.9x live and 1.86x dispatched; a `call_indirect` is
  flat at 8.9 ns from 6 to 65,536 callees. **The unit that costs is the BOUNDARY** — ~400 ns per entry,
  of which the call is 9 ns and the rest is prologue/epilogue state materialisation (TASKS.md V.13).
  Items 14-16 are the three levers that survive.
* **Two things were fixed rather than measured.** A re-entrant `nanobox_jit_cache_clear` frees its own
  caller's regions — a **crash reachable in the shipped engine** on a long session (TASKS.md V.11) —
  and AOT mode is now **tick-exact on demand**, so the plain RAM oracle gates an AOT engine with no
  relaxation at all (§5.1's caveat is superseded; TASKS.md V.12).

## 1. Method

* `--tpl-bytes FILE` on any harness run writes the per-opcode table: total emitted bytes, number of
  compiled instances, and bytes per instance. It needs no execution counts, so it works on an offline
  translation run too.
* `work/fib/dumpat.sh <tag> <elf> <addr> <len>` translates one guest address range through the AOT
  path and disassembles it; `work/fib/minpath.py` counts the minimum executed path through a
  translated function; `work/fib/kernelcmp.sh` runs the four micro-kernels below.
* `ENG=<engine> work/fib/phase.sh <aot> <n>` measures a loop's steady-state rate with in-guest markers
  (boot excluded). **Measure at n = 1e9**: at 1e8 you are measuring V8 warm-up, not the loop.

## 2. Where the bytes are today

A codex session, current engine: **10.7 MB emitted over 125,606 compiled instances = 85.2 B/instance.**

> **Correction (TASKS.md V.10).** That pair is a pass-1 + pass-2 sum on both sides: `nanobox_tpl_bytes`
> and `nanobox_inline_count` are bumped on every compile pass, while the installed module is only the
> final pass. On the same session the installed figure is **7.30 MB over 64,255 real instructions =
> 112.3 B each** — pass 1 emits ~0.86x pass 2 per instruction, so the two inflations do not cancel.
> Every absolute bytes/site number in this table (and in TASKS.md T.1 and V.6) is ~1.2x low for the
> same reason; the shares and the ranking are unaffected.

| instruction | bytes/site | share of emitted bytes |
|---|---|---|
| `CALL_Jq` | 205 | ~18 % |
| `MOV_GqEq` (load) | 120 | ~15 % |
| `RET_Op64` | 190 | ~4 % |
| `PUSH_Eq` | 133 | ~4 % |
| `POP_Eq` | 128 | ~6 % |
| `JMP_Jbq` | 114 | ~2 % |
| `MOV_EqGq` (store) | 50 | ~11 % |

Two thirds of all emitted code is **call/stack machinery and memory accesses**. Per-phase accounting
inside the emitter (added during the last round) attributes the rest: the cold-path **register spill**
alone was 16.6 % of all bytes before it was outlined, and the in-region transition was **255 bytes for
a two-byte `JMP rel8`**.

## 3. Simple programs: straight to wasm vs through the guest and AOT

Four micro-kernels (`work/fib/kernels.c`), each compiled twice from the same source: once to wasm with
clang (`-O2 -fno-unroll-loops`), once to x86-64 which the guest executes and the engine translates back
to wasm.

| kernel | x86 | native wasm, per iteration | AOT emitted | AOT module | emitted / x86 |
|---|---|---|---|---|---|
| `k_reg` — fib recurrence, registers only | 55 B | **12 instr** | 438 instr | 986 B | **18x** |
| `k_load` — sum an array (one load/iter) | 35 B | ~13 instr | 510 instr | 1,131 B | **32x** |
| `k_store` — fill an array (one store/iter) | 30 B | ~11 instr | 485 instr | 1,069 B | **36x** |
| `k_call` — one non-inlinable call/iter | 63 B | 12 + 3 instr | 691 instr | 1,558 B | **25x** |

**The AOT translation of a loop is 18-36x the size of the x86 it translates, and roughly 40x the native
wasm compiled from the same source.** Executed instructions tell a much better story than emitted ones
— the `k_reg` loop executes **20** wasm instructions per iteration against native's 12 — which is the
whole point: *almost everything we emit never runs at the site where it was emitted.*

### Why the difference exists

1. **Contingencies are inlined at every site.** A guest load emits: the index into the guest's own
   2048-entry DTLB, the `entry->lpf` compare that settles page identity, the pending alignment check
   and the span in one go, the `entry->accessBits` test that settles permission at this CPL and "real
   RAM with a host pointer" in one go, the write-stamp check, the access itself, a slow arm for either
   test failing, a fault arm that spills all guest state and calls a C++ helper, an async-event exit
   and a handler-step exit.
   Native wasm has none of this: the host TLB is the CPU's, and a trap is the engine's problem.
2. **We must be able to stop anywhere.** Every site is a potential trace boundary: an interrupt, a
   fault or a handler step can occur, and each requires committed guest state. Native code stops only
   where the compiler decided it could.
3. **x86 semantics carry flags and stack discipline.** An `add` sets six flags; a `call` writes a
   return address to the emulated stack and adjusts rsp. Native wasm has neither concept.
4. **Registers are locals, not registers.** A guest `mov` between registers is a real `local.get` +
   `local.set`; clang renames instead. Two of the 20 instructions in the `k_reg` loop are pure copies
   that a register allocator would delete.
5. **Cold and hot code get the same treatment.** This is the big one, and it is what section 4.1 fixes.

## 4. Proposals

### 4.1 Two-tier emission — 10x on bytes, MEASURED, and it does not buy speed

**Result: 84.9 -> 9.8 bytes per compiled guest instruction (8.7x); installed wasm for a codex session
7.23 MB -> 0.59 MB (12.2x).** (Both per-instruction figures come from the pass-1+pass-2 counter §2
corrects, so both absolutes are ~1.2x low; the ratio is what the claim rests on, and the installed-MB
pair -- measured on the module that is actually instantiated -- corroborates it independently.) Behind `NANOBOX_JIT_TIER=<mask>[:<promotion threshold>]`; unset, the
engine emits exactly what shipped. Gate green on both guests for tier-0-everywhere AND for two-tier
with promotion exercised.

Tier 0 emits, per guest instruction: `local.get 0` / `i32.const p` / `call $nanobox_t0_step` /
`br_if 0` = 9-10 bytes, uniform across every opcode (`MOV_GqEq` 120 -> 10, `CALL_Jq` 205 -> 9,
`RET_Op64` 189 -> 9, `PUSH_Eq` 133 -> 10, `MOV_EqGq` 49 -> 10). It has **no prologue at all** because it
keeps nothing in wasm locals -- no registers, flags, RIP or icount base. Neither RIP nor
icount needs to travel: on entry to instruction k, icount is already "retired before k" and RIP is
already the start of k, so the step is `prev_rip = RIP; RIP += ilen`.

**And it is slower than not compiling at all:**

| fib loop, n = 1e9, trace JIT | ns/iteration |
|---|---|
| tier 1 (what ships) | 2.14 / 2.15 |
| two-tier, promote at 2000 | 2.21 / 2.26 -- within 3 % |
| **pure interpreter (`--jit 0`)** | **34.27** |
| **tier 0** | **42.98 / 43.67** |

Tier 0 is 20x slower than tier 1 and **25 % slower than the interpreter**, because Bochs' chained
interpreter runs a whole trace on one dispatch while tier 0 pays a cross-module call per instruction.
A floor variant (one call per TRACE, 0.35 B/instruction, 45x smaller) converges on being the
interpreter and is still slightly worse than it. **The premise this section was written on -- "slower
per execution, but it only executes once" -- is false**: the compact call form is dominated by simply
leaving the code interpreted.

**The finding that matters more than the bytes.** Two configurations holding coverage and function
count constant (576.0 vs 574.3 M interpreted icount; 39,108 vs 40,271 installed functions) while
varying emitted bytes **6.8x** (56.43 -> 8.35 MB) show **no speed difference**: 79.9 vs 78.9 MIPS,
10.90 vs 10.89 s boot. TASKS.md J4 attributed its regression to "code explosion, 24.9 -> 61.2 MB".
**Byte volume is measurably not the mechanism.** What remains as the candidate is the number of
distinct compiled functions being dispatched.

So: keep tier 0 as a lever where BYTES are the constraint -- the browser `.nbjb`, the 191.6 MB kernel
artifact, memory footprint -- and do not enable it as a coverage policy, because the shipped
configuration is still the fastest thing measured. **10x per instruction WITH tier-1 speed is not
reachable in this emission model**: the hybrid middle (sharing only stack-refill, spill, exit and async)
is bounded by the phase table at ~1.6x. The closing guess of this section -- ~~the shape that reaches
both is a dense pre-decoded IR in linear memory~~ -- has been **measured, and it is wrong (TASKS.md
V.13)**: reading a pre-decoded opcode out of linear memory and dispatching it through an in-function
`br_table` costs 4.8-5.3 ns per guest instruction, about 60 % of the engine's whole 8.9 ns
per-instruction budget, before any work is done. That shape reaches SIZE -- which tier 0 already
does -- and not speed.

### 4.1b The original proposal, for the record

Emit **tier 0** by default: a compact *call form* per guest instruction — push immediates, `call` a
shared parameterised helper that performs the whole instruction including addressing, probing, access
and flags. That is 3-5 wasm instructions, ~8-14 bytes, against today's 50-205. Promote a site to
**tier 1** — today's inline template — only when it proves hot, using the hotness counter that already
drives compilation.

* Size: 85 B/instance -> **~10 B/instance** for the cold majority, which is most of the artifact.
* Speed: tier 0 is slower per execution; the bet is that code executed once or twice does not care, and
  the promotion path keeps hot code exactly as fast as today. **That bet must be measured, not assumed**
  (the benchmarks are listed in the prototype brief).
* Coverage: this is also the coverage lever — translating everything becomes affordable. `TASKS.md` T.5
  shows the current cost of trying: threshold 1 with function-scoped sweeps emits 187 MB and 26.7 s of
  boot because every path in every entered function gets the full inline treatment.

### 4.2 Per-instruction reductions that stand on their own

* ~~**The fault/exit arm** at every memory site is still inline. It is the same "private copy of shared
  machinery" pattern that yielded 43-46 % the last time a per-site inline sequence was replaced by one
  shared call.~~ **Measured — see
  TASKS.md V.10.** The arm is 31.8 % of every emitted byte (37 % of a load site, 42 % of `RET_Op64`),
  so the target was the right size; but the *machinery* in it is already shared — the slow arm, the
  handler step and the spill are each one call, and **99.4 % of exits take a spill-chain
  position**, so an exit's register spill is a `br` and nothing else. What is left inline is per-site
  DATA (the spilled values, the RIP offset, the icount delta), which cannot be outlined, only narrowed.
  `NANOBOX_FAULTARM=5` narrows what is narrowable: **-1.7 % of emitted bytes, speed flat**, gate green
  with the flag both off and on. The one piece left is packing the exit's RIP offset and icount delta
  into one constant (~-4 %), which requires rewriting the shared tail's contract.
* ~~**`RET` at 190 B** performs a guest memory read for a return address the direct-return path
  already knows.~~ **Tried and rejected -- see 4.7.** The read is not removable soundly, and the
  ceiling was -4.4 % of a session.
* ~~**`PUSH`/`POP`/`CALL`/`RET` pay general memory machinery** for stack slots on the most predictable
  page in the machine.~~ **Done -- see 4.6**, and it paid in speed (-33 % on AOT call+ret), not size.
* **Register copies**: eliminating the two `mov`s in the `k_reg` loop needs renaming, i.e. unrolling to
  the length of the register rotation — the only remaining item on the executed-instruction side.

### 4.3 Coverage: closing the headroom

Coverage is measured as artifact serve rate and residual interpretation. Today, with deterministic
forming and both artifacts: **kernel 66.8 %, user 68.0 % served, 1.3 M instructions interpreted**
against 203.9 M at the default threshold. The headroom is:

1. **Sweep scope** — a function-scoped sweep translates every path in a function while the guest runs a
   fraction of them. Per-function profile data in the artifact (which paths ran) would cut both the
   artifact and the region count; today's 90,634 region descriptors against 2,658 at the sane threshold
   is the size of the prize.
2. **First-execution interpretation** — 195,375 traces x 7.7 instructions = the 1.5 M residual.
   *Written as: every block's first execution is interpreted because compilation is triggered by that
   execution, so attaching a precompiled translation at decode time removes nearly all of it.*
   **Measured (TASKS.md V.8) and both halves are wrong.** `cpu_loop` calls `maybe_compile` BEFORE the
   first execution and a bundle hit attaches there synchronously, so a SERVED block is already compiled
   the first time it runs; the residual is the artifact MISSES, which decode-time attach cannot remove
   without compiling. Doing it anyway at the shipped threshold removes 42 % of interpretation and 70 %
   of runtime compilation and costs 1.9x the boot, because it pays R.5's ~400 ns cold-entry price on
   12.7 M trace executions.
3. **Untemplated instructions** — `STI`, `CLI`, `SYSCALL`, `CMPXCHG`, `XCHG`, `REP STOSD`, some SSE
   shuffles — go to a C++ handler *every* time they execute. This is the permanent floor unless they
   get templates.

### 4.6 The stack window: filed as a size item, delivered as a speed item

`NANOBOX_STACKTAG=<mask>` (default 0; bit 0 = PUSH/POP/CALL/RET/ENTER/LEAVE, bit 1 = also 8-byte
SS-segment operands, bit 2 = hoist the window base into a local; **5 = the recommended mask**). The
mask is its own flag word.

The emitted site reads the CPU's OWN stack window out of the CPU struct -- `espPageBias`,
`espPageWindowSize`, `espHostPtr`, the three fields `stack_read_qword`/`stack_write_qword` already use:
`biased = off + espPageBias; if (biased >= espPageWindowSize) biased = nanobox_stack_fill(off);` then
`espHostPtr + biased`. The window is already `4096-7`, so the page-fit test folds into that one compare:
no DTLB index, no entry tests, no offset compare. **No new invalidation was invented** -- the window is
invalidated by `invalidate_stack_cache()`, which paging.cc, proc_ctrl.cc, segment_ctrl_pro.cc,
tasking.cc, vm8086.cc and `serveICacheMiss` already call. The one engine edit outside the emitter is in
`cpu/stack.cc`: with the flag on, `stackPrefetch` closes the window when #AC is live or the page carries
iCache write stamps, so a page needing either never reaches the fast path.

| codex session | off | mask 5 | mask 7 |
|---|---|---|---|
| `PUSH_Eq` / `POP_Eq` | 133 / 128 | **108 / 102** | 108 / 102 |
| `CALL_Jq` / `RET_Op64` | 205 / 190 | **178 / 163** | 178 / 163 |
| emitted per instance (pass-1+2 counter, see §2) | 85.2 B | 81.4 B | 79.6 B |
| installed session wasm | 7.26 MB | 7.05 (-2.9 %) | 6.97 (-4.0 %) |
| **AOT call+ret, 100 M it** | **18.09 / 19.90 ns** | **12.75 / 12.67 ns (-33 %)** | |
| non-AOT call+ret | 35.54 / 36.72 ns | 31.33 / 31.29 ns (-13 %) | |

Mask 0 reproduces the shipping numbers exactly. Gates: flag off, RAM oracle -- identical + no
divergence; masks 5 and 7 under `--criteria heap+syscalls` -- identical on both guests, with
`ticks same, rip same` and **0 of 398 (codex) / 700 (agy) masked stack pages differing**, i.e. the mask
is dormant and is not carrying the verdict.

**Merged and turned on by default (mask 5), with the strongest available proof.** The reference engine
was NOT rebuilt, so the gate compared an optimized side that emits the new stack window against a
reference that does not have it: `IDENTITY: identical (codex + agy)`, `BISECT: no divergence`.
`NANOBOX_STACKTAG=0` restores the pre-merge emission exactly. Reproduced on the merged `build/eh-nb`,
interleaved: AOT call+ret **17.91 / 18.27 -> 12.32 / 12.03 ns (-32.6 %)**, non-AOT 33.77 / 35.34 ->
30.96 / 29.88, fib (register-only control) 2.14-2.18 either way. Codex session, two pairs: installed
wasm **7.34 -> 7.11 MB (-3.1 %)**, boot 6.05 / 6.23 -> 5.94 / 5.90 s, MIPS 110.3 / 108.9 -> 114.3 /
112.0. Only the wasm figure clears the noise floor at session level (+-4 % MIPS, +-8 % boot); the
claimable win is the microbenchmark, and the session numbers are reported here
as consistent-with rather than as evidence.

**Two things this corrects.** The byte prediction (~33 B/site) was optimistic: 25-27 delivered, -4 % of
emitted bytes, so filing this under "size" undersold it -- what it actually removed is T.6's stated
residual, `call.x86`'s two stack accesses paying the general memory path on every iteration (the DTLB
index and both inline entry tests) where the CPU's own window settles the address in a single compare.
Nothing but `invalidate_stack_cache()` closes that window -- neither a returning direct call nor a
handler step does. And the remaining 178 B of `CALL_Jq` / 163 B of `RET_Op64` are exit/deopt/direct-call machinery, **not** the
memory access -- which is where items 5 and 7 have to aim.

### 4.7 The return-address store: measured, unsound, and it would not have paid

Filed as newly legal under the new oracle (section 5): with stacks out of the comparison, the bytes
`CALL` writes need not be observable -- **provided nothing else reads them**. That proviso is the whole
result. Measured on a real codex session with the guest unmodified, so its own stack is ground truth
(`nanobox_jit_flags` bit 11, pure bookkeeping: record `{rsp_after, return VA, cr3}` on a host shadow
stack AND still store, then report at each RET):

* 16.8 M CALL pushes; **69.1 %** of 21.7 M RETs found a shadow entry matching RSP;
* of those apparent partner hits, **0.166 % carry a return address that differs from what the guest
  actually has** (0.55 % on the call kernel) -- **an RSP match is not proof of partnership**: retpoline
  thunks do `mov %rax,(%rsp); ret`, and unmatched entries alias by address after longjmp/unwinding;
* **1.22 %** of pairs had the slot read or written by other guest code in between; 1.18 M reads and
  0.98 M writes of still-deferred slots, 1.67 M of them of a non-innermost frame.

**Every** eliding configuration hangs the guest before the shell prints anything, spinning on
PAUSE/LFENCE/RDTSCP -- the retpoline speculation trap, the signature of a return landing in the wrong
place. That includes write-always flush, watch-and-materialise-on-touch, direct-call pairing (bit 15,
where the shadow is paired with the wasm call rather than with RSP) and no-exception-flush. Closing the
read hole needs a check on **every** guest memory access, which costs more than the elision buys.

And what it buys is small: with the shadow push outlined (bit 17) `CALL_Jq` 567 -> 473 B (-16.6 %) and
`RET_Op64` 350 -> 311 B (-11.1 %), a ceiling of **0.64 MB of 14.6 MB = -4.4 %** of a session. Escapes
were handled, not ignored (`nanobox_cold_sync`, `nanobox_helper_sync`, `helper_step_pre`, the top of
cpu_loop's trace loop, `exception()`/`interrupt()`, a RET whose entry is not its partner, direct-call
unwind) -- that is what the earlier `NANOBOX_AOT_NOSTACK` attempt lacked, and it still hangs.

Gate, reported as a failure rather than worked around: flag off, RAM oracle -- `identical`, `no
divergence`; flag on under `--criteria heap+syscalls` -- `DIFFERENT` / `DIVERGENCE`, **not** because
pages or syscalls differ but because the optimized side never reaches the prompt. Stated residual: in
the direct-call-paired configuration nearly every address is materialised before use (5,605 shadow hits
against 48.97 M outlined RET reads) and it still hangs, so a defect in the deferral machinery cannot be
excluded on top of the measured unsoundness. It does not change the verdict.

**Item 7 is rejected, not deferred.** Together with 4.6 this settles the two costly opcodes: the
majority of `CALL_Jq` and `RET_Op64` is exit/deopt/direct-call machinery, not the memory access.

### 4.4 Cache loading -- measured, and the premise had gone stale

**The 1.5 s figure this section was briefed with no longer exists.** Today's size work shrank a
self-recorded codex artifact to **5.5 MB / 773 modules** (harness) and 7.6 MB / 1,101 modules (browser),
mean module **6.8-7.0 KB with ~4.5-4.9 functions**; the ~250 KB batch modules come from eager-sweep AOT
recordings, not from what a normal run records or replays. Real cost: **~180 ms in the harness, ~110 ms
in the browser**.

Attribution (harness, default lazy): read 1.6-1.9 ms, index parse 3-6 ms, key map 3.5-8.6 ms -- all
before the VM starts -- then on the **VM thread**: `new WebAssembly.Module` x771 **101-125 ms**,
`Instance` x771 31-38 ms, imports 4.5-7.1 ms, exports 3.4-4.8 ms, slots 7.6-9.2 ms. **65 % is one
synchronous compile per touched module while the guest waits.**

Shipped, flag-gated: `NANOBOX_BUNDLE_EAGER=auto` compiles the whole artifact up front when it is under
`NANOBOX_BUNDLE_EAGER_MB` (64) -- **19-21 ms in parallel instead of 101-125 ms serialized on the VM
thread** -- and `NANOBOX_CACHEPROF=1` prints the attribution. Harness codex boot: 5,783 -> **5,704 ms**,
cache load **-45 %**. In the browser, `?jitfast=1` memoizes the engine tag per engine-URL+ETag and runs
fetch/decode/compile speculatively (adoption still gated on the tag computed from the real engine
bytes): a wash on localhost, but it removes 84-87 ms of serialized work and **1.85 MB of transfer**
(`kernel.nbjb` is fetched and refused on every load because the harness records full-engine bundles
while the sandbox runs slim) -- ~1.5 s at 10 Mbit/s.

Rejected by the profile, each with a number: `compileStreaming` (N modules, not one stream), dedupe
(8 duplicates of 1,101), a leaner index (3-7 ms total), an IndexedDB compiled-module cache (buys <=45 ms
that is already hideable), granularity re-tuning (the whole artifact compiles in 19-28 ms in parallel).

**Operational finding worth keeping**: closing the sandbox tab at the sign-in screen leaves codex's
sqlite damaged, so the NEXT codex run dies in "state db backfill". That is the intermittent boot
failure seen all day; loops that run codex repeatedly should wipe `/root/.codex` first.

## 5. The new identity criteria, and what they unlock

Old: tick count + SHA-256 of **all** guest RAM must match the reference interpreter.
**New: heap content and the syscall stream must match; call-stack contents need not.**

This is a genuine relaxation, and it makes several things legal that were not:

* **Return addresses need not be materialised eagerly.** Today `CALL` writes the return address through
  the full memory path. With stacks excluded from the comparison, deferring or eliding that store is no
  longer an identity failure — it remains a *correctness* question (a guest unwinder reads those bytes),
  so the guard becomes "does the guest still work", which the syscall trace measures directly.
* **Dead spills disappear.** Any register spilled to the stack purely so the reference would see it can
  go.
* **Stack layout may differ**: padding, red-zone use, the order of pushes in a prologue.

### 5.1 The new oracle, as built and proved

`./test/gate.sh --criteria heap+syscalls` (shipped, flag-gated; the default gate is untouched).

**"Stack" is defined by the CPU, not by an address range**: a guest-physical page is a stack page iff
`BX_CPU_C::stackPrefetch()` resolved the stack window to it. Bochs funnels PUSH/POP/CALL/RET/ENTER/
LEAVE, interrupt and exception frames, IRET and task switches through that path, so the definition
follows the architecture rather than a heuristic. **Correction (V.6):** this section originally also
claimed the decoder's SS-segment MOV forms (plain `mov …(%rsp)` frame slots). It does not in 64-bit
code -- `assignHandler` redirects only `BX_IA_MOV_Op32_{GdEd,EdGd}`, and `MOV64S_EqGqM`/`MOV64S_GqEqM`
in `cpu/data_xfer64.cc` are dead code with no opcode assigning them. The mask is unaffected in
practice (any stack page is also pushed to), and the error is in the conservative direction: fewer
pages masked, not more. Measured on codex: **398 pages masked = 1.6 MiB of 226 MiB (0.69 %)**;
261,746 of 262,144 pages are still compared. Attribution: 319 user stacks, 67 vmalloc/VMAP_STACK kernel
stacks including the IRQ stack, 10 boot stacks, `init_thread_union`, `cpu_entry_area`.

Two guards, both with numbers: an `[RSP-4096, RSP+128 KiB)` proximity test (`--stack-span`) so an
RBP-as-data-pointer cannot mask a rodata page (it removes 1 page of 399 here), and a per-page
"last used as stack" sequence so pages freed and recycled as heap come back into the comparison. **The
mask is taken from the REFERENCE side only** — the engine under test cannot excuse a page by calling
it a stack.

The syscall trace hooks `SYSCALL`/`SYSRET` (never inlined by the JIT — they are trace-terminating, so
the same handler runs interpreted, JIT'd or AOT'd): `S seq nr a0..a5 rip`, `R seq rax`, plus a `W` line
with length, FNV-1a and the first 48 bytes for `write`/`pwrite64`/`sendto`/`writev`. codex: 18,053
calls, 1,246 payloads. Stated gap: 159 syscalls return via IRET and have no `R` line.

**Proof it is not weaker where it matters.** T.1's real miscompile was reintroduced deliberately
(32-byte AVX probes folded onto the 16-byte helper):

| guest | pair | RAM oracle | heap+syscalls |
|---|---|---|---|
| codex | ref vs current | identical | identical |
| codex | ref vs **broken** | identical | identical |
| agy | ref vs current | identical | identical |
| agy | ref vs **broken** | **DIFFERENT** | **DIFFERENT** |

On broken agy it reports 38,697 NON-stack pages differing (so the mask is not carrying the verdict) and
pinpoints the divergence in the syscall stream: after `nanosleep` the reference takes the return while
the broken engine issues `sched_getcpu` from a different RIP. On a correct engine 0 masked pages differ
— the mask is dormant. Cost: **1m15.7 s against the RAM oracle's 1m15.6 s**, i.e. free.

**Caveat, and it is worse than this section first stated.** It was written as: for an AOT engine whose
tick count legitimately differs, the heap half fails for non-bug reasons and *the syscall trace becomes
the load-bearing half*. **Measured (TASKS.md V.8): the syscall half fails too.** A flag-on AOT run and
its flag-UNSET control fail byte-identically — same `SYSCALLS: DIFFER at trace line 77`, same `mmap`
hint `2e286c000000` vs `1e26b0000000` — because the guest derives addresses from the tick count. So
**neither half survives a legitimate tick difference, and this oracle cannot validate an AOT-mode engine
on this image as built.**

What that costs and what it needs: today an AOT-mode change can only be validated by the guest-exactness
kernels plus "does the workload still run", which is weaker than either oracle. Making it usable needs
the syscall comparison to be *normalised* rather than literal — canonicalise addresses the guest derived
from timing (mmap hints, ASLR offsets, `brk` results) to a per-run symbolic name and compare the
structure, or record the reference's tick stream and drive the AOT side from it. Until then, section 6's
"flag on, gate under `--criteria heap+syscalls`" step is only meaningful for engines whose ticks match
the reference — which is every non-AOT flag in this document, and none of the AOT ones.

**Superseded by item 12 (TASKS.md V.12, 2026-08-19).** The second route named above — "record the
reference's tick stream and drive the AOT side from it" — turned out to be unnecessary: AOT's ticks
differ only because three boundary decisions moved, and putting them back (`NANOBOX_TICKEXACT=11`,
default 0) makes an AOT-mode engine tick-exact. `./test/gate.sh` then reports `IDENTITY: identical
(codex + agy)` under the plain `ram` criteria, so this section's caveat no longer binds: with the
mask on, all three oracles apply to an AOT engine unchanged.

The risk it introduces is equally real: **the old oracle is what caught a silent miscompile today** (a
32-byte AVX probe using the 16-byte helper — codex identical, agy DIFFERENT). The new oracle must be
demonstrably at least as sharp on everything that is not stack bytes, which is why the implementation
brief requires proving it *fails* on a deliberately broken engine before it is trusted.

## 6. Plan, in order

| # | item | expected effect | flag | state |
|---|---|---|---|---|
| 1 | New oracle: heap + syscall-trace comparison, both guests | unblocks everything below | `--criteria heap+syscalls` | **DONE, see 5.1** |
| 2 | Two-tier emission, tier 0 for cold sites | **85 -> 9.8 B/instance achieved**; costs 20x speed where used | `NANOBOX_JIT_TIER` | **DONE, see 4.1** |
| 3 | Cache load profile and fixes | measured at 180 ms, not 1.5 s; -45 % of it | `NANOBOX_BUNDLE_EAGER=auto`, `?jitfast=1` | **DONE, see 4.4** |
| 4 | Attach precompiled translations at decode time | **-42 % interpretation, -70 % runtime compilation, and 1.9x the boot: does NOT pay** | `NANOBOX_ATTACH` | **DONE (rejected), see TASKS.md V.8** |
| 5 | Outline the per-site fault/exit arm | **31.8 % of emitted bytes, but already outlined; narrowing what is left is -1.7 %** | `NANOBOX_FAULTARM` | **DONE (measured), merged default OFF, see TASKS.md V.10** |
| 6 | Dedicated stack window for push/pop/call/ret | **-33 % on call+ret**; bytes only -4 % | `NANOBOX_STACKTAG` | **DONE, see 4.6** |
| 7 | Defer/elide the return-address store | **rejected**: unsound (guest hangs), ceiling only -4.4 % | `nanobox_jit_flags` 11-17 | **MEASURED AND REJECTED, see 4.7** |
| 8 | Per-function profile data in the artifact | **<=22 % of what #4 would have needed**; the runtime hotness counter already predicts repetition better | artifact format | **demoted by V.8** |
| 9 | Register renaming via rotation unrolling | the last 2 executed instructions in `k_reg` | AOT-only bit | last |
| 10 | A tick-insensitive syscall comparison, so AOT engines can be gated at all | **shipped and proved sharp (4,636/4,637 injected mutations caught, broken engine still DIFFERENT); it does NOT unblock AOT on these images** — the guests render elapsed time, so 585/1,246 write payloads differ legitimately | `--criteria heap+syscalls-norm` | **DONE, see TASKS.md V.9** |
| 11 | Re-entrant `nanobox_jit_cache_clear` frees its own caller's regions | **a real crash in the SHIPPED engine, not a threshold-1 defect**; fixed, no cost, on by default | `NANOBOX_JITCLEARFIX` (default 1) | **DONE (fixed + merged), see TASKS.md V.11** |
| 12 | **Make AOT mode tick-exact** instead of relaxing the oracle further | **DONE: `./test/gate.sh` with the plain `ram` criteria reports `IDENTITY: identical (codex + agy)` for an `NANOBOX_AOT=1` engine.** Three boundary decisions had to come back (self-loop window, forward in-region edges, direct calls); costs 1.9x on a tight loop and **nothing measurable on the workload** (boot flat, MIPS +2 %, emitted code −8 %) | `NANOBOX_TICKEXACT=11`, default 0 | **DONE, see TASKS.md V.12** |
| 13 | **Test the one surviving speed hypothesis: the NUMBER of distinct compiled functions** | **REFUTED. 15.9x more live wasm functions (5,249 -> 83,472) at constant coverage, entries, bytes compiled and compile cost = null (boot +1.6 %, MIPS -2.2 %); 1.86x more DISPATCHED distinct functions = null; a `call_indirect` is flat at 8.9-9.0 ns from 6 to 65,536 live callees. What predicts the time is the number of ENTRIES, and 9 ns of the ~400 ns an entry costs is the call -- the rest is per-boundary state materialisation** | `NANOBOX_FNDUP` (default 0) | **DONE (refuted), see TASKS.md V.13** |

| 14 | **Fewer boundaries**: the limiter on region size is the successor rules, not `NB_REGION_MAX_BLOCKS` (the 24-block cap never binds, mean 2.67 blocks/region) | ~400 ns per entry x 5.9 M entries a session | region forming | **new, first of the three levers V.13 leaves standing** |
| 15 | **Carry less state across a boundary**: ~390 of the ~400 ns is prologue/epilogue state materialisation, not the call (9 ns) | the same 5.9 M entries | AOT-only bit | **new** |
| 16 | **Pack translations into fewer MODULES**: a direct call inside one module is inlined by V8 at **0.00 ns**, against 8.9 ns through the table | removes the call half of an entry where it applies | module granularity | **new** |

| 17 | The page-eager sweep gave the region former the CPU's current RIP as every swept entry's linear base | **fixed**: swept regions pulled blocks from the wrong page offsets, so every bundle recorded Aug 18 18:00 - Aug 19 15:30 was a partial written at a timeout | none (recording path) | **DONE (fixed + merged), see TASKS.md V.15** |

| 18 | **Address resolution indexes the guest's own 2048-entry DTLB inline at every memory site** — one compare of `entry->lpf` against `la & (LPF_MASK \| (acm & (size-1)))` settles page identity, the pending alignment check and the span together (the index is built from `la + size-1`), and one test of `entry->accessBits & (bit << user_pl)` settles both permission at this CPL and "real RAM with a host pointer"; either failing branches to the site's slow arm | **99.8 % of `MOV_GqEq` accesses are served by the inline test**, and the slow arm's reason is "another page frame" in essentially all of the rest. Nothing travels between translations. Costs bytes: **73.3 B of a 154.9 B load site** is `addr-resolve`, at 113.4 emitted bytes per guest instruction overall | none (unconditional) | **DONE, see TASKS.md section V** |

**Standing rules for this phase**: every change behind a flag so it can be A/B'd inside one binary;
every claim measured at n = 1e9 for loops and with both guests for correctness; a null A/B is assumed
to be a bug in the experiment until proven otherwise (it was, twice, today).

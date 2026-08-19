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

1. **Contingencies are inlined at every site.** A guest load emits: two probe-cache candidate checks,
   the full DTLB lookup, the probe-cache refill, the write-stamp check, the access itself, a fault arm
   that spills all guest state and calls a C++ helper, an async-event exit and a handler-step exit.
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
7.23 MB -> 0.59 MB (12.2x).** Behind `NANOBOX_JIT_TIER=<mask>[:<promotion threshold>]`; unset, the
engine emits exactly what shipped. Gate green on both guests for tier-0-everywhere AND for two-tier
with promotion exercised.

Tier 0 emits, per guest instruction: `local.get 0` / `i32.const p` / `call $nanobox_t0_step` /
`br_if 0` = 9-10 bytes, uniform across every opcode (`MOV_GqEq` 120 -> 10, `CALL_Jq` 205 -> 9,
`RET_Op64` 189 -> 9, `PUSH_Eq` 133 -> 10, `MOV_EqGq` 49 -> 10). It has **no prologue at all** because it
keeps nothing in wasm locals -- no registers, flags, probe cache, RIP or icount base. Neither RIP nor
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
reachable in this emission model**: the hybrid middle (sharing only probe-miss, spill, exit and async)
is bounded by the phase table at ~1.6x, and the shape that reaches both is a dense pre-decoded IR in
linear memory.

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

* **The fault/exit arm** at every memory site is still inline. It is the same "private copy of shared
  machinery" pattern that yielded 43-46 % when applied to the DTLB miss path.
* **`RET` at 190 B** still performs a guest memory read for a return address the direct-return path
  already knows. Under the new identity criteria (section 5) this becomes far easier to attack.
* **`PUSH`/`POP`/`CALL`/`RET` pay general memory machinery** for stack slots on the most predictable
  page in the machine. A dedicated stack-page tag collapses four of the six most expensive opcodes.
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
2. **First-execution interpretation** — 195,375 traces x 7.7 instructions = the 1.5 M residual. Every
   block's first execution is interpreted because compilation is triggered *by* that execution.
   **Attaching a precompiled translation at decode time** (in `serveICacheMiss`, before the block runs)
   removes nearly all of it, and is only possible now that keys match at 99.9 %.
3. **Untemplated instructions** — `STI`, `CLI`, `SYSCALL`, `CMPXCHG`, `XCHG`, `REP STOSD`, some SSE
   shuffles — go to a C++ handler *every* time they execute. This is the permanent floor unless they
   get templates.

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
LEAVE, interrupt and exception frames, IRET, task switches *and* the decoder's SS-segment MOV forms
(plain `mov …(%rsp)/(%rbp)` frame slots) through that path, so the definition follows the architecture
rather than a heuristic. Measured on codex: **398 pages masked = 1.6 MiB of 226 MiB (0.69 %)**;
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

**Caveat that will matter soon**: for an AOT engine whose tick count legitimately differs from the
reference, the heap half will fail for non-bug reasons (timer-derived kernel state), and **the syscall
trace becomes the load-bearing half**.

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
| 4 | Attach precompiled translations at decode time | interpretation 1.5 M -> ~the handler floor | AOT-only bit | next |
| 5 | Outline the per-site fault/exit arm | another large slice of memory-site bytes | `nanobox_jit_outline` bit | next |
| 6 | Dedicated stack-page tag for push/pop/call/ret | collapses 4 of the 6 costliest opcodes | outline bit | next |
| 7 | Defer/elide the return-address store (needs #1) | `RET` 190 B -> tens | AOT-only bit | after #1 |
| 8 | Per-function profile data in the artifact | cuts sweep scope, region count, artifact size | artifact format | after #2 |
| 9 | Register renaming via rotation unrolling | the last 2 executed instructions in `k_reg` | AOT-only bit | last |

**Standing rules for this phase**: every change behind a flag so it can be A/B'd inside one binary;
every claim measured at n = 1e9 for loops and with both guests for correctness; a null A/B is assumed
to be a bug in the experiment until proven otherwise (it was, twice, today).

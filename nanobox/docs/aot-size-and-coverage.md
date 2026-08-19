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

### 4.1 Two-tier emission — the 10x size lever (prototype in flight, `work/j/tier`)

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

### 4.4 Cache loading (profile in flight)

Artifact load is ~200 ms of index parse plus ~1.3 s to compile and instantiate the modules a boot
touches, on a ~6.4-7.4 s boot. Levers: module granularity (batches of ~13 functions mean touching one
function compiles ~250 KB), `compileStreaming` in the browser, caching compiled modules in IndexedDB/
OPFS so a second visit skips compilation, and a leaner index.

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
| 2 | Two-tier emission, tier 0 for cold sites | **85 -> ~10 B/instance** | `nanobox_set_jit_tier` | in flight |
| 3 | Cache load profile and fixes | ~1.5 s off a cold boot | query param / env | in flight |
| 4 | Attach precompiled translations at decode time | interpretation 1.5 M -> ~the handler floor | AOT-only bit | next |
| 5 | Outline the per-site fault/exit arm | another large slice of memory-site bytes | `nanobox_jit_outline` bit | next |
| 6 | Dedicated stack-page tag for push/pop/call/ret | collapses 4 of the 6 costliest opcodes | outline bit | next |
| 7 | Defer/elide the return-address store (needs #1) | `RET` 190 B -> tens | AOT-only bit | after #1 |
| 8 | Per-function profile data in the artifact | cuts sweep scope, region count, artifact size | artifact format | after #2 |
| 9 | Register renaming via rotation unrolling | the last 2 executed instructions in `k_reg` | AOT-only bit | last |

**Standing rules for this phase**: every change behind a flag so it can be A/B'd inside one binary;
every claim measured at n = 1e9 for loops and with both guests for correctness; a null A/B is assumed
to be a bug in the experiment until proven otherwise (it was, twice, today).

# Where the guest's data accesses land, and the direct-map window they motivated

## Where the guest's data accesses actually land: the "one contiguous region" premise is false, and the direct-map window it motivated pays 13 % of emitted bytes for 15 % of the probes (2026-08-23, `work/j/addropts`, `NANOBOX_ADDRCENSUS`, `NANOBOX_DMAP`)

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

---

## Reproducing this

The engine sources are under the gitignored `work/j/addropts/bochs/` (a copy of `bochs/`, which was
never touched); `work/j/addropts/addropts.patch` next to this document is the self-contained diff
against `bochs/bochs/`. Rebuild with:

```
BX_SRC=$PWD/work/j/addropts/bochs/bochs ./build-bochs.sh addropts        --pack work/pack-out-nb/pack
BX_SRC=$PWD/work/j/addropts/bochs/bochs ./build-bochs.sh addropts-nowiz  --no-wizer --pack work/pack-out-nb/pack
```

`harness/run.mjs` needs three additive hooks, which are in the working tree but not committed here
(the file carries other in-flight work). They are, verbatim:

1. after the `@bjorn3/browser_wasi_shim` import — the report module is loaded only when the census
   is on, so the path under `work/` is never required otherwise:

```js
const addrCensusReport = process.env.NANOBOX_ADDRCENSUS ? (await import("../work/j/addropts/addrcensus-report.mjs")).addrCensusReport : null;
```

2. in `installJitHost`, next to the other `NANOBOX_*` setters:

```js
if (process.env.NANOBOX_DMAP != null && ex.nanobox_set_jit_dmap) { const got = ex.nanobox_set_jit_dmap(Number(process.env.NANOBOX_DMAP)); console.error(`[harness] JIT direct-map window mask ${process.env.NANOBOX_DMAP} -> accepted ${got}`); }
if (process.env.NANOBOX_ADDRCENSUS != null && ex.nanobox_set_addrcensus) { ex.nanobox_set_addrcensus(Number(process.env.NANOBOX_ADDRCENSUS)); console.error(`[harness] JIT address census ${process.env.NANOBOX_ADDRCENSUS}`); }
```

3. in `finish()`, before the `opts.tplBytes` block:

```js
if (addrCensusReport && inst && inst.exports.nanobox_jit_addrstat) console.error(addrCensusReport(inst.exports));
if (inst && inst.exports.nanobox_jit_dmap_stat) {
  const h = inst.exports.nanobox_jit_dmap_stat(0), m = inst.exports.nanobox_jit_dmap_stat(1);
  if (h + m) console.error(`[harness] direct-map window: ${h} hits / ${h + m} probed accesses (${(100 * h / (h + m)).toFixed(2)}%)`);
}
```

Then, for the census:

```
cd harness && NANOBOX_ADDRCENSUS=1 node run.mjs ../build/addropts/out.wasm \
  --oci http://localhost:8093/c2w/images/codex/ --spec ../web/images/codex/config.json \
  --oci-cache ../work/oci-cache --quiet --no-hash --jit 3:2000 \
  --cmd /usr/local/bin/codex --expect "Press enter to continue" --timeout 25
```

and for the window, on the `-nowiz` engine only, `NANOBOX_DMAP=3` (bit 0 identity block placement +
bit 1 the window arm), `=1` for the placement alone, `=7` for a reads-only window.

The identity A/B has to be flag-vs-flag on the SAME engine, because bit 0 changes
`blocks.allocated` and `test/identity.sh` reports that as a difference:

```
cd harness
NANOBOX_DMAP=1 node run.mjs ../build/addropts-nowiz/out.wasm --oci .../codex/ --spec ... \
  --cmd /usr/local/bin/codex --reply "do you trust|trust the files=\r" \
  --expect "Press enter to continue" --quiet --jit 2:2000 > ../work/identity/codex-dmap0.log 2>&1
NANOBOX_DMAP=3 node run.mjs ... > ../work/identity/codex-dmap1.log 2>&1
node compare.mjs ../work/identity/codex-dmap0.log ../work/identity/codex-dmap1.log
```

This document is also appended to `TASKS.md` as section V.26 in the working tree.

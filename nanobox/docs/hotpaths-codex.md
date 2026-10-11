# Where the time goes: codex boot → sign-in on the optimized engine (2026-08-16)

Read-only investigation of the `build/eh-nb` engine (JIT `2:2000`, harness, OCI cache) booting the
codex container to "Press enter to continue". Every number below was measured in this session; the
raw outputs and helper scripts live in `work/prof/hotpaths/` (listed at the end). Wall times are
from a shared 8-core box with the other bots' Chrome renderers running (load 2.7–5.3), so absolute
times wobble by ±0.4 s; instruction/trace counters are exact and reproducible run-to-run.

## Executive summary

1. The run is **6.2–6.9 s** wall (harness, JIT 2:2000); of that **0.30 s** is harness/host setup, **0.9 s**
   is the guest kernel resuming from the wizer snapshot + `runc` (52 M instr), and **5.2 s** is the codex
   process itself (582 M instr). The 9p device path for the 138 MB the guest reads costs only **~0.1 s** host-side.
2. **The JIT contributes only 0.8 s (11 %)**: interpreter-only (`--jit 0`) reaches sign-in in **6.93–6.99 s**,
   JIT 2:2000 in **6.16–6.18 s** (same minute, back-to-back). The engine runs this workload at ~94 MIPS.
3. Profile (interpreter): Bochs handlers 55 %, `cpu_loop` 19 % (14 ns per trace boundary, 96 M boundaries),
   decode/iCache misses 9–12 %, TLB/paging 9 %, everything else (devices, host, JS) < 5 %.
4. At threshold 2000 the JIT'd traces execute **60 % of the instructions** in **24 % of the time** (4.6 ns/instr);
   the interpreted 40 % take ~65 %. Lowering the threshold to 200 raises JIT coverage to 85 % but makes the run
   **2.2 s slower** (9.1 vs 6.9 s): lukewarm JIT'd traces cost ~13 ns/instr (89 ns per 6.9-instr trace), i.e.
   **worse than the interpreter** (~6.4 ns/instr + 14 ns/trace). Per-trace fixed cost + code bloat
   (~200 B of wasm, ~1.8 KB per trace even for a `jmp`) is the JIT's real limit, not compile time (0.2–0.3 s).
5. Hot translations are lost and re-attached **180 K times per run (~124× per hot trace)**: the iCache is
   direct-mapped on `pAddr & 0xFFFF` (64 K entries) and every wrap of the 576 K-slot instruction pool flushes
   *everything* (and zeroes every `hot` counter). Simulation on a 400 K-trace window: 1.3 % (kernel) /
   0.7 % (user) of trace executions collide; 4.8 % / 1.9 % of executions are decodes. This is what creates
   the interpreter tail (`linkFail[4]` = 10 M returns "next trace not compiled") and ~0.9 s of decode.
6. Guest hot code (fixed by memory identity, cannot be changed): kernel = page-cache/xarray/fault-around
   for the 138 MB of the 258 MB codex binary read on demand (94 % kernel in 1.2–2.1 s); user = OpenSSL PEM/base64
   (`EVP_DecodeUpdate`, 6.3 % of ALL instructions in one page) + ASN.1/X509 (`crypto/asn1/tasn_*.c`) + musl
   `malloc`/`memchr` — codex parses `/etc/ssl/certs/ca-certificates.crt` **five times** (2.2 s of the 6.4 s).
7. 31–43 % of trace transitions cross a 4 KiB page (`linkFail[2]` 21.9 M refills of 46.9 M links).
8. Ranked levers (§5): (1) keep hotness across evictions + bigger/associative iCache + no full flush
   [−0.5…0.8 s, low risk]; (2) make short JIT'd traces cheap (successor cache instead of iCache hash lookup, out-of-line
   out-of-line address resolution) so the threshold can drop to ~200 with 85 % coverage
   [−1.0…1.5 s, medium]; (3) later wizer snapshot [≤0.3 s]; the rest is < 0.2 s each.
9. Reaching < 6 s in the browser needs ~1 s: (1)+(2) together are the only path with that headroom; nothing on the
   host/9p/OCI side is worth more than 0.15 s.
10. Level-3 (`--jit 3:*`) counters cannot be combined with bundles (the level is part of the content key: 0 bundle hits);
    the shipped `kernel.nbjb + codex.nbjb` do work at level 2 (1372 hits / 48 misses).

## 1. Method

```
cd harness
timeout 28 node run.mjs ../build/eh-nb/out.wasm --oci http://localhost:8093/c2w/images/codex/ \
  --spec ../web/images/codex/config.json --oci-cache ../work/oci-cache --cmd /usr/local/bin/codex \
  --expect "Press enter to continue" --quiet --no-hash --timeout 26 [--jit L:T] [--pages F --focus PAGE:F] \
  [--save-phys ADDR:F] [--dbg 2:0:FROM:TO --dbg-out F] [--jit-bundle ...]
```
* Timeline: `work/prof/hotpaths/timeline.mjs` (spawns run.mjs, timestamps stdout/stderr) with `NANOBOX_FS_LOG=1`
  (every 9p→WASI call of the in-memory rootfs is logged, so `path_open`/`fd_pread` give the phase boundaries).
* CPU profiles: `node --cpu-prof --cpu-prof-interval 250` on the *named* build `build/eh-prof` (04:45 build, has
  the wasm name section; the same run takes 7.4 s there vs 6.2–6.9 s on `eh-nb`, identical guest counters) → categorised
  with `work/prof/hotpaths/profcat.mjs`. Category shares are indicative for eh-nb; the JIT itself changed after 04:45.
* Guest hot spots: `--pages` at `--timeout 1.2 / 2.1 / 4.2` and at the end → `pagesdiff.mjs` (per-phase deltas),
  `--focus` histograms, `--save-phys` of the hot physical pages → located in `codex.bin` (extracted from the OCI cache
  tar; PIE, load base `0x7f1bf4126000`, `.text` = 201 MB, stripped) with `findoff.mjs` → `objdump -d`.
* Trace-level statistics: `--dbg 2:0:FROM:TO` per-trace log over two 400 K-trace windows (kernel-heavy at trace
  #82.0 M ≈ t 1.25 s; user-heavy at #140.0 M ≈ t 4.9 s) → `dbgstats.mjs` (distinct traces, hotness, direct-mapped
  iCache simulation), `dbgflips.mjs` (translation losses).

## 2. Time budget

### 2.1 Phases (harness, JIT 2:2000, from the FS-log timeline; `wallMs` at EXPECT 6.4–6.7 s in these runs)

| phase | wall | guest instr | MIPS | kernel / user | what happens |
|---|---|---|---|---|---|
| A host setup | 0.00–0.30 s | – | – | – | OCI cache load 0.126 s (264 MB from 3 tars, untar 3 ms), `WebAssembly.compile`+instantiate of the 116 MB engine ~0.1 s, JIT host install |
| B kernel resume + init + runc | 0.30–1.215 s (0.9 s) | 52.2 M | 58 | 60 % / 40 % (runc, Go) | wizer snapshot is at icount 468.98 M; first bundle access (`config.json`) at 0.62 s; `path_open rootfs/usr/local/bin/codex` at 1.215 s = execve |
| C codex load | 1.215–2.1 s (0.9 s) | 64.0 M | 71 | **94 % / 6 %** | 186 × 512 KiB `fd_pread` of the codex binary in 0.87 s (93 MB); kernel page-cache fill, fault-around, PTE work: 15.4 instr/trace |
| D codex init | 2.1–4.2 s (2.1 s) | 189.5 M | 90 | 40 % / 60 % | first cert-bundle parse (open 2.253 → close 2.767), first terminal output at 4.26 s |
| E codex UI up | 4.2–6.4 s (2.2 s) | 324.0 M | 147 | 23 % / 77 % | `ca-certificates.crt` opened 4 more times (4.206–4.599, 4.634–5.029, 5.299–5.982, 5.524–6.176), sign-in screen at 6.41 s |
| total | 6.4 s | 634.3 M (1103.25 M − 468.98 M) | 99 | 38 % / 62 % | 95.75 M trace boundaries (`stats.traces` 168.40 M − 72.65 M in the snapshot) |

Codex has a cert file open for 2.18 s of the 6.4 s (union of the five windows) — that is where its user-mode
hot spots (§3.2) come from. `fs` stats at the end: 19 opens, 337 reads, **137.9 MB read** (of the 258 MB binary; the
rest of the binary is never touched), 64 stats.

### 2.2 CPU profile categories (named build eh-prof, `--cpu-prof-interval 250`, whole process)

| category | interpreter only (`--jit 0`, 7.27 s sampled) | JIT 2:2000 (7.46 s) | JIT 2:200 (9.02 s) |
|---|---|---|---|
| Bochs handlers (BX_CPU_C::MOV_*, PUSH_*, J*, …) | **4.04 s (55.5 %)** | 2.22 s (29.8 %) | 1.23 s (13.7 %) |
| JIT'd trace code (all `wasm://` modules but the engine) | – | **1.77 s (23.8 %)** | **3.75 s (41.6 %)** |
| `cpu_loop` self (trace dispatch, SYNC_TIME, async check, JIT call/return) | 1.36 s (18.7 %) | 1.17 s (15.7 %) | 1.38 s (15.3 %) |
| decode + iCache (`serveICacheMiss` 0.19–0.32 self / **0.875 s inclusive**, fetchDecode64, modrm, imm, assign_srcs, `nanobox_jit_after_decode` 0.13, `prefetch` 0.06–0.11) | 0.68 s (9.4 %) | 0.94 s (12.6 %) | 0.96 s (10.6 %) |
| memory/TLB/paging (`readPhysicalPage` 0.14, `translate_linear*` 0.30 incl., `TLB_flushNonGlobal` 0.07, `get_vector` 0.07, stack_*_qword, dmaWritePhysicalPage 0.05) | 0.64 s (8.8 %) | 0.60 s (8.1 %) | 0.62 s (6.9 %) |
| devices (virtio-9p `queue_notify` 0.09 incl., timers, poll_oneoff) | 0.19 s | 0.21 s | 0.22 s |
| JIT compiler, inclusive (`nanobox_jit_maybe_compile` 0.19 s = TraceCompiler + region formation, + `nanobox_jit_batch_flush` 0.14 s which contains the host `WebAssembly.Module` compile, `compileMs` 86 ms — overlaps the host row) | – | ~0.33 s (4 %) | ~0.5 s (est.: engine self 0.10 s + host 0.31 s) |
| host: wasm compile/instantiate of the engine | 0.09 s | 0.20 s | 0.31 s |
| host: node/JS (run.mjs, wasifs `copyOut` 0.012, netstub, GC) | 0.11 s | 0.11 s | 0.15 s |
| string ops (REP*/FastRep*, MOVSX) | 0.11 s | 0.07 s | 0.06 s |

Derived unit costs (interpreter run): handlers **6.4 ns per guest instruction** (4.04 s / 634 M); `cpu_loop`
**14 ns per trace boundary** (1.36 s / 95.75 M); JIT'd hot code **4.6 ns per instruction incl. its trace
overhead** (1.77 s / 384 M) = 29 ns per JIT'd trace execution (61.0 M executions, 6.3 instr each).

### 2.3 Wall-time A/B (eh-nb, same minute, back-to-back)

| configuration | wall to EXPECT |
|---|---|
| `--jit 0` | 6.93 s, 6.99 s |
| `--jit 2:2000` | 6.18 s, 6.16 s (other runs today: 6.27–6.87) |
| `--jit 2:2000 --jit-region 1` (no regions) | 6.43 s |
| `--jit 2:200` | 9.08 s (level 3: 9.60 s) |
| `--jit 2:200 --jit-region 1` | 8.47 s |
| `--jit 2:200` + `--wasm-tiering-budget=1000` (V8 tiers Liftoff→TurboFan ~13000× sooner) | 8.16 s (budget 100000: 8.48 s) |
| `--jit 2:2000 --jit-bundle kernel.nbjb --jit-bundle codex.nbjb` | 6.6–7.2 s (1372 bundle hits, 48 misses; V8 compile is only 86 ms, so no gain in the harness) |

## 3. Which guest code is hot

### 3.1 Whole run (`pages-t40.txt`, `pages.mjs`)
629.7 M instructions over 5252 pages; kernel 239.5 M (38 %) in 596 pages (13 / 72 pages for 50 / 90 %),
user 390.2 M (62 %) in 4656 pages (11 / 140 pages for 50 / 90 %). Average instructions per `cpu_loop`
iteration: kernel 11.3, user 16.4 (JIT'd loops count as one iteration).

### 3.2 Per phase (deltas of the cumulative `--pages` files, `pagesdiff.mjs`)

Phase B (0–1.2 s, 52 M, kernel 60 %): kernel pages `0x…92a5b000` (2.25 M, 45/trace), `926e7000`, `92725000`,
`926e5000`, `9265a000` …; user = runc/init at `0x7fa0…` (21 M, 9.6/trace).

Phase C (1.2–2.1 s, 64 M, **kernel 94 %**, 15.4 instr/trace): `0xffffffff92a59000` 7.35 M (43/trace) — disassembled
from the saved physical page: XArray walk (`xas_load`/`xas_descend`: `cmp rsi,0x406`, `xa_is_node`, shift by
`node->shift`) = page-cache lookup / `filemap_map_pages` fault-around; `92729000` 4.3 M (52/trace), `9271a000`
4.1 M, `926ef000` 3.6 M, `926e6000` 3.1 M, `92a5a000` 3.1 M, `92725000` 3.1 M (mm/filemap/readahead/PTE code; no
`rep movs`/copy loops in these pages — the 9p payload lands by DMA, the kernel work is bookkeeping: ~2500
instructions per 4 KiB page filled). Cost of the file reads: 64 M kernel instructions for 93 MB ≈ 0.7 M instr/MB
≈ 7–9 ms/MB at ~90 MIPS → **~1.0–1.2 s of the run for the 138 MB**, versus 0.09 s in the virtio-9p device and
0.012 s in `wasifs.copyOut`. (Guest-side parameters — msize, readahead, page cache — change guest RAM and are
therefore off the table; only the emulation speed of this kernel code can improve.)

Phase D (2.1–4.2 s, 189.5 M, user 60 %) and E (4.2–6.4 s, 324 M, user 77 %) — codex, mapped at `0x7f1bf4126000`
(file offset = linear − base; `.text` is 0x6b7080…0xc676xxx):

| linear page | file offset | instr (D / E) | instr/trace | what it is (objdump of the saved page / referenced rodata) |
|---|---|---|---|---|
| `0x7f1c00654000` | 0xc52e000 | 7.4 M / 32.3 M (**6.3 % of ALL**) | 113–150 | OpenSSL `EVP_DecodeUpdate` (PEM base64: `cmp al,0x3d`, 64-char blocks, `evp_decodeblock_int` at +0x290); focus: `+0xeb` 17.9 M, `+0x140` 9.7 M, `+0x370` 8.5 M |
| `0x7f1c00784000` / `785000` / `790000` / `760000` | 0xc65e000 / 0xc65f000 / 0xc66a000 / 0xc63a000 | 11.8+5.4+8.0 M / 22.4+10.1+16.5+8.2 M | 25–37 | musl libc at the end of `.text`: mallocng `malloc` (`cmp rdi,0x1ffeb`, `imul 0x76be629` size_to_class), `free`, `memchr` (0x0101010101010101) — 57 M instructions of allocator/mem* churn in phase E alone |
| `0x7f1c00511000` | 0xc3eb000 | 4.2 M / 19.5 M | 31–43 | `+0xe50`: `mov rax,[rip+…]; cmp rax,[rip+…]; je; jmp rax` lazy-init dispatch stub + callee (15.4 M in the region) |
| `0x7f1c004ba000…4c7000` (cluster) | 0xc394000…0xc3a1000 | – / 43 M | 11–17 | OpenSSL `crypto/asn1/tasn_new.c` / `tasn_fre.c` / `tasn_utl.c` (rodata refs) = X509/ASN.1 template decode of the certificates |
| `0x7f1c00009000`, `0x7f1c0005d000` | 0xbee3000, 0xbf37000 | 6.5 M, 4.0 M / – | 23, 83 | Rust/OpenSSL init code (phase D only) |

So the codex process spends most of its 580 M instructions parsing the CA bundle five times (base64 → ASN.1 →
malloc/free), which is exactly the kind of straight-line, memory-heavy user code the trace JIT should own.
Kernel share of E is still 23 % (73 M): syscalls/faults for the same work.

### 3.3 Interpreter vs JIT per opcode (level 3, T=2000)
Executed inline in JIT'd traces: 384.0 M; handler steps inside JIT'd traces: 1.73 M (`REP_MOVSB` 517 K,
`REP_MOVSQ` 171 K, `CLI` 161 K, `STI` 126 K, `POP_Eq`(mem) 77 K, `BT_EdIb` 77 K, `MUL_RAXEq` 69 K, `BTS_EqIb` 64 K,
`NEG_Eb` 59 K, `XCHG_EdGd` 45 K, `REP_STOS*` 80 K, `AESENC` 24 K, …) ≈ 0.15–0.2 s; slow-path memory helpers
1.14 M. Top executed opcodes are the usual MOV/POP/PUSH/Jcc/RET/CALL/LEA/TEST/CMP (all inline).

## 4. The interpreter tail and the JIT's per-trace cost

### 4.1 Coverage vs threshold (level-3 counters; `traces` = 168,400,128 in every run = 95.75 M boundaries executed)

| | T=2000 | T=200 |
|---|---|---|
| traces compiled (`jitCompiled`) / regions formed / region compiles | 1456 / 1488 / 348 | 7718 / 9533 / 1931 |
| compile-time instructions covered / wasm bytes | 28.4 K / 5.5 MB (**193 B/instr**) | 157.5 K / 31.1 MB (198 B/instr) |
| cpu_loop→JIT entries / JIT→JIT links / in-function loop-backs | 10.46 M / 46.9 M / 3.66 M = **61.0 M JIT'd trace executions (64 %)** | 5.86 M / 73.4 M / 3.98 M = 83.2 M (87 %) |
| instructions executed in JIT'd code | **384 M (60.5 %)** | 537 M (84.6 %) |
| `linkFail` [0] SYNC_TIME, [1] async, [2] fetch-window refill, [3] iCache miss, [4] next not compiled, [5] handler ended, [6] write-stamp, [7] handler steps | 55 K, 0, **21.9 M**, 357 K, **9.98 M**, 130, 0, 1.73 M | 77 K, 0, 30.0 M, 617 K, 5.01 M, 57 K, 0, 3.05 M |
| content-cache re-attaches (`cache[1]`) | **180 K** | 323 K |
| V8 `compileMs` / batches | 86 ms / 398 | 260 ms / 1071 |
| wall (level 2) | 6.2–6.9 s | 9.1 s |

Reading: 95 % of all exits from JIT'd code at T=2000 are "the next trace is not compiled" (9.98 M of 10.46 M).
Going to T=200 compiles 5.3× more traces and moves 153 M instructions into JIT'd code, yet the JIT'd share of the
CPU profile grows from 1.77 s to 3.75 s (+1.98 s for +22.2 M trace executions: **~89 ns per lukewarm trace,
~13 ns/instr**) while the handler category only shrinks by 1.0 s. `cpu_loop`, decode and TLB categories do not
shrink at all (they are dominated by boundaries and misses, not by interpreted instructions). Regions are not
the cause (`--jit-region 1`: 8.47 vs 9.08 s) and Liftoff is only ~10 % of it (`--wasm-tiering-budget=1000`: 8.16 s).
What is left is the fixed per-trace work in the emitted code (prologue: async check, RIP/icount/user_pl loads,
register loads; epilogue: dirty-register spill, RIP/prev_rip/icount stores, SYNC_TIME fast path (3 loads,
2 stores), async_event load, fetch-window check, `RIP+eipPageBias`, `pAddrFetchPage`, iCache index (load
`fetchModeMask`, mul), entry `pAddr` compare, `jitfn`/`jitarg`/`ilen` loads, RIP store, `return_call_indirect`
into a *different* wasm instance) plus code volume: in the dbg-mode recording (`M` lines) a 1-instruction trace is
**1.8 KB of wasm**, 8 instructions 3.0 KB, 20 instructions 5.9 KB — every memory operand inlines the index into the
guest's DTLB and the two tests on the entry it lands in, plus a slow-path call site. Lukewarm traces of ~7 instructions execute
that once per visit from cold i-cache; the interpreter's handlers are shared and stay hot.

### 4.2 Why lukewarm traces stay lukewarm (iCache geometry)

`cpu/icache.h`: 64 K entries, direct-mapped by `(pAddr & 0xFFFF) ^ fetchModeMask`; `alloc_trace()` flushes **the
whole iCache** (`flushICacheEntries` → `nanobox_jit_flush_all`, all `hot` counters and `jitfn` pointers zeroed) when
the 576 K-instruction `mpool` wraps. Measured consequences (T=2000):
* 180 K content-cache hits = a hot trace was re-decoded and re-attached **~124 times per hot trace** in 5.5 s;
  `linkFail[3]` = 357 K link-time iCache misses on successors of hot traces.
* dbg window at #82.0 M (kernel-heavy, t≈1.25 s, 400 K traces = 2.1 M instr): 15,753 distinct trace starts on 626
  pages, 5,201 executed once; direct-mapped simulation: 13,898 cold + **5,223 collision** misses (1.31 % of executions,
  3,962 of them evicting a trace already seen ≥ 2×); 3,529 of the 15,753 trace starts share a slot with another
  executed trace; one burst of 78 hot-translation losses within 6 K traces (consistent with a full flush; the other losses come in ones and twos = collisions).
* dbg window at #140.0 M (user-heavy, t≈4.9 s): 5,019 distinct starts on 245 pages, 4,816 cold + 2,687 collision
  misses (0.67 %); 67 % of executions belong to traces that ran ≥ 200× *inside this 1/300 slice of the run*
  (57 % in the kernel window) — i.e. almost everything that runs would pass any sane global threshold if the
  counter survived evictions.
* Extrapolated: 2–5 % of trace executions are decodes → 2–4.5 M decodes per run, matching the 0.875 s inclusive
  `serveICacheMiss` (JIT on) at ~30–40 ns per decoded instruction; the distinct working set is a few hundred
  thousand traces, so most of that time is *re*-decoding.
* 31 % (user) – 43 % (kernel) of consecutive trace transitions cross a 4 KiB page (`linkFail[2]` 21.9 M of 46.9 M
  links): the fetch-window refill (inline ITLB check + 5 stores) is paid on almost every other hop, and regions
  cannot follow (max 2 pages).

## 5. Ranked proposals

Gains are estimates against the 6.2–6.9 s harness run; identity = risk to byte-identical guest RAM (all of
these are emulator-internal; the gate is `test/identity.sh` + `harness/bisect.mjs`).

| # | change (where) | expected gain | identity risk | effort |
|---|---|---|---|---|
| 1 | **Hotness must survive iCache eviction and flush.** Keep `hot` in a small side table keyed by `pAddr` (or in the existing content cache `JitCacheEntry`, hashed on `pAddr` before decode) instead of `bxICacheEntry_c::hot`; on `alloc_trace`/`flushICacheEntries` do not zero it. (`cpu/icache.h alloc_trace`, `nanobox_jit.cc nanobox_jit_after_decode`, `cpu/cpu.cc` line 133). Together with #2 it is what lets T drop. Alone: more traces reach T=2000 (today only loops with ≥ 2000 iterations between two losses do). | −0.2…0.4 s alone; enables #3 | none (cache policy is guest-invisible; trace decoding rules unchanged) | S |
| 2 | **Stop thrashing the iCache**: 64 K → 256 K entries with a mixing hash (`hash()` in `cpu/icache.h`, e.g. `(pAddr ^ pAddr>>16) & mask`), `BxICacheMemPool` 576 K → 2–4 M slots and, instead of a full flush on wrap, an epoch/segment scheme (flush only the entries whose `i` lies in the segment being reused — the entries carry `i`; walk them by page or keep a per-segment list). Cuts the 0.875 s of `serveICacheMiss` (most of it re-decodes) to the cold working set (~0.2–0.3 s), removes 180 K JIT re-attaches and the `hot` resets. Memory: +~40 MB of wasm memory (check `sizeof(bxInstruction_c)`). | **−0.5…0.7 s** | none in principle; verify with identity + bisect (SMC masks / page-split entries must keep working) | S–M |
| 3 | **Make short JIT'd traces cheaper than the interpreter**, then lower T to ~200–500 (85 % coverage). (a) Successor cache in the link epilogue: store `(expected pAddr, jitfn, jitarg, ilen)` of the last successor in the trace/region descriptor and verify only `pAddr` — replaces the fetchModeMask/iCache-index/entry loads (6 loads + mul) by 2 loads; fall back to today's lookup on mismatch. (b) Move address resolution (the DTLB index and the two entry tests) into ONE helper function per batch module (`call`, same instance) and inline only the branch that consumes the resolved host pointer; expected code size 200 → ~80 B per guest instruction (V8 machine code ~3×), which is what makes lukewarm code i-cache-resident. (c) Hoist address resolution across a run of accesses the compiler can prove share a page, keyed by class (RSP-based vs other base register), keeping the resolved host pointer in a local across in-region transitions like registers (A3) — today every access resolves for itself. (d) Trim the prologue: `user_pl`/`async_event` loads only when the trace has a memory op / needs the check. Success criterion: the T=200 run must get *faster* than T=2000, not 2.2 s slower. | **−1.0…1.5 s** (JIT share 60 % → 85 % at ≤ 5 ns/instr; interpreter handlers 2.2 s → ~0.6 s; cpu_loop 1.17 → ~0.5 s) | medium (new code paths in the epilogue and in address resolution; the bisector + identity gate exist) | M–L |
| 4 | **Cross-page hops** (`linkFail[2]` 21.9 M): let the successor cache of #3a hold the target's `pAddrFetchPage`/`eipFetchPtr` (ITLB entry pointer) so the refill is 2 loads + a compare instead of the inline prefetch (~12 memory ops); allow regions to record more than 2 physical pages (`REGION_OFF(ppf2)` → small array). | −0.1…0.2 s | low–medium | M |
| 5 | **Later wizer snapshot**: the runtime spends 0.30→0.62 s (est. 15–20 M instr of the 52 M in phase B) in the guest before the first bundle access; if that stretch depends on nothing the host supplies at run time (netstub DHCP/ARP frames arrive later — check `net` stats: 11 frames), snapshot at the first `path_filestat_get` of the bundle. | ≤ 0.3 s | medium (must prove the pre-snapshot state is host-independent; both engines' snapshots must move together for the identity test) | M |
| 6 | Handler steps still hot inside JIT'd traces: `REP MOVSB/MOVSQ/STOS*` (768 K), `CLI/STI` (287 K), `BT*/BTS/BTR` mem/imm (178 K), `MUL/DIV` (77 K), `NEG_Eb`, `XCHG_EdGd`, `POP_Eq` mem (77 K) → templates (C1/C2 in TASKS.md); each handler step also spills/reloads everything (`syncBefore`+`invalidateAll`). | −0.1…0.15 s | low | S–M |
| 7 | `cpu_loop` per iteration (14–26 ns × 45 M): fold `getICacheEntry` (mul by `sizeof(bxICacheEntry_c)` → shift by making the entry a power of two), skip `BX_SYNC_TIME` work when `icount_last_sync` unchanged, avoid re-reading `async_event` twice; mostly subsumed by #3 (fewer boundaries reach cpu_loop). | −0.1 s | none | S |
| 8 | Not worth it (measured): virtio-9p device path 0.09 s for 138 MB; `wasifs.copyOut` 0.012 s; OCI cache load 0.13 s; engine compile/instantiate 0.1 s; JIT compile 0.33 s at T=2000 (bundles cover it in the browser); netstub/poll_oneoff 0.04 s; JS GC 0.02 s. Guest-side changes (msize, readahead, page cache, cert parsing ×5, musl malloc) are excluded by the identity requirement. | – | – | – |

Notes for whoever implements #1–#3: with `--jit 3` the content key includes the level (`nanobox_jit_hash` mixes
`nanobox_jit_level`), so profiling runs cannot use the level-2 bundles (0 hits, 2131 misses) — record separate
level-3 bundles or accept compile time in those runs; and the shared link function pinned from a bundle is a
level-2 function, so `links`/`linkFail` counters are wrong whenever a bundle is loaded at level 3.

## Files (all under `work/prof/hotpaths/`)

`timeline-jit2000.txt`, `timeline-fslog.txt` (timestamped console + 9p log), `jit3-2000.txt`, `jit3-200.txt`,
`jit3-2000-bundle.txt` (level-3 counters), `ehprof-jit0.cpuprofile`, `ehprof-jit2000.cpuprofile`,
`ehprof-jit200.cpuprofile` (+ `profcat.mjs`), `pages-t1.2.txt … pages-t40.txt`, `pages-full2.txt` (+ `pagesdiff.mjs`),
`focus-654000.txt`, `focus-784000.txt`, `focus-511000.txt`, `focus-k92a59000.txt`, `phys-*.bin` / `kphys-*.bin`
(saved guest pages), `codex.bin` (the guest binary, for objdump; `findoff.mjs` maps pages to file offsets),
`dbg-phaseC.log`, `dbg-phaseE.log` (per-trace logs, 400 K traces each; `dbgstats.mjs`, `dbgflips.mjs`),
`codex-rec2000.nbjb` (fresh bundle recording used for the bundle check).

# What the JIT emits — one real trace, with and without the stack-run peephole

Both listings are the SAME guest trace (content key `2816d494:ee2cf65c`; kernel text at
guest-physical `0x29725bc6`, 10 bytes, 4 instructions — the JIT's compile log calls it
`ADD_EqGq(M) POP_Eq POP_Eq JMP_Jq`):

    add  [rax], rbx        ; 48 01 18
    pop  rbx               ; 5b
    pop  rbp               ; 5d
    jmp  +0                ; e9 00 00 00 00   (a jump-label / alternatives patch site)

pulled out of bundles recorded with and without `NANOBOX_JIT_MERGE=1`:

    node tools/jit-diff-example.mjs base.nbjb merge.nbjb --key 2816d494:ee2cf65c --out DIR

Full functions: `examples/trace-2816d494-baseline.wat` (743 lines), `-merged-stack-runs.wat`
(599). Memory offsets: `368376 + 8·r` = `gen_reg[r]` (RAX 368376, RBX 368400,
RSP 368408, RBP 368416), `368504` = RIP, `368560` = prev_rip, `368584` = icount, `368544/368552` =
lazy-flags result/auxbits, `386776` = async_event, `386860` = alignment-check mask, `386880` = DTLB.

## 1. Baseline — registers already live in wasm locals inside a trace

```wat
(func (export "f18") (param i32)          ;; param = iCache entry (jitarg)
  (local i64 i64 i32 i64 ... )             ;; 48 locals: L_base, ic0, user_pl, temps, register cache
  i64.const -1  local.set 42               ;; probe cache: "no page probed yet"
  i32.const 0  i64.load offset=368504      ;; RIP
  i64.const 3  i64.sub  local.set 1        ;; L_base = RIP - 3 (position-independent code)
  i32.const 0  i64.load offset=368584  local.set 2   ;; ic0 = icount at entry
  i32.const 0  i32.load8_u offset=386788  local.set 3 ;; user_pl (for TLB access bits)
  block
    i32.const 0  i32.load offset=386776  if ... end   ;; async_event pending? -> commit + handler path
    block
      ;; --- register loads: ONCE per trace, only the registers this trace touches ---
      i32.const 0  i64.load offset=368400  local.set 8   ;; RBX  -> local 8
      i32.const 0  i64.load offset=368376  local.set 5   ;; RAX  -> local 5
      ...                                                ;; body works on locals only
      ;; pop rbx: probe RSP's page (below), load, RSP += 8 — all in locals:
      local.set 24
      local.get 23  i64.const 8  i64.add  local.set 9    ;; RSP local += 8
      local.get 24  local.set 8                          ;; RBX local = popped value
      ...
    end
    ;; --- exit: store only the DIRTY registers, commit RIP/prev_rip/icount, hop to the next trace ---
    local.get 1  i64.const 10  i64.add  local.set 30     ;; next RIP = L_base + 10
    i32.const 0  local.get 8   i64.store offset=368400   ;; RBX
    i32.const 0  local.get 9   i64.store offset=368408   ;; RSP
    i32.const 0  local.get 10  i64.store offset=368416   ;; RBP
    i32.const 0  local.get 21  i64.store offset=368544   ;; lazy flags result
    i32.const 0  local.get 22  i64.store offset=368552   ;; lazy flags auxbits
    i32.const 0  local.get 30  i64.store offset=368504   ;; RIP
    i32.const 0  local.get 30  i64.store offset=368560   ;; prev_rip
    i32.const 0  local.get 2  i64.const 4  i64.add  i64.store offset=368584   ;; icount += 4
    br 0
  end
  i32.const 0  i32.const 3282  return_call_indirect (type 0))   ;; tail-call the shared link fn -> next trace
```

So the "keep registers in wasm locals / machine registers" idea is what the baseline already does
inside a trace: 3 register loads at entry (RBX, RAX, RSP — only what the trace reads), 3 register
stores at exit (RBX, RSP, RBP — only what it wrote), everything in between is `local.get/local.set`
(V8 register-allocates locals). The remaining register traffic per trace is those 6 constant-address
moves + the two lazy-flag words + RIP/prev_rip/icount (3 stores; the interpreter needs them if the next
trace faults) — about 8 machine `mov`s for a 4-instruction trace. Regions (A3) remove even those
between blocks of the same function.

## 2. Registers in wasm globals — tried, measured +4 %, REMOVED

Same trace: `global.get 3` replaced `i32.const 0; i64.load offset=368400` (no cheaper — V8 reaches
an imported mutable global through a pointer indirection) and every JIT↔C++ boundary gained an
18-register copy in and out. On a one-instruction trace (`jmp rdx`) the diff was −3/+172 lines for
one `i64.load` → `global.get`. Nothing left to optimize there: the baseline already loads each
register once into a local and stores back only what changed. Code and build deleted.

## 3. Merged stack runs (`NANOBOX_JIT_MERGE=1`) — the `pop rbx; pop rbp` pair

Baseline: two independent stack reads, each = page-span check + alignment check + probe-cache
compare (+ full DTLB lookup on miss) + load + RSP update; second one repeats it all:

```wat
      ;; pop #1
      local.get 28  i64.const -4096  i64.and  local.get 42  i64.ne  br_if 0     ;; same page as cached probe?
      local.get 28  i32.wrap_i64  i32.const 4095  i32.and  i32.const 4088  i32.gt_u  br_if 0  ;; 8 bytes inside page?
      local.get 4  i64.const 7  i64.and  i64.const 0  i64.ne  br_if 0          ;; alignment-check?
      local.get 44  i32.const 1  local.get 3  i32.shl  i32.and  i32.eqz  br_if 0 ;; access bit for CPL
      br 1
    end
      ;; probe-cache miss: DTLB entry = table[(la+7 & mask) >> 7], compare lpf, check bits, refill cache (30 ops)
      ...
    local.get 43  local.get 28  i32.wrap_i64  i32.const 4095  i32.and  i32.add  i64.load align=1  ;; host load
    ...
    local.set 24  local.get 23  i64.const 8  i64.add  local.set 9  local.get 24  local.set 8     ;; RBX, RSP
      ;; pop #2: the same ~45 ops again for RSP+8 (same page 99.9 % of the time)
```

Merged: one span check for 16 bytes, one probe, two loads at fixed offsets, one RSP add:

```wat
      local.get 30  i32.wrap_i64  i32.const 4095  i32.and  i32.const 4080  i32.gt_u  br_if 0  ;; 16-byte span in page?
      local.get 4  local.get 30  i64.const 7  i64.and  i64.and  i64.const 0  i64.ne  br_if 0     ;; alignment-check?
      ;; one probe (cache compare / DTLB lookup) for the page holding both slots
      ...
      local.get 43  local.get 30  i32.wrap_i64  i32.const 4095  i32.and  i32.add
                    i64.load align=1  local.set 8                              ;; RBX = [rsp]
      local.get 43  local.get 30  i32.wrap_i64  i32.const 4095  i32.and  i32.add  i32.const 8  i32.add
                    i64.load align=1  local.set 10                             ;; RBP = [rsp+8]
      local.get 29  i64.const 16  i64.add  local.set 9                        ;; RSP += 16
      br 1
    end
    ;; any check failed: the run instruction by instruction through Bochs' stack_read_qword,
    ;; RIP/prev_rip/icount committed before each (exact #PF/#SS semantics), still inside the trace
    i32.const 0  local.get 21  i64.store offset=368544 ... call 8  local.set 8 ...
    ...                                                 call 8  local.set 10 ...
```

Per merged pair that is ~45 wasm ops less on the fast path (one probe instead of two). Measured
−2 % on the codex boot: pushes/pops are ~5 % of executed instructions and the second probe of a
pair was already the cheap "same page as cached probe" compare, not a DTLB walk. Correctness is
unchanged (identity + bisect clean); the flag stays off by default.

## What actually costs time then (the counters)

Per codex boot (1.10 G instructions, 168 M traces ≈ 6.5 instructions/trace, --jit 2:2000):
10.5 M entries from cpu_loop into JIT code, 47 M trace→trace hops, 3.6 M loop-backs; the JIT'd
traces execute ~360 M instructions inline; the other ~740 M instructions run in the interpreter —
lukewarm code below the threshold, where JIT'ing them was measured to cost more (per-trace overhead
+ compile) than it saves. The largest single items are 10 M returns to cpu_loop because the next
trace is not compiled (`linkFail[4]`), 21.9 M fetch-window refills (`linkFail[2]`), 1.7 M handler
steps and 1.1 M slow-path memory helpers — i.e. trace-boundary and memory-access overhead, not
register traffic. That is why moving registers off memory does nothing measurable.

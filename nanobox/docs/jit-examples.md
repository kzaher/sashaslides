# What the JIT emits — one real trace, annotated

The trace throughout is content key `2816d494:ee2cf65c` (kernel text at guest-physical
`0x29725bc6`, 10 bytes, 4 instructions — the JIT's compile log calls it
`ADD_EqGq(M) POP_Eq POP_Eq JMP_Jq`):

    add  [rax], rbx        ; 48 01 18
    pop  rbx               ; 5b
    pop  rbp               ; 5d
    jmp  +0                ; e9 00 00 00 00   (a jump-label / alternatives patch site)

Memory offsets: `368376 + 8·r` = `gen_reg[r]` (RAX 368376, RBX 368400,
RSP 368408, RBP 368416), `368504` = RIP, `368560` = prev_rip, `368584` = icount, `368544/368552` =
lazy-flags result/auxbits, `386776` = async_event, `386860` = alignment-check mask, `386880` = DTLB.

## 1. What a compiled trace looks like

Record and disassemble your own rather than trusting a listing that has aged: `--jit-dump DIR` on a
harness run writes every module the engine compiles, and `node tools/wasm2wat.mjs DIR/*.wasm` turns
each one into WAT beside it. To put two engine variants side by side on the same guest code, record
`--jit-bundle-out A.nbjb` from each and run

    node tools/jit-diff-example.mjs A.nbjb B.nbjb --key 2816d494:ee2cf65c --out DIR

— bundles are keyed by the content hash of the decoded x86 instructions, so a key present in both
names the same trace.

A trace function takes one `i32` param (the iCache entry, `jitarg`) and opens with a prologue that
sets up `L_base` = RIP minus the trace's offset (so the body is position-independent), `ic0` = the
icount at entry, and `user_pl` = the CPL that the access-bit tests need; then it loads `async_event`
and takes the commit-and-handler path if one is pending. Nothing arrives from the previous
translation: the shared trace signature is `(arg i32)`, plus `(rip i64, ic0 i64)` under direct calls.

**Registers live in wasm locals inside a trace.** Every register the trace reads is loaded once at
entry (`i32.const 0; i64.load offset=368400; local.set 8` for RBX), the body is `local.get` /
`local.set` only (V8 register-allocates locals), and the exit stores back only what the trace wrote,
plus the two lazy-flag words and RIP/prev_rip/icount — about 8 machine `mov`s for this 4-instruction
trace, since the interpreter needs those three if the next trace faults. Regions (A3) remove even
that between blocks of the same function. The trace ends in a `return_call_indirect` tail-call into
the shared link function, which finds the successor.

**Every memory operand resolves its own address, inline.** The site indexes the guest's own
2048-entry DTLB with `la + size-1` and tests the entry it lands in twice:
`entry->lpf == (la & (LPF_MASK | (acm & (size-1))))` settles page identity, the pending alignment
check and the span in one compare, and `entry->accessBits & (bit << user_pl)` settles both permission
at this CPL and "this is real RAM with a host pointer" — Bochs clears the access bits of a page it
holds no host pointer for. Either test failing branches to the site's slow arm; on the fast path,
after the per-access write-stamp test, the access itself is a plain `i64.load` / `i64.store align=1`
at the page offset off the entry's host pointer. **99.8 % of `MOV_GqEq` accesses are served by that
inline test**, and where one is not, the reason is "another page frame" in essentially every case.
It is not cheap in bytes: a `MOV_GqEq` site is 154.9 B, of which 73.3 B is `addr-resolve`, against
113.4 emitted bytes per guest instruction overall.

## 2. Registers in wasm globals — tried, measured +4 %, REMOVED

Same trace: `global.get 3` replaced `i32.const 0; i64.load offset=368400` (no cheaper — V8 reaches
an imported mutable global through a pointer indirection) and every JIT↔C++ boundary gained an
18-register copy in and out. On a one-instruction trace (`jmp rdx`) the diff was −3/+172 lines for
one `i64.load` → `global.get`. Nothing left to optimize there: the emitted code already loads each
register once into a local and stores back only what changed. Code and build deleted.

## What actually costs time then (the counters)

Per codex boot (1.10 G instructions, 168 M traces ≈ 6.5 instructions/trace, --jit 2:2000):
10.5 M entries from cpu_loop into JIT code, 47 M trace→trace hops, 3.6 M loop-backs; the JIT'd
traces execute ~360 M instructions inline; the other ~740 M instructions run in the interpreter —
lukewarm code below the threshold, where JIT'ing them was measured to cost more (per-trace overhead
+ compile) than it saves. The largest single items are 10 M returns to cpu_loop because the next
trace is not compiled (`linkFail[4]`), 21.9 M fetch-window refills (`linkFail[2]`), 1.7 M handler
steps and 1.1 M slow-path memory helpers — i.e. trace-boundary and memory-access overhead, not
register traffic. That is why moving registers off memory does nothing measurable.

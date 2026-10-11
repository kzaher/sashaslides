# Why each image is pinned to an engine

The two engines do not emulate the same CPU, and the agent CLIs are compiled for different
instruction-set baselines. That combination — not speed — is what decides which engine can run what.

| CLI | built as | needs | QEMU→wasm | WASI/Bochs |
|---|---|---|---|---|
| `codex`  | Rust, musl-static, plain x86-64 | SSE2 | ✅ `--version` in ~19 s | ✅ (slower) |
| `claude` | Bun-compiled single binary | **AVX2** | ❌ SIGILL | ✅ `--version` in ~2 m |
| `agy`    | Go, built with `pclmul` | **PCLMULQDQ** | ❌ SIGILL (`go/sigill-fail-fast`) | ✅ `--version` in ~75 s |

Bochs is configured as `corei7_haswell_4770` and built `--enable-avx`, so it has AES, PCLMUL and
AVX2. QEMU-wasm's guest CPU is the default `qemu64`, which has none of them.

## Why we can't just pass `-cpu` to QEMU

The obvious fix is `-cpu max` (or `-cpu Haswell`) in `config/qemu/args-x86_64.json.template`. It does
not work, and it fails in three distinguishable ways depending on what you ask for:

1. **`-cpu qemu64`** — even the model QEMU already defaults to — kills the emulator during boot:

   ```
   TypeError: Cannot convert undefined to a BigInt
       at qemu-system-x86_64.wasm.ffi_call
       at qemu-system-x86_64.wasm.tcg_qemu_tb_exec_tci
   ```

   TCI (the interpreter half of qemu-wasm's JIT) dispatches helper calls through a table of
   pre-generated libffi signatures. Passing `-cpu` at all takes the guest down a path whose helper
   has no registered signature, and the call gets `undefined` where a BigInt is expected.

2. **`-cpu Haswell` / `-cpu max`** — the kernel boots and reports AVX, then container2wasm's Go
   `init` dies before it can start the container:

   ```
   runtime: val=18446744073709535232 n=-32768
   fatal error: sysMemStat overflow
   ```

   Go's memory accounting goes negative, i.e. the guest is being miscompiled underneath it.

3. **No `-cpu` at all** — everything works, at the stock feature set. That is what we ship.

So the QEMU engine is fast but stuck on a 2003-era instruction set, and the Bochs engine is slow but
complete. `public/c2w/index.html` picks per image accordingly, and the page still accepts
`?cpu=…&mem=…&smp=…` overrides for anyone who wants to re-test the above (an override forces a cold
boot, since the packaged boot snapshot is tied to the machine it was taken on).

Other limits worth knowing, both learned the same way:

- guest RAM is capped at **2047 MB** — ask for 2048 and the runtime refuses with
  `this.program: at most 2047 MB RAM can be simulated`. We ship 1792 MB.
- the boot snapshot (`-incoming file:/pack/vm.state`, built into `qemu-system-x86_64.data`) is what
  makes the QEMU engine reach a shell in seconds. Cold boot works too, it just takes minutes.

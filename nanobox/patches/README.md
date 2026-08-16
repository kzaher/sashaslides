# Patches (exported from the gitignored source trees under bochs/ and work/)

- `bochs-nanobox.patch` — ktock/Bochs @ a88d1f6 → nanobox engine: `nanobox.cc` (exports, page
  profiler, divergence fingerprints), `nanobox_jit.cc/.h` + `nanobox_wasm.h` (trace JIT → wasm
  modules), `cpu/cpu.cc` hook, `cpu/icache.*`, `wasm.cc` (deterministic 9p: path-hash qids, fixed
  times, mode passthrough via filestat dev, distinct qids per share), `wasm.h` (virtqueue 256),
  `iodev/slowdown_timer.cc` (host-time-free schedule), `cpu/init.cc` (fixed srand), `main.cc`/`cpu.h`/
  `gui/siminterface.h` (native wasm-EH setjmp), `Makefile.in`.
- `c2w-init-virtio-bundle.patch` — container2wasm v0.8.4 guest `init`: `--external-bundle=9p=virtio:NAME`
  (bundle served through the built-in virtio-9p share) + `msize=524288,cache=loose` for host shares.
- `c2w-imagemounter-genspec.patch` — `genspec`: prints the OCI runtime spec imagemounter would generate
  (used to produce `web/images/<image>/config.json`).
- `wasi-vfs-0.6.3-skip-nondir-prestat.patch` — tolerate non-directory prestats (container2wasm's socket fds).
- `wizer-v11-wasm-exceptions.patch` — enable the exceptions proposal in wizer's wasmtime config.
Apply with `git apply` in the respective checkouts (see build-bochs.sh / work/build-pack-nb.sh).
- `c2w-imagemounter-notbefore.patch` — container2wasm v0.8.4 `extras/imagemounter` + `extras/c2w-net-proxy`:
  the in-browser TLS MITM proxy's CA and per-host certificates get a `NotBefore` (upstream leaves Go's
  zero time = year 1, which webpki/rustls clients such as codex reject). Built by `build-imagemounter.sh`.

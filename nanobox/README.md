# nanobox

Run Linux in a browser tab, make a **folder you pick your VM's home**, mount extra directories, and
sync everything through a **unit-tested 3-way sync engine**. Tailscale gives the VM network egress.
Chromium only (needs the File System Access API). User-initiated by design.

```
node server.mjs          # http://localhost:8088   (COOP/COEP headers required by CheerpX)
```

- `/c2w/`        — **a real x86_64 Linux VM with a real agent CLI in it**, booted in the tab, no
                   server-side execution. Pick `claude`, `codex` or `agy` and you land on that
                   CLI's actual sign-in screen. See "The browser VM" below.
- `/`            — real flow: pick a folder → it becomes `/root`; add mounts; the mount table
                   persists into home.
- `/demo.html`   — zero-setup demo: an in-memory VM with `claude` + `codex` preinstalled and a live
                   terminal. Works in any Chromium tab, no folder pick needed.

## Test the sync layer

```
npm test        # node --test — 47 tests, all pure (no browser)
```

The engine, tar codec, store, and mount registry are pure ESM and fully covered:
`test/sync.test.js` (3-way merge: push/pull, delete-propagation without resurrection, all conflict
policies, idempotency, purity), `test/tar.test.js`, `test/store.test.js`, `test/mounts.test.js`.

## Architecture

```
public/lib/          PURE, unit-tested — same code runs in Node tests and the browser
  util.js            path normalization (rejects traversal), bytes, concat
  hash.js            sync content hash for change detection
  tar.js             ustar build/parse — the JS↔VM transport
  store.js           MemStore + the FileStore interface every backend implements
  sync.js            computeSync (3-way) / applySync / runSync
  mounts.js          mount registry: parse/serialize, validate, planRemount

public/adapters/     BROWSER glue behind the same interfaces
  fsa-store.js       FileStore over a File System Access directory handle
  idb-handles.js     persist directory handles in IndexedDB + re-permission
  vm.js              Vm interface. FakeVm (works today) + CheerpxVm (scaffold, ⚠ ADAPT regions)

public/nanobox.js    controller: pick home → load table → recreate mounts → sync
public/{index,demo}.{html,js}
```

### How the 3-way sync avoids the classic bug

Each side is compared against a persisted **base** (last-synced state), not against each other.
That's what tells "added on one side" apart from "deleted on the other" — a 2-way diff silently
resurrects deleted files. Change detection is content-hash only, so backends that can't preserve
mtime (File System Access) still sync correctly. Conflict policies: `manual` (report, touch nothing),
`prefer-local`, `prefer-remote`, `keep-both` (keeps the local file at its path on both sides and
saves the remote variant to `<path>.conflict-remote`).

### Home & the mount table

The **first** folder picked becomes home (`/root`). Inside it, `.nanobox/mounts.json` records the
other mounts (each pointing at an IndexedDB-persisted directory handle by `handleKey`). On a later
session, picking home reloads the table and `planRemount` splits mounts into *ready* (handle present
+ permission granted) vs *needs re-pick*. Invariants enforced: no mount at `/`, no collision with
home, no duplicates, no nesting (each byte has exactly one owning store), no mount inside home.

## The browser VM: two engines, one image (`/c2w/`)

`/c2w/` boots a **real x86_64 Linux with a real agent CLI in it**, inside the tab, with no CheerpX
and no server-side execution. Pick an engine and an image, press Boot:

| engine | what it is | notes |
|---|---|---|
| `qemu` | QEMU compiled to wasm by emscripten, TCG translating to WebAssembly (JIT) | fast, but its guest CPU is a stock `qemu64`: no AES/PCLMUL, no AVX2 |
| `wasi` | container2wasm's single WASI module (Bochs inside), driven from a worker | slow, but emulates a `corei7_haswell_4770` — AVX2 and all |

Both are built with `c2w --external-bundle`, which is the important part: **the container image is
not baked into the wasm**. The runtime is built once; the image is fetched over HTTP at boot as an
OCI Image Layout and mounted into the VM over 9p by `imagemounter.wasm`. Adding an agent means
adding an image directory, not rebuilding a 120 MB wasm.

**The engines are not interchangeable, and the reason is the CPU, not the speed.** `claude` is
Bun-compiled and needs AVX2; `agy` is a Go binary built with `pclmul`. Both SIGILL on the QEMU
engine's stock `qemu64` CPU. `codex` does exec there (`codex --version` in ~19 s, and `codex login`
prints its real OAuth URL) but its full-screen TUI never paints. All three are fine on Bochs. QEMU
can't simply be told to emulate more: passing *any* `-cpu` crashes this qemu-wasm build inside TCI's
helper dispatch. So the page defaults every agent to Bochs and keeps QEMU for the distro itself,
where snapshot restore gets you a shell in seconds. `vm-build/README-cpu.md` has the evidence, and
`?cpu=…&mem=…&smp=…` re-runs the experiment.

Measured end to end, in a headless Chrome, from page load to the CLI's sign-in screen:

| image | engine | time to sign-in screen |
|---|---|---|
| `base`   | qemu | 8 s (to a shell prompt — snapshot restore, no CLI to sign in to) |
| `codex`  | wasi | 52 s |
| `agy`    | wasi | 74–78 s |
| `claude` | wasi | 240–262 s (includes answering its theme prompt) |

One VM per browser at a time: the emulator is CPU-bound, and a second tab still running an old VM
will starve the one you are watching (a codex boot that takes 52 s alone did not finish in 30 min
alongside four others). `boot-browser.mjs` reuses one Chrome, so close stale `/c2w/` tabs between runs.

### Networking (why the VM needs the server for egress)

`imagemounter.wasm` also runs a user-space network stack (gvisor-tap-vsock): the guest gets an eth0
on 192.168.127.0/24, `https_proxy=http://192.168.127.253:80` and a proxy CA at
`/.wasmenv/proxy.crt`. The stack terminates the guest's TLS in the browser and re-issues each
request with the page's `fetch` — and *that* is where it stops working for real APIs, because a
cross-origin `fetch` needs CORS and `api.anthropic.com` has no reason to grant it to us. The guest
sees `503 Service Unavailable`, and an agent CLI renders that as "check your internet connection".

So nanobox routes it: a small shim in `public/c2w/index.html` sends any cross-origin request through
`POST /net/fetch` on this server, which performs it host-side and hands the response back. The
server is the VM's gateway; each request is logged as `[net] METHOD url -> status`. Same-origin
fetches (runtime, image blobs) are left alone. It forwards to a caller-named host, so keep it on
localhost.

### The guest distro

`vm-build/Dockerfile` builds a **minimal glibc Ubuntu**, assembled by copying the glibc runtime, the
CA bundle and a static busybox out of `ubuntu:24.04` rather than by deleting things from it — same
libc build, same certs, nothing else:

```
nanobox-base     3.9 MB   glibc + ca-certificates + busybox    (distroless/base is ~20 MB)
nanobox-claude   331 MB   + Claude Code        -> `claude`
nanobox-codex    264 MB   + OpenAI Codex       -> `codex`
nanobox-agy      212 MB   + Antigravity CLI    -> `agy`
```

The distro is the small part; each vendor's CLI is a 200-300 MB single binary, so they get one image
each and the browser only pulls the one you boot (layers are served gzipped, ~57-100 MB on the wire).

### Building it

```
# in a devcontainer only: a Docker daemon that can actually start containers there
sudo unshare -m --propagation private ./vm-build/start-docker.sh &   # see its header for the prereqs
export DOCKER_HOST=unix:///tmp/xdgrt-1000/docker.sock

./vm-build/build.sh all           # runtimes (~25 min) + browser glue + images
```

Everything it produces lands under `public/c2w/` and is gitignored.

### Testing it

```
node server.mjs &
npm run test:boot -- --image claude       # or codex / agy / base; engine defaults per image
```

That drives a real Chrome over CDP, reads what the VM paints into the terminal, answers the CLI's
onboarding prompts, and fails unless the **sign-in screen** appears. Screenshots, a transcript and
the browser console land in `/tmp/nanobox-boot/<image>-<backend>/`.

## Real CheerpX + Tailscale (the one part not wired here)

`createFakeVm()` is the default so the whole loop is demonstrable today. `createCheerpxVm()` in
`adapters/vm.js` is a scaffold with four clearly-marked **⚠ ADAPT** regions — CheerpX import/version,
disk image + persistent overlay, Tailscale `networkInterface`, and the console/exec wiring. It throws
until wired rather than faking success. Reference implementation (CheerpX + Tailscale + terminal):
**github.com/leaningtech/webvm**. Requirements once wired: cross-origin isolation (this server sets
it), a Tailscale auth key, and Chrome. The tested sync engine + mount registry + tar transport drive
the real VM unchanged — only `exec`/`pullTar`/`applyTar` need real implementations.

## Status

| Part | State |
|---|---|
| 3-way sync engine, tar, store, mount registry | ✅ implemented + 47 passing unit tests |
| File System Access store + IDB handle persistence | ✅ implemented (Chromium) |
| Demo page — Claude logo, claude/codex preinstalled, live terminal | ✅ runs; captured via CDP |
| Real-flow page — pick home, add mounts, persist table | ✅ runs on FakeVm |
| `/c2w/` QEMU→wasm engine (image-agnostic, snapshot boot) | ✅ boots the distro in seconds; runs `codex` |
| `/c2w/` WASI/Bochs engine (Haswell-class CPU) | ✅ runs `claude` and `agy`, which qemu's CPU can't |
| Minimal glibc Ubuntu guest + per-agent images | ✅ 3.9 MB base; built by `vm-build/build.sh` |
| VM egress via the server's `/net/fetch` gateway | ✅ CORS-free host-side forwarding |
| CheerpX + Tailscale backend | 🔩 scaffold — wire the 4 ADAPT regions (see above) |

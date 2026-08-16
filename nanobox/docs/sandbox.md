# The sandbox: a Linux-only image + first-run installer + a persistent tree (2026-08-16)

`web/sandbox.html?cli=claude|claude-native|codex|agy` — the user's direction for the system-node track: **ship only a
small Linux, no node and no bots in the image; at first run an installer (JavaScript in our runtime, on
the browser's V8) fetches node and the CLIs from the vendors' servers, verifies them, lays them out like
`npm install -g` in ONE host-side writable tree that persists in the browser (OPFS) and is shared by
every page on the origin; the VM stays mandatory (all tools/child processes run in the guest); network
without our relay wherever CORS allows.**

```
guest/linux-base/Dockerfile, build-linux-base.sh   the image: busybox + CA certs + glibc + libstdc++, 3.9 MB gz (2 layers)
tools/genspec-vm.mjs                               spec variants: --shim (/dev/hvc1 + PATH=/bundle/nb:…), --persist (bind mounts of the tree)
web/native/installer.js                            the installer + the persistent tree (also the "persist worker")
web/sandbox-worker.js                              opt-worker.js (unchanged, imported) + the writable bundle/persist subtree + byte counters
web/sandbox.html                                   the page (xterm, timers, prompt auto-answer, accounting; ?cli=sh = a shell in the guest)
web/wasifs.js                                      + writable subtrees (cfg.writable / cfg.onChange), test/wasifs-write-unit.mjs
web/native/src/esm2cjs.js                          the in-browser ESM→classic-script transform of the vendor's cli.js (was tools/native-prepare.mjs offline)
web/native/bunfs.js, tools/bun-extract.mjs         reading the files out of a Bun standalone executable (claude-native)
test/e2e-sandbox.mjs, test/sandbox-matrix.sh, tools/sandbox-report.mjs, test/sandbox-probe.mjs, test/installer-unit.mjs
test/claude-native-unit.mjs                        claude-native's resolve/Range/extract/layout logic against a local binary (no network)
web/results/sandbox-<cli>-{cold,warm}.{json,png}, web/results/sandbox-<cli>.json
```

## What happens on a page load

1. **Three things start at once**: the VM worker (`sandbox-worker.js`) fetches the slim engine
   (`/engine/opt/slim/out.wasm.gzip`, 29.8 MB, Cache API + ETag) and unpacks the `linux-base` image
   (3.9 MB); the **persist worker** (`installer.js` as a `Worker`) opens the OPFS directory
   `nanobox-persist/`, lists `packages/`, and installs whatever the requested CLIs need that is not there
   yet; for `cli=claude` and `cli=claude-native` the runtime worker (`native/runtime.js`) starts and waits
   for the guest shim.
2. **The installer** (`NanoboxInstaller.install`) resolves + downloads + verifies, all in parallel:

   | CLI | packages (vendor server) | gz | unpacked | integrity | route |
   |---|---|---|---|---|---|
   | (always) node | `node-linux-x64@22.23.2` → `/usr/local/{bin/node,include,share}` (`bin/node` 124.8 MB) | 51.6 MB | 183.8 MB | registry `dist.integrity` sha512 | direct (registry answers CORS) |
   | (always) npm | `npm@10.9.8` (the npm that ships with node 22.23.2 — `node-linux-x64` carries none) → `/usr/local/lib/node_modules/npm`, `bin/npm`, `bin/npx` | 3.0 MB | 11.7 MB | sha512 | direct |
   | claude | `@anthropic-ai/claude-code@2.1.112` (last release whose `bin` is `cli.js` — later ones download the Bun binary) → `/usr/local/lib/node_modules/@anthropic-ai/claude-code`, `bin/claude → cli.js`; other platforms' `vendor/{ripgrep,audio-capture,seccomp}` pruned in memory | 18.7 MB | 21.6 MB (49.3 unpruned) | sha512 | direct |
   | claude-native | the CURRENT release, out of the vendor's **Bun standalone executable**: `downloads.claude.ai/claude-code-releases/latest` → `<v>/manifest.json` → the last 64 MiB of `<v>/linux-x64/claude` (a `Range` request; the whole binary is 324.6 MB) → 11 embedded modules → `/usr/local/lib/claude-native/cli.js` (the 26.6 MB entry, verbatim), `/$bunfs/root/*` (its assets), `/usr/local/bin/claude` (a `sh` launcher) | 67.1 MB range-fetched | 33.3 MB (12 files, tar 33.4 MB in the store) | sha256 of the extracted **entry** recorded; the vendor's whole-file sha256 only with `?verifyfull=1` | **relay** (no CORS on `downloads.claude.ai`) |
   | claude `?sharp=1` | `@img/sharp-linux-x64@0.34.2` + `@img/sharp-libvips-linux-x64@1.1.0` under `claude-code/node_modules/@img/` | 0.4 + 16.7 | | sha512 | direct (off by default: a `.node` addon cannot load on the browser V8 anyway) |
   | codex | `@openai/codex@0.147.0` (`bin/codex.js`) + `@openai/codex@0.147.0-linux-x64` as the alias `@openai/codex-linux-x64` under `@openai/codex/node_modules/` (what npm does with `npm:` aliases; the Rust binary 258 MB + `codex-code-mode-host` 50 MB + rg + zsh + bwrap) | 0.004 + 122.0 MB | 314.8 MB | sha512 | direct |
   | agy | manifest `antigravity-cli-auto-updater-….run.app/manifests/linux_amd64.json` → `{version 1.1.13, url, sha512}` → `storage.googleapis.com/antigravity-public/…/cli_linux_x64.tar.gz` (one file `antigravity`) → `/usr/local/bin/agy` 755 | 55.6 MB | 206.2 MB | manifest sha512 | **relay** (`POST /net/fetch`, neither host answers CORS; `web/netpolicy.js` allow-list) — or the proxy extension when the page has it |

   Every vendor request goes through `NanoboxProxy.workerFetch` (`web/proxyext.js`): with the nanobox
   proxy extension installed the route is `extension` for everything cross-origin; without it `direct`
   for the vendors that answer CORS and `relay` only for the two agy hosts (+ the API hosts the CLIs
   themselves talk to). Routes are counted (`stats.routes`) and end up in the results JSON.
3. **Extraction is free**: a package is the vendor's tarball gunzipped and otherwise untouched (`tar` bytes)
   plus a small `meta` (kind, `into`, bins, prune). `NanoboxInstaller.applyPackage(tree, pkg)` runs
   `NanoboxOci.applyLayer` (ustar/pax/GNU long names) into a scratch dir and grafts the package
   directory's *content* under `usr/local/lib/node_modules/<name>` (merge, so `node-linux-x64` and `npm`
   both land in `usr/local`), adds `usr/local/bin/<bin> → ../lib/node_modules/<name>/<target>` symlinks
   from `package.json#bin` and marks the targets 755 — file contents stay views into the tar buffer.
   Applying node + npm + codex (≈500 MB, ~4750 nodes) takes ~20 ms.
4. **Persistence** = the OPFS directory `nanobox-persist/` (Cache API `nanobox-persist` as the fallback):
   `packages/<key>.tar` + `.json` (immutable; `key = pkg-<name>@<version>`, `/`→`~`) and
   `journal/<time>-<n>.tar` (guest writes, below). The persist worker hands the VM worker `{packages,
   journals}` (ArrayBuffers *transferred*, no copies) and, for `cli=claude`, copies of claude's package +
   the journals to the runtime worker (its own rootfs copy is what the fast path serves cli.js from;
   `runtimeCli` in the page's `open` message says whose — claude's or claude-native's).
   The second visit reads the tars from OPFS (~100–300 ms for 500 MB) and downloads nothing.
5. **The guest sees it as part of the image**: the VM worker keeps a second bundle subtree,
   `bundle/persist/{usr/local,root,home,var}`, built from the packages + journals before the container
   starts (the OCI layers, the engine download and the installer run in parallel; `NanoboxOci.load` is
   wrapped to wait for the persist worker only after the image is in). The runtime spec
   (`web/images/linux-base/config-vm.json` for claude — `/dev/hvc1` + `PATH=/bundle/nb:…` so
   `#!/usr/bin/env node` is the shim —, `config-persist.json` for codex/agy — plain PATH so a child
   `node` is the real `/usr/local/bin/node`) carries `mounts: [{destination:"/usr/local", type:"bind",
   source:"/mnt/wasi0/bundle/persist/usr/local", options:["rbind","rw"]}, …]`: the guest init mounts the
   built-in virtio-9p root device at `/mnt/wasi0`, and runc bind-mounts the four subtrees into the
   container. `/var` is seeded from the image (`var/tmp`), the rest start empty.
6. **Writes**: `wasifs.js` now implements the WASI mutators for nodes a `cfg.writable(path)` predicate
   admits (`path_open` O_CREAT/O_TRUNC/O_EXCL, `fd_write`/`fd_pwrite` — a written image file becomes a
   private growable buffer —, `fd_filestat_set_size`, `fd_allocate`, `path_create_directory`,
   `path_unlink_file`, `path_remove_directory`, `path_rename`, `path_symlink`, `path_link`,
   `*_set_times` accepted; EROFS elsewhere; WASI carries no mode: created files are 0644 / dirs 0755).
   `cfg.onChange` reports structure changes at once and content changes through `fs.flushDirty(quietMs)`
   once a written path has been quiet for 400 ms — pumped from the engine's `poll_oneoff` (the VM loop
   never yields) — because the guest's 9p client (`cache=loose`) writes back after `close`, through its
   own writeback fid; a rename re-paths the open fds under it so the late write dirties the NEW name.
   Each change becomes a tar record with OCI whiteouts (`NanoboxInstaller.journal.entries` /
   `tar.pack`, hard links share the node) posted to the persist worker, which batches records for
   1.5 s (`journal.compact`: last state per path) into `journal/<t>-<n>.tar`; on the next load the
   journals are applied after the packages (and compacted into one when there are more than 6).
   Verified in the guest (`?cli=sh`, `test/sandbox-probe.mjs`): create/append/truncate/mkdir/mv/cp/rm/ln
   -s persist across reloads; `~/.codex` written by a codex run is there for the next `sh`;
   `~/.claude.json` survives (Claude Code no longer asks the theme question on the second visit).
7. **The CLI starts** (`sh -c 'printf "\e]777;nb-booted\a"; exec …'` — an OSC xterm swallows and the page
   timestamps as "guest booted"): claude-native = `/usr/local/bin/claude` (the installer's `sh` launcher)
   → the shim → the runtime worker `importScripts` the extracted 26.6 MB entry as it stands (section
   below); claude = `/usr/local/bin/claude` → the shim → the runtime worker reads
   `cli.js` from its rootfs copy (13.7 MB), transforms it in ~170 ms (`esm2cjs.js`: the 872 minified
   `import…from"builtin"` statements → hoisted `require`s, `import.meta.url` → the file: URL, 13 dynamic
   `import()` → `__nbImport`; validated against esbuild's output) and `importScripts` it from a blob URL;
   codex = the platform package's binary directly (`…/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`
   with the env `bin/codex.js` would set) — no node process in between; agy = `/usr/local/bin/agy`.

## `?cli=claude-native`: the current build, extracted from the Bun standalone binary

`?cli=claude` installs `@anthropic-ai/claude-code@2.1.112` — the last release whose `bin` is a `cli.js`
that system node can run. Everything after it ships as a **Bun standalone executable** instead: one
324.6 MB `linux-x64/claude`. That binary is still mostly *our* kind of program — Bun stores the program's
JavaScript in it as plain text (ELF section `.bun`, NUL-terminated `\0/$bunfs/root/<name>\0<content>\0`
records; the `@bytecode` blob next to it is JavaScriptCore's cache, useless off JSC and not needed
because the source is complete). `web/native/bunfs.js` parses those records, `tools/bun-extract.mjs` is
the same parser as a host-side CLI (`node tools/bun-extract.mjs work/bun/claude-bun.bin --tail 64`).

So `?cli=claude-native` runs the CURRENT Claude Code the same way the npm build runs — its JavaScript on
the browser's V8, its syscalls in the guest — and the installer never downloads 324 MB:

| | |
|---|---|
| resolve | `GET …/claude-code-releases/latest` → `2.1.233`; `…/2.1.233/manifest.json` → `platforms["linux-x64"] = {binary, checksum, size: 324598064}`. Cached with the package (like the agy manifest): `?reset=1` re-resolves. |
| fetch | ONE `Range: bytes=257489200-324598063` request = the last 64 MiB (`NanoboxBunFs.SEARCH_TAIL_BYTES`) — **67.1 of 324.6 MB, 20.7 %**. The sources start 36.4 MB before EOF, so the tail always contains them; if the entry is not in the slice the installer retries once with a 4× bigger one (256 MiB) before falling back to bunfs.js' "biggest `// @bun`-wrapped module" heuristic — a truncated slice still holds OTHER wrapped modules (`audio-capture.js` & co are 2 KB each), so the entry is looked up by the name the catalog knows, `/$bunfs/root/cli`. |
| extract | 11 modules. The entry is the one Bun named `/$bunfs/root/cli` (26.6 MB). |
| install | `/usr/local/lib/claude-native/cli.js` = the entry **verbatim** — it is a `// @bun` banner + `(function(exports, require, module, __filename, __dirname){…})` expression, and the runtime evaluates that wrapper as it stands (no esm2cjs transform: the page logs `bundle-bun-cjs`, ~84 ms, instead of `bundle-transformed`). `/$bunfs/root/{mermaid.min.js, hljsBundle.generated.min.js, chart.umd.min.js, payload.template.html.asset, *.js, *.node}` = every other module at the literal path the bundle opens it by. `/usr/local/bin/claude` (755) = `#!/bin/sh` + `exec /bundle/nb/node /usr/local/lib/claude-native/cli.js "$@"` — the guest-side shim, so the runtime worker learns the script from the HELLO argv exactly as for the npm build. |
| persist | The extracted files are packed into ONE tar at install time (`meta.kind = "files"`, paths relative to `/`) and stored like any other package: `packages/pkg-claude-native@2.1.233.tar` (33.4 MB) + `.json`. The second visit reads that tar and downloads nothing. |
| the guest | `$bunfs` is a persist root (`NanoboxInstaller.PERSIST_ROOTS`, `build-linux-base.sh` `PERSIST`), bind-mounted at `/$bunfs` by both specs, so the guest really has `/$bunfs/root/*` — verified with `?cli=sh&install=claude-native`. Reads by the CLI itself never leave the host: the runtime worker holds the same tree and answers them from memory. |

**Integrity, honestly stated.** The manifest's sha256 is over the WHOLE 324.6 MB binary and **cannot be
checked against a 67 MB slice**. What the store records instead (`packages/<key>.json`, `meta.source`) is
the version, the exact byte range `{start, end, bytes, of}`, the vendor's whole-file sha256 as
documentation (`fileSha256`, `fileSha256Verified: false`) and the **sha256 of the extracted entry** with
its length. `?cli=claude-native&verifyfull=1` (installer `opts.verifyFull`) does the real thing: it
downloads the whole binary, checks the vendor's sha256 and extracts from those bytes — 324.6 MB instead
of 67.1 and `fileSha256Verified: true` in the store. Exercised (both the match and a deliberate
mismatch) by `test/claude-native-unit.mjs`, where hashing the 324.6 MB costs 1.3 s; not measured in the
browser, where it also pushes 324.6 MB through the relay and the page's memory.

## Engine-side fixes this needed (coordinator, `bochs/bochs/wasm.cc` + init)

* 9p qids for nanobox host filesystems are now the nodes' stable inode numbers instead of a path hash:
  with `cache=loose` the guest's `write tmp; rename tmp target; read target` otherwise returned an empty
  file forever (dirty pages on the old qid, the new path a new inode cached empty) — every CLI writes
  configs that way (`~/.claude.json` "corrupted", npm staging dirs).
* `fs_lock`/`fs_getlock` succeed (single client): sqlite (`~/.codex/state_5.sqlite`) refused to open on
  the 9p tree with ENOLCK.
* `fs_setattr` accepts MODE/UID/GID (chmod was "Protocol error").

## Measured (headless Chrome 151, this devcontainer shared with the other bots' VMs)

`test/sandbox-matrix.sh` = per CLI a **cold** run (`?reset=1`: persistent tree + Cache API wiped, HTTP
cache disabled — a first visit) then a **warm** run (second visit). Timer split: *engine / image /
install ready* (all in parallel from page load), *VM start* (all three in → the container starts),
*guest boot* (→ the CLI is exec'd), *run → sign-in*.

| CLI | run | page load → sign-in | engine / image / install ready | VM start (load) | guest boot | run → sign-in | installer |
|---|---|---|---|---|---|---|---|
| claude | cold | **5.5 s** | 0.9 s / 1.2 s / 1.9 s | 1.9 s | 1.3 s | 2.3 s | 73.3 MB in 1.6 s |
| claude | warm | **4.8 s** | 0.8 s / 0.8 s / 0.8 s | 1.2 s | 1.4 s | 2.2 s | all from the store |
| codex | cold | **11.3 s** | 0.9 s / 0.8 s / 3.7 s | 3.8 s | 1.4 s | 6.1 s | 176.6 MB in 3.4 s |
| codex | warm | **8.0 s** | 0.7 s / 0.7 s / 0.9 s | 1.1 s | 1.5 s | 5.5 s | all from the store |
| agy | cold | **22.5 s** | 0.9 s / 0.8 s / 4.5 s | 4.5 s | 1.4 s | 16.7 s | 110.2 MB in 4.1 s |
| agy | warm | **20.3 s** | 0.8 s / 0.7 s / 0.7 s | 1.1 s | 1.4 s | 17.8 s | all from the store |
| claude-native | cold | (4.9 s to *bundle loaded*) | 0.9 s / 1.3 s / 3.0 s | 3.0 s | 1.2 s | shim HELLO 4.3 s → bundle loaded 0.6 s | 121.7 MB in 2.6 s |
| claude-native | warm | (3.0 s to *bundle loaded*) | 0.7 s / 0.7 s / 0.7 s | 1.0 s | 1.3 s | shim HELLO 2.4 s → bundle loaded 0.6 s | all from the store |

claude-native's runs stop at **`bundle-loaded`**, not at a sign-in screen: the runtime's `Bun.*` global
is still being built (the run reaches Claude Code's own code and asks for `Bun.which`, `fs.watchFile`,
`tls.getCACertificates`), so those two rows measure *install → the 26.6 MB bundle is loaded and running*
— `node test/e2e-sandbox.mjs --cli claude-native --until bundle`. Note the 26.6 MB entry needs **no
transform** (Bun already wrapped it as CJS): 84 ms to hand it to `importScripts` versus 163 ms of
esm2cjs for the npm build's 13.7 MB. Measured on a private origin (`serve.mjs --port 8099`) so the cold
run really is a first visit for that store; the shared :8093 numbers above were taken the same way.

(codex/agy: `run → sign-in` is the CLI's own startup in the emulated guest — the same 5–6 s / 16–18 s
the `vm.html` images take; the CLI's own JIT bundle from those images (`?clibundle=1`, content-keyed) buys
agy 0.5 s for 34 MB more from our origin, so it is off by default. claude: 1.3 s guest boot + 2.2 s
run, of which shim HELLO → bundle loaded ≈ 0.6 s (cli.js read + transform 0.17 s + importScripts 0.42 s)
and the rest is Claude Code's startup with ~225 synchronous round trips into the guest.) The cold runs
show what the vendors' servers and this network give (73–177 MB in 1.5–4.1 s here); the second visit
downloads nothing (`install: … from the store (opfs)`).

## Data accounting

Bytes on the wire per origin (own counters on every `fetch` in the page and the three workers, plus
`PerformanceResourceTiming` for scripts; "from browser caches" = served by the Cache API / HTTP cache,
no transfer). Vendors "direct" = fetched by the browser itself (CORS), "relayed" = through
`POST /net/fetch` (content from the vendor, wire bytes on our server) — with the proxy extension
installed those become `extension` routes.

| CLI | run | our origin MB (wire) | of which | ours from browser caches MB | vendors direct MB | of which | vendors relayed MB | of which |
|---|---|---|---|---|---|---|---|---|
| claude | cold | **49.2** | engine 29.8, jit-bundles 12.8, image 3.9, runtime/pages 2.7, shim 0.1, spec 0.0 | 0.0 | **73.5** | registry.npmjs.org 73.3, raw.githubusercontent.com 0.2 | **0.0** | api.anthropic.com 0.0, platform.claude.com 0.0 |
| claude | warm | **0.0** | runtime/pages 0.0, spec 0.0, image 0.0, jit-bundles 0.0, engine 0.0, shim 0.0 | 51.4 | **0.2** | raw.githubusercontent.com 0.2 | **0.0** | api.anthropic.com 0.0, platform.claude.com 0.0 |
| codex | cold | **47.0** | engine 29.8, jit-bundles 12.8, image 3.9, runtime/pages 0.5, spec 0.0 | 0.0 | **176.6** | registry.npmjs.org 176.6, api.github.com 0.0, files.openai.com 0.0 | **0.0** | chatgpt.com 0.0 |
| codex | warm | **0.0** | runtime/pages 0.0, spec 0.0, image 0.0, jit-bundles 0.0, engine 0.0 | 51.3 | **0.0** | api.github.com 0.0, raw.githubusercontent.com 0.0, files.openai.com 0.0 | **0.0** | chatgpt.com 0.0 |
| agy | cold | **47.0** | engine 29.8, jit-bundles 12.8, image 3.9, runtime/pages 0.5, spec 0.0 | 0.0 | **55.0** | registry.npmjs.org 54.6, antigravity-unleash.goog 0.4, playwright.azureedge.net 0.0, playwright-akamai.azureedge.net 0.0, playwright-verizon.azureedge.net 0.0 | **55.6** | antigravity-cli-auto-updater-974169037036.us-central1.run.app 0.0, storage.googleapis.com 55.6, play.googleapis.com 0.0 |
| agy | warm | **0.0** | runtime/pages 0.0, spec 0.0, image 0.0, jit-bundles 0.0, engine 0.0 | 51.3 | **0.4** | antigravity-unleash.goog 0.4, playwright.azureedge.net 0.0, playwright-akamai.azureedge.net 0.0, playwright-verizon.azureedge.net 0.0 | **0.0** | play.googleapis.com 0.0 |
| claude-native | cold | **49.5** | engine 29.8, jit-bundles 12.8, image 3.9, runtime/pages 3.0, shim 0.1, spec 0.0 | 0.0 | **54.6** | registry.npmjs.org 54.6 (node + npm only) | **67.1** | downloads.claude.ai 67.1 (the binary's tail; 324.6 MB not fetched) |
| claude-native | warm | **0.0** | runtime/pages 0.0, spec 0.0, image 0.0, jit-bundles 0.0, engine 0.0, shim 0.0 | 51.4 | **0.0** | | **0.0** | |

Our origin, cold: engine 29.8 (slim) + kernel JIT bundle 12.8 + image 3.9 + runtime.js/pages/xterm
2.7 + shim 0.06 MB (+ imagemounter 7.8 MB, fetched by `runcontainer.js` for the network stack — the
page's resource timing shows it under runtime/pages when it is not HTTP-cached); warm: ~0 on the wire.
Vendors, cold: node 51.6 + npm 3.0 + the CLI (claude 18.7 / codex 122.0 / agy 55.6 relayed) MB, plus
what the CLI itself fetches on the way to sign-in (raw.githubusercontent CHANGELOG 0.2 MB, api hosts a
few KB); warm: only the CLI's own requests.

## Gaps / caveats

* Writes reach the host tree only when the guest's 9p client writes them back (close + ≤ a few hundred
  ms; long-open files at the writeback interval): closing the tab right after a write can lose it. A
  `beforeunload` sync would need guest cooperation (the shim could `sync`); not done.
* The runtime worker's fast path serves image/package files from its own copy: a file the guest
  modifies under `/usr/local` during the session (`npm i -g` in the guest) is picked up by the JS
  layer only after a reload (journals are applied there too). Same limitation as before for image paths.
* Only the packages of the requested `install=` list (+ node) are mounted; other CLIs installed earlier
  by another page stay in the store but are not visible in this guest (`?install=claude,codex,agy`
  mounts all — ~530 MB unpacked in the VM worker's memory).
* Package versions are pinned in `NanoboxInstaller.CATALOG` (2.1.112 / 0.147.0 / node 22.23.2 /
  npm 10.9.8); the agy manifest and claude-native's `latest` + `manifest.json` are cached with the
  package (`?reset=1` re-resolves — that is also how you pick up a new claude-native release).
* **claude-native's whole-binary checksum is not verified by default** (a slice cannot be hashed against
  it) — see the section above for what IS recorded, and `?verifyfull=1` for the full check.
* claude-native's three `.node` addons come out **truncated at their first NUL** (7 bytes: `\x7fELF…`):
  the embedded-file records are NUL-terminated, so binary content cannot be recovered by that parser.
  They cannot be loaded on the browser's V8 anyway (the same reason claude's `?sharp=1` is off); the JS
  wrappers next to them (`audio-capture.js`, `clipboard-napi.js`, `image-processor.js`) `require` them
  lazily, so the failure — if it ever happens — is at the feature, not at startup.
* claude-native still installs node + npm (51.6 + 3.0 MB) like every other target, although its own
  bundle never uses them; `NanoboxInstaller.install(clis, {noNode: true})` skips them (the unit test does).
* `chmod` in the guest → "Protocol error" until the setattr CTIME fix lands (codex warns "could not
  create PATH aliases", npm's chmod of bin targets would fail); modes are not journaled (WASI has none).
* Memory: the persist worker holds tgz + tar of a package while verifying/gunzipping (codex: 122 + 315
  MB, briefly), the VM worker keeps every mounted package's tar (views), the runtime worker a copy of
  claude's; the OPFS store holds the tars once (~560 MB with all three CLIs).
* No JIT bundle is recorded for `linux-base` yet (`test/record-bundles.sh` records per image); the
  kernel bundle applies.

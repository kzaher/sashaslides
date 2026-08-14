# nanobox

Run Linux in a browser tab, make a **folder you pick your VM's home**, mount extra directories, and
sync everything through a **unit-tested 3-way sync engine**. Tailscale gives the VM network egress.
Chromium only (needs the File System Access API). User-initiated by design.

```
node server.mjs          # http://localhost:8088   (COOP/COEP headers required by CheerpX)
```

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
| CheerpX + Tailscale backend | 🔩 scaffold — wire the 4 ADAPT regions (see above) |

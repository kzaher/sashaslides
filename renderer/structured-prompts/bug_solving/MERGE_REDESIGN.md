# Merge redesign — LLM-performed merge over overlayfs (no git)

Captured from the user's spec (2026-07-05). Replaces the git/patcher merge engine.

## 1. Branching = overlayfs, NO copying
- Each fork/branch is an **overlayfs mount**, not a git worktree, not a copy.
  `lowerdir` = the working tree; `upperdir`/`workdir` = an ext4 **`/overlays`** volume
  (the container's `/tmp`,`/`,`/home` are all overlay → nested-overlay upper is
  rejected, so upper MUST be on a real fs volume).
- Requires `--cap-add=SYS_ADMIN --security-opt=apparmor=unconfined` (added to
  devcontainer runArgs) + the `sashaslides-overlays`→`/overlays` volume. Mounts via
  `sudo` (`node` has passwordless sudo).
- **Honor `.gitignore`**: the merge/stability diff scopes to tracked files
  (`git ls-files`), so ignored junk (node_modules) rides in the shared lower layer
  without being part of the state.
- **Remove `assertCleanTree`**: overlay is over the WORKING tree, so dirty files are
  naturally included — the "no dirty files" requirement is obsolete and deleted.
- RESOLVED (probe + primitive, 2026-07-05): overlay over the FUSE working tree WORKS.
  The FUSE `fakeowner` lower exposes files as `root:root`, so `node` can't write
  through a plain overlay — but inside a **user namespace** (`unshare -Urm
  --map-root-user`, node→root) it CAN. So each branch = an overlay mounted INSIDE a
  userns+mountns. ZERO copy, no export, no idmap tool. Copy-up is one-time, sub-ms for
  the small converter files. Consequence: the mount is namespace-local, so a branch's
  work (worker edits, render, capture, merge writes) must run INSIDE that unshare.
  Primitive: `scripts/overlay-branch.sh {run|changed|upper|rm} <id>` — tested real
  (edit isolated, base untouched, per-branch isolation, gitignore-honored diff).

## 2. Merge = LLM performs it (no git compose)
- **Try ALL green forks in ONE LLM merge** first (base + every green fork's version →
  one merged file).
- **If that fails → SEQUENTIAL**, merge one fork at a time. Successfully-merged forks
  are kept; forks the LLM can't merge are **discarded + demoted** (re-solve next round).
- CAREFUL: during serial merge, previously-merged forks CHANGE the target slide (it's
  now the new green state) — the next fork merges against the UPDATED state. **Needs
  special tests.**

## 3. Stability classification (at solve start, records every slide 3×)
- When main solving starts (parallel), record EVERY slide **three times**.
- Slides pixel-identical across all 3 → **pixel-perfect class** (solution must be
  pixel-perfect).
- Otherwise → **xml-stable class** (solution needs only XML stability).
- Print a **warning** listing slides not found stable.
- The stability code must **run independently** (standalone entrypoint).

## 4. Regression gate (end comparison, after solve + merge finish)
Two comparison functions for GREEN slides:
- **pixel-perfect class** → identical PIXELS required.
- **xml-stable class** → XML identical + rendered-parts pixel-perfect.
Plus:
- **Non-targeted slides** → compared against versions OUTSIDE the newly-green set
  (must not change).
- **Green slides** → identical to the **LGTM'd (user-approved) versions**.

## 5. Testing
- **Only slide recording + LLM may be mocked.** Everything else real (overlay, fs,
  stability, gate, ledger).
- E2E tests must exercise the **actual overlay setup** + **all edge cases**,
  especially serial-merge-target-mutation (#2).

## Status
- [x] devcontainer: SYS_ADMIN + apparmor=unconfined + `/overlays` volume
- [x] overlay probe (`.devcontainer/overlay-probe.sh`)
- [ ] AWAIT container restart → run probe → confirm overlay viable (or pick fallback)
- [ ] overlay branching module (mount/diff/cleanup, gitignore-scoped) + tests
- [ ] remove `assertCleanTree`
- [ ] LLM merge engine (all-at-once → sequential fallback) replacing patcher/git
- [ ] 3× stability classifier (standalone) + warnings
- [ ] dual regression gate (pixel-perfect vs xml-stable; targeted vs non-targeted)
- [ ] E2E over real overlay, mock only recording + LLM, all edge cases

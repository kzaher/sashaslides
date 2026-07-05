#!/usr/bin/env bash
# overlay-branch.sh — zero-copy COW branch of the working tree via overlayfs
# inside a user namespace (node→root mapping makes the FUSE lower writable).
#
# WHY a userns: /workspaces is a fakeowner FUSE mount; overlayfs exposes its
# files as root:root, so `node` can't edit them through a plain overlay. Inside
# `unshare -Urm --map-root-user`, node maps to root and CAN write — no copy, no
# idmap tool. The overlay is namespace-local, so the branch's work must run
# INSIDE this unshare (that's the whole point of `run`).
#
# Layers live on the /overlays ext4 volume (the container's /tmp,/ are overlay →
# nested-overlay upper is rejected, volumes are real ext4).
#
# Usage:
#   overlay-branch.sh run   <branch-id> <cmd...>   # run cmd in the branch (cwd=merged root)
#   overlay-branch.sh upper <branch-id>            # print the upperdir (changed files, node-owned)
#   overlay-branch.sh changed <branch-id>          # list changed TRACKED files (gitignore-honored)
#   overlay-branch.sh rm    <branch-id>            # drop the branch (upper/work)
#   overlay-branch.sh cleanup-all                  # unmount + drop ALL branches (engine death / startup sweep)
set -uo pipefail
REPO="${OVERLAY_BRANCH_REPO:-/workspaces/sashaslides}"
ROOT="${OVERLAY_BRANCH_ROOT:-/overlays/branches}"
cmd="${1:?run|upper|changed|rm|cleanup-all}"; shift || true

if [ "$cmd" = "cleanup-all" ]; then
  # Per-branch overlay mounts are namespace-local (they vanish when their `run`
  # unshare exits), so normally only the on-disk upper/work dirs remain. This
  # reaps those + defensively unmounts any merged mount that somehow leaked into
  # the host namespace. Idempotent + best-effort (never fails the caller).
  if [ -d "$ROOT" ]; then
    for m in "$ROOT"/*/merged; do
      [ -d "$m" ] || continue
      mountpoint -q "$m" 2>/dev/null && { umount -l "$m" 2>/dev/null || sudo umount -l "$m" 2>/dev/null; }
    done
    rm -rf "$ROOT"/* 2>/dev/null || sudo rm -rf "$ROOT"/* 2>/dev/null || true
  fi
  exit 0
fi

id="${1:?branch-id}"; shift || true
b="$ROOT/$id"

case "$cmd" in
  run)
    mkdir -p "$b"/{upper,work,merged}
    # Everything overlay-related happens INSIDE one userns+mountns. The mount is
    # only visible here; the child cmd runs with cwd = the merged view.
    exec unshare -Urm --map-root-user bash -c '
      set -e
      mount -t overlay overlay -o "lowerdir='"$REPO"',upperdir='"$b"'/upper,workdir='"$b"'/work" "'"$b"'/merged"
      cd "'"$b"'/merged"
      "$@"
    ' bash "$@"
    ;;
  upper)   echo "$b/upper" ;;
  changed)
    # Files present in upper = what the branch changed. Scope to TRACKED files
    # (git ls-files at the repo) so ignored junk (node_modules) is never counted.
    if [ ! -d "$b/upper" ]; then exit 0; fi
    ( cd "$b/upper" && find . -type f 2>/dev/null | sed 's|^\./||' ) | sort > /tmp/ob-upper-$id.txt
    ( cd "$REPO" && git ls-files ) | sort > /tmp/ob-tracked-$id.txt
    comm -12 /tmp/ob-upper-$id.txt /tmp/ob-tracked-$id.txt
    rm -f /tmp/ob-upper-$id.txt /tmp/ob-tracked-$id.txt
    ;;
  rm)      rm -rf "$b" ;;
  *) echo "unknown: $cmd" >&2; exit 2 ;;
esac

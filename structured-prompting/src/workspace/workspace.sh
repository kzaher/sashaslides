#!/usr/bin/env bash
# workspace.sh — zero-copy COW workspace over an arbitrary base tree via
# overlayfs inside a user namespace (node→root mapping makes a FUSE-backed
# lower writable). This is the GENERIC runner behind the structured-prompting
# `cow-workspace` library; it carries NO project-specific knowledge — the only
# assumptions are a Linux user namespace and an ext4 `upperRoot`.
#
# WHY a userns: a base tree on a fakeowner FUSE mount (e.g. a devcontainer's
# /workspaces) exposes its files as root:root through a plain overlay, so an
# unprivileged user can't edit them. Inside `unshare -Urm --map-root-user` the
# caller maps to root and CAN write — no copy, no idmap tool. The overlay is
# namespace-local, so the workspace's work must run INSIDE this unshare (that's
# the whole point of `run`). NO chroot is used (it breaks worker CLIs).
#
# WHY the upper must be ext4: layers live on the `upperRoot` volume. If a
# container's / and /tmp are themselves overlay mounts, a nested-overlay upper
# is rejected by the kernel — point `upperRoot` at a real ext4 volume
# (e.g. a mounted `/overlays`).
#
# REQUIREMENTS: CAP_SYS_ADMIN (`--cap-add=SYS_ADMIN` + `--security-opt
# apparmor=unconfined` on the container) and an ext4 `upperRoot`.
#
# ENV CONTRACT (COW_WORKSPACE_* preferred; OVERLAY_BRANCH_* honored for
# backward compat):
#   COW_WORKSPACE_BASE / OVERLAY_BRANCH_REPO   base (lower) tree  [default /workspaces/sashaslides]
#   COW_WORKSPACE_ROOT / OVERLAY_BRANCH_ROOT   where workspaces live [default /overlays/branches]
#
# Usage:
#   workspace.sh run     <id> <cmd...>   # run cmd in the workspace (cwd=merged root)
#   workspace.sh upper   <id>            # print the upperdir (changed files, caller-owned)
#   workspace.sh ensure  <id>            # create upper/work/merged dirs (no mount); print upperdir
#   workspace.sh changed <id>            # list changed files (git-tracked+gitignore-honored if base is a git repo, else all upper files)
#   workspace.sh rm      <id>            # drop the workspace (upper/work)
#   workspace.sh cleanup-all             # unmount + drop ALL workspaces (engine death / startup sweep)
set -uo pipefail
BASE="${COW_WORKSPACE_BASE:-${OVERLAY_BRANCH_REPO:-/workspaces/sashaslides}}"
ROOT="${COW_WORKSPACE_ROOT:-${OVERLAY_BRANCH_ROOT:-/overlays/branches}}"
cmd="${1:?run|upper|ensure|changed|rm|cleanup-all}"; shift || true

if [ "$cmd" = "cleanup-all" ]; then
  # Per-workspace overlay mounts are namespace-local (they vanish when their
  # `run` unshare exits), so normally only the on-disk upper/work dirs remain.
  # This reaps those + defensively unmounts any merged mount that somehow leaked
  # into the host namespace. Idempotent + best-effort (never fails the caller).
  if [ -d "$ROOT" ]; then
    for m in "$ROOT"/*/merged; do
      [ -d "$m" ] || continue
      mountpoint -q "$m" 2>/dev/null && { umount -l "$m" 2>/dev/null || sudo umount -l "$m" 2>/dev/null; }
    done
    rm -rf "$ROOT"/* 2>/dev/null || sudo rm -rf "$ROOT"/* 2>/dev/null || true
  fi
  exit 0
fi

id="${1:?workspace-id}"; shift || true
b="$ROOT/$id"

# The upperRoot volume may be root-owned on a fresh container start; self-heal so
# the caller can create workspace dirs (idempotent, only sudo-chowns when needed).
ensure_root_writable() {
  [ -d "$ROOT" ] && [ -w "$ROOT" ] && return 0
  sudo mkdir -p "$ROOT" 2>/dev/null || return 1
  sudo chown -R "$(id -u):$(id -g)" "$(dirname "$ROOT")" 2>/dev/null || sudo chown -R "$(id -u):$(id -g)" "$ROOT" 2>/dev/null
}

case "$cmd" in
  run)
    ensure_root_writable
    mkdir -p "$b"/{upper,work,merged}
    # Everything overlay-related happens INSIDE one userns+mountns. The mount is
    # only visible here; the child cmd runs with cwd = the merged view.
    exec unshare -Urm --map-root-user bash -c '
      set -e
      mount -t overlay overlay -o "lowerdir='"$BASE"',upperdir='"$b"'/upper,workdir='"$b"'/work" "'"$b"'/merged"
      cd "'"$b"'/merged"
      "$@"
    ' bash "$@"
    ;;
  upper)   echo "$b/upper" ;;
  ensure)
    ensure_root_writable
    mkdir -p "$b"/{upper,work,merged}
    echo "$b/upper"
    ;;
  changed)
    # Files present in upper = what the workspace changed. If the base is a git
    # repo, scope to TRACKED files (git ls-files at the base) so ignored junk
    # (node_modules) is never counted. If the base is NOT a git repo (generic
    # use), report every file in upper.
    if [ ! -d "$b/upper" ]; then exit 0; fi
    ( cd "$b/upper" && find . -type f 2>/dev/null | sed 's|^\./||' ) | sort > /tmp/cw-upper-$id.txt
    if git -C "$BASE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      ( cd "$BASE" && git ls-files ) | sort > /tmp/cw-tracked-$id.txt
      comm -12 /tmp/cw-upper-$id.txt /tmp/cw-tracked-$id.txt
      rm -f /tmp/cw-tracked-$id.txt
    else
      cat /tmp/cw-upper-$id.txt
    fi
    rm -f /tmp/cw-upper-$id.txt
    ;;
  rm)      rm -rf "$b" ;;
  *) echo "unknown: $cmd" >&2; exit 2 ;;
esac

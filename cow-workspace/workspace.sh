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
    #
    # The COW overlay is mounted OVER THE BASE PATH ITSELF (namespace-local), so
    # the child's cwd is the REAL base path (e.g. /workspaces/sashaslides), not an
    # /overlays/... mountpoint. This keeps a worker CLI's project identity (claude
    # files sessions under a cwd-derived project slug) correct, so `claude --resume`
    # + the monitor find them. Outside the namespace the real base is untouched.
    #
    # JAIL MODE (opt-in via COW_WORKSPACE_JAIL=1) — contain the child's writes:
    #   - COW-overlay the base (repo) → repo edits are sandboxed + disposable.
    #   - Each path in COW_WORKSPACE_OVERLAY_EXTRA (colon-sep) is ALSO COW-overlaid.
    #   - Each path in COW_WORKSPACE_SHARE_RW (colon-sep) is left SHARED READ-WRITE
    #     — the worker CLI's own state (~/.claude/~/.codex sessions) MUST persist to
    #     the real fs so the monitor + `claude --resume` can read them; it is not
    #     repo state. These are separate mounts, so the ro-lockdown (which is
    #     non-recursive) leaves them writable.
    #   - tmpfs /tmp (disposable), then remount the rest of the fs READ-ONLY.
    # The /overlays volume (uppers) is a separate mount → stays rw. NO chroot.
    # When COW_WORKSPACE_JAIL is unset the jail block is skipped.
    export _CW_JAIL="${COW_WORKSPACE_JAIL:-}" _CW_EXTRA="${COW_WORKSPACE_OVERLAY_EXTRA:-}" \
           _CW_SHARE="${COW_WORKSPACE_SHARE_RW:-}" _CW_B="$b" _CW_BASE="$BASE"
    exec unshare -Urm --map-root-user bash -c '
      set -e
      mount -t overlay overlay -o "lowerdir=$_CW_BASE,upperdir=$_CW_B/upper,workdir=$_CW_B/work" "$_CW_BASE"
      if [ -n "$_CW_JAIL" ]; then
        mount --make-rprivate / 2>/dev/null || true
        i=0; IFS=":"; for p in $_CW_EXTRA; do
          if [ -d "$p" ]; then
            mkdir -p "$_CW_B/extra$i/upper" "$_CW_B/extra$i/work"
            mount -t overlay overlay -o "lowerdir=$p,upperdir=$_CW_B/extra$i/upper,workdir=$_CW_B/extra$i/work" "$p" 2>/dev/null || true
          fi
          i=$((i+1))
        done; unset IFS
        mount -t tmpfs tmpfs /tmp 2>/dev/null || true
        # lockdown: remount root READ-ONLY (non-recursive → shared-rw submounts,
        # overlays, tmpfs, /overlays all stay writable).
        mount -o remount,bind,ro / 2>/dev/null || mount -o remount,ro / 2>/dev/null || true
        # re-assert SHARE_RW paths writable in case they sit on the / mount (bind
        # them rw so the worker CLI can persist its session state to the real fs).
        IFS=":"; for p in $_CW_SHARE; do
          [ -d "$p" ] && { mount -o remount,bind,rw "$p" 2>/dev/null || mount --bind "$p" "$p" 2>/dev/null || true; }
        done; unset IFS
      fi
      cd "$_CW_BASE"
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

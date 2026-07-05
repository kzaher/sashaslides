#!/usr/bin/env bash
# overlay-probe.sh — run AFTER the container restart (with --cap-add=SYS_ADMIN
# --security-opt=apparmor=unconfined + the /overlays ext4 volume) to determine
# whether the overlayfs "branch without copying" approach is actually possible in
# THIS Docker-Desktop-for-Mac environment. It answers, empirically:
#   1. Can we mount overlayfs at all (SYS_ADMIN granted)?
#   2. Baseline: lower on a REAL fs (/overlays volume) + upper/work on /overlays.
#   3. THE question: lower = the FUSE-mounted working tree (/workspaces/...),
#      upper/work on the /overlays ext4 volume. overlayfs may reject a FUSE lower.
#   4. Merged view shows base files read-through; writes land in upper only
#      (base untouched) — proving copy-free isolation.
# Prints a clear verdict per case. Non-destructive (mounts under /overlays/probe,
# unmounts + cleans up). Requires passwordless sudo (present for `node`).
set -uo pipefail
OV=/overlays/probe
WS=/workspaces/sashaslides
pass=0; fail=0
say() { printf '  %s %s\n' "$1" "$2"; }
ok()  { pass=$((pass+1)); say "✓" "$1"; }
no()  { fail=$((fail+1)); say "✗" "$1"; }

cleanup() { sudo umount "$OV"/*/merged 2>/dev/null; sudo rm -rf "$OV" 2>/dev/null; }
trap cleanup EXIT
cleanup; mkdir -p "$OV"

echo "== overlay probe =="
echo "-- fs types --"
say "•" "/workspaces → $(findmnt -no FSTYPE --target "$WS" 2>/dev/null)"
say "•" "/overlays  → $(findmnt -no FSTYPE --target /overlays 2>/dev/null || echo MISSING)"

if [ ! -d /overlays ]; then no "/overlays volume not mounted — add the volume + restart"; echo "verdict: $pass pass, $fail fail"; exit 1; fi

# 1) SYS_ADMIN / mount capability + 2) baseline real-fs lower
mk() { local n="$1"; mkdir -p "$OV/$n"/{lower,upper,work,merged}; }
mk base; echo "base-lower" > "$OV/base/lower/f.txt"
if sudo mount -t overlay overlay -o "lowerdir=$OV/base/lower,upperdir=$OV/base/upper,workdir=$OV/base/work" "$OV/base/merged" 2>/tmp/ov-base.err; then
  ok "(1+2) overlay mounts with real-fs lower+upper on /overlays"
  [ "$(cat "$OV/base/merged/f.txt" 2>/dev/null)" = "base-lower" ] && ok "(2b) read-through lower OK" || no "(2b) read-through failed"
  echo "w" > "$OV/base/merged/new.txt"
  [ -f "$OV/base/upper/new.txt" ] && [ ! -f "$OV/base/lower/new.txt" ] && ok "(2c) write isolates to upper (base untouched)" || no "(2c) write leaked to lower"
  sudo umount "$OV/base/merged"
else
  no "(1) overlay mount FAILED even with real-fs layers — $(cat /tmp/ov-base.err)"
fi

# 3) THE question: FUSE lower = the working tree, upper/work on /overlays volume
mk ws
if sudo mount -t overlay overlay -o "lowerdir=$WS,upperdir=$OV/ws/upper,workdir=$OV/ws/work" "$OV/ws/merged" 2>/tmp/ov-ws.err; then
  ok "(3) OVERLAY OVER THE WORKING TREE WORKS — FUSE lowerdir accepted 🎉 (copy-free branching viable)"
  [ -f "$OV/ws/merged/package.json" ] && ok "(3b) repo visible through overlay (package.json read-through)" || no "(3b) repo not visible"
  echo "// probe" >> "$OV/ws/merged/README.md" 2>/dev/null && [ -f "$OV/ws/upper/README.md" ] && ok "(3c) edit lands in upper, base README untouched" || no "(3c) edit did not isolate"
  sudo umount "$OV/ws/merged"
else
  no "(3) FUSE lowerdir REJECTED — $(cat /tmp/ov-ws.err | tr '\n' ' ')"
  echo "     → overlay-over-working-tree is NOT possible; fallback = repo on a volume, or a one-time export to /overlays lower (tracked files only, honoring .gitignore)."
fi

echo "verdict: $pass pass, $fail fail"
[ "$fail" -eq 0 ] && echo "RESULT: overlay branching fully viable — proceed with the overlay merge redesign." \
                  || echo "RESULT: see failures above; (3) failing means we need the fallback path."

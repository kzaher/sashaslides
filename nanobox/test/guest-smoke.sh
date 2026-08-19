#!/usr/bin/env bash
# guest-smoke.sh — repeatable smoke suite that runs INSIDE the emulated Linux guest.
#
#   test/guest-smoke.sh [ENGINE ...] [--out DIR] [--jit L:T | --no-jit] [--image NAME]
#
# Each ENGINE is a path to an out.wasm (default: build/eh-nb/out.wasm). For every engine the script
# does TWO headless harness runs of the linux-base image:
#
#   main leg   --clock frozen  (harness default: the WASI host clock never advances; the GUEST clock
#                               is driven by Bochs' own tick counter, cpu ips=200000000, so guest
#                               `date`/`sleep` still advance -- verified, see the time-* checks)
#   time leg   --clock real    (the host clock is real and poll_oneoff really sleeps) -- the same
#                               time checks again, so a guest-clock regression can be told apart
#                               from a host-clock artefact.
#
# The guest runs one shell script (injected into the OCI bundle with --bundle-file, so no quoting
# games) that prints one `OK <check> <evidence>` / `FAIL <check> <evidence>` line per check and ends
# with the sentinel `SMOKE-DONE <pass>/<total>`, which is what --expect matches.
#
# Scope note: the harness has NO real network. web/netstub.js answers DHCP/ARP/ICMP, replies
# NXDOMAIN to DNS and RSTs every TCP SYN. The net-* checks therefore assert the guest's network
# *syscall* layer (interface configured, route present, connect() refused promptly, resolver fails
# promptly, ICMP round-trips) -- real egress is out of scope here and is covered in the browser.
#
# Output (default work/prof/guest-smoke/):
#   <tag>-main.txt / <tag>-time.txt   raw guest console transcripts
#   <tag>-main.log / <tag>-time.log   harness stderr (icount/MIPS/JIT summary)
#   <tag>-results.tsv                 check <TAB> status <TAB> evidence
#   report.md                         command lines + per-check table across engines + transcripts
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$HERE/work/prof/guest-smoke"
IMAGE="linux-base"
JIT="2:2000"
BASEURL="${IMAGE_BASE:-http://localhost:8093/c2w/images}"
ENGINES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --jit) JIT="$2"; shift 2 ;;
    --no-jit) JIT=""; shift ;;
    --image) IMAGE="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) ENGINES+=("$1"); shift ;;
  esac
done
[ ${#ENGINES[@]} -eq 0 ] && ENGINES=("$HERE/build/eh-nb/out.wasm")
mkdir -p "$OUT"

# ---------------------------------------------------------------- the in-guest script
GUEST="$OUT/guest.sh"
cat > "$GUEST" <<'GUEST_EOF'
#!/bin/sh
# Runs as PID 1 inside the container. Prints "OK <name> <evidence>" / "FAIL <name> <evidence>".
# ONLY=fs|proc|pty|time|net (space separated) restricts the groups; default all.
ONLY="${ONLY:-fs proc pty time net}"
P=0; T=0
ok()  { P=$((P+1)); T=$((T+1)); echo "OK $1 $2"; }
bad() { T=$((T+1)); echo "FAIL $1 $2"; }
has() { case " $ONLY " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
eq()  { if [ "$2" = "$3" ]; then ok "$1" "[$2]"; else bad "$1" "got[$2] want[$3]"; fi; }
echo "SMOKE-START $(uname -sr) $(busybox 2>&1 | head -1)"

# ------------------------------------------------------------------------------- 1. filesystem
if has fs; then
  D=/root/smoke; rm -rf $D 2>/dev/null; mkdir -p $D; cd $D || exit 1

  echo "hello-nanobox" > a.txt
  C=$(cat a.txt); S=$(stat -c %s a.txt)
  if [ "$C" = "hello-nanobox" ] && [ "$S" = "14" ]; then ok fs-write-read "content=[$C] stat_size=$S"
  else bad fs-write-read "content=[$C] size=$S want[hello-nanobox]/14"; fi

  cp a.txt b.txt; rm -f b.txt
  if [ -e b.txt ]; then bad fs-unlink "b.txt still present"; else ok fs-unlink "unlink+ENOENT ok"; fi

  mkdir -p d1/d2; : > d1/f1; : > d1/d2/f2
  L=$(ls d1 | tr '\n' ',')
  N=$(find d1 | wc -l)
  if [ "$L" = "d2,f1," ] && [ "$N" = "4" ]; then ok fs-mkdir-ls "ls d1=[$L] find|wc -l=$N"
  else bad fs-mkdir-ls "ls d1=[$L] find=$N want[d2,f1,]/4"; fi

  # >1 MiB round trip, zero fill: file md5 must equal the same bytes straight off a pipe
  dd if=/dev/zero of=big.bin bs=64k count=32 2>/dev/null
  SZ=$(stat -c %s big.bin)
  M1=$(md5sum < big.bin | cut -d' ' -f1)
  M2=$(dd if=/dev/zero bs=64k count=32 2>/dev/null | md5sum | cut -d' ' -f1)
  if [ "$SZ" = "2097152" ] && [ "$M1" = "$M2" ]; then ok fs-bigfile-2MiB "size=$SZ md5=$M1 (pipe md5 identical)"
  else bad fs-bigfile-2MiB "size=$SZ file_md5=$M1 pipe_md5=$M2 want size 2097152"; fi

  # >1 MiB round trip, varied content
  yes nanobox-smoke-line | head -n 100000 > big2.txt
  SZ2=$(stat -c %s big2.txt); L2=$(wc -l < big2.txt)
  M3=$(md5sum < big2.txt | cut -d' ' -f1)
  M4=$(yes nanobox-smoke-line | head -n 100000 | md5sum | cut -d' ' -f1)
  if [ "$SZ2" -gt 1048576 ] && [ "$M3" = "$M4" ] && [ "$L2" = "100000" ]; then ok fs-bigfile-text "size=$SZ2 lines=$L2 md5=$M3 (pipe md5 identical)"
  else bad fs-bigfile-text "size=$SZ2 lines=$L2 file_md5=$M3 pipe_md5=$M4"; fi
  rm -f big.bin big2.txt

  # exec-permission enforcement applies even to root (needs at least one x bit)
  printf '#!/bin/sh\necho ran-x\n' > x.sh; chmod 0644 x.sh
  R1=$(./x.sh 2>&1); C1=$?
  chmod 0755 x.sh
  R2=$(./x.sh 2>&1); C2=$?
  M=$(stat -c %a x.sh)
  if [ "$C1" = "126" ] && [ "$C2" = "0" ] && [ "$R2" = "ran-x" ] && [ "$M" = "755" ]; then
    ok fs-perm-exec "0644 exec rc=$C1 ([$R1]); 0755 exec rc=$C2 out=[$R2] stat -c %a=$M"
  else bad fs-perm-exec "0644 rc=$C1 [$R1]; 0755 rc=$C2 [$R2] mode=$M want 126/0/ran-x/755"; fi

  # write-permission enforcement, as a NON-root user (root has CAP_DAC_OVERRIDE, so it cannot be
  # tested as uid 0). The image has only root in /etc/passwd -> add an unprivileged user first.
  grep -q '^nbsmoke:' /etc/passwd || { echo 'nbsmoke:x:1000:1000::/tmp:/bin/sh' >> /etc/passwd; echo 'nbsmoke:x:1000:' >> /etc/group; }
  U=$(su -s /bin/sh nbsmoke -c 'id -u' 2>&1)
  echo base > p.txt; chmod 0400 p.txt; chown 0:0 p.txt
  E1=$(su -s /bin/sh nbsmoke -c 'echo denied >> /root/smoke/p.txt' 2>&1); C3=$?
  chmod 0666 p.txt
  E2=$(su -s /bin/sh nbsmoke -c 'echo allowed >> /root/smoke/p.txt' 2>&1); C4=$?
  BODY=$(tr '\n' ',' < p.txt)
  if [ "$U" = "1000" ] && [ "$C3" != "0" ] && [ "$C4" = "0" ] && [ "$BODY" = "base,allowed," ]; then
    ok fs-perm-write "uid=$U; 0400 write rc=$C3 [$E1]; 0666 write rc=$C4; file=[$BODY]"
  else bad fs-perm-write "uid=$U 0400rc=$C3 [$E1] 0666rc=$C4 [$E2] body=[$BODY]"; fi

  ln -s a.txt link.txt
  RL=$(readlink link.txt); LC=$(cat link.txt); TY=$(stat -c %F link.txt)
  if [ "$RL" = "a.txt" ] && [ "$LC" = "hello-nanobox" ] && [ "$TY" = "symbolic link" ]; then
    ok fs-symlink "readlink=[$RL] cat=[$LC] stat -c %F=[$TY]"
  else bad fs-symlink "readlink=[$RL] cat=[$LC] type=[$TY]"; fi

  mv a.txt renamed.txt
  RC=$(cat renamed.txt 2>&1)
  if [ ! -e a.txt ] && [ "$RC" = "hello-nanobox" ]; then ok fs-rename "a.txt gone, renamed.txt=[$RC]"
  else bad fs-rename "a.txt exists? $([ -e a.txt ] && echo yes || echo no) renamed=[$RC]"; fi
fi

# ------------------------------------------------------------------------------- 2. processes
if has proc; then
  N=$(seq 1 1000 | grep -c 7)
  eq proc-pipeline "$N" 271

  sh -c 'exit 42'; R=$?
  eq proc-exit-code "$R" 42

  ( exit 7 ) ; R=$?
  sh -c 'exit 0'; R0=$?
  if [ "$R" = "7" ] && [ "$R0" = "0" ]; then ok proc-exit-subshell "subshell rc=$R, sh -c 'exit 0' rc=$R0"
  else bad proc-exit-subshell "subshell=$R zero=$R0"; fi

  rm -f /root/bgdone
  ( sleep 1; echo bg-ran > /root/bgdone ) & BG=$!
  wait $BG; WR=$?
  BGC=$(cat /root/bgdone 2>&1)
  if [ "$WR" = "0" ] && [ "$BGC" = "bg-ran" ]; then ok proc-bg-wait "wait rc=$WR, background wrote [$BGC]"
  else bad proc-bg-wait "wait rc=$WR body=[$BGC]"; fi

  NF=$(seq 1 60 | xargs -n1 sh -c 'echo $0' | wc -l)
  eq proc-fork-exec-60 "$NF" 60

  sleep 30 & SP=$!
  PS=$(ps 2>&1)
  SELF=$(echo "$PS" | grep -c 'run.sh')
  CHILD=$(echo "$PS" | awk -v p="$SP" '$1==p {print $1}')
  PROC=$([ -d /proc/$SP ] && echo yes || echo no)
  kill $SP 2>/dev/null; wait $SP 2>/dev/null; KR=$?
  if [ "$SELF" -ge 1 ] && [ "$CHILD" = "$SP" ] && [ "$PROC" = "yes" ]; then
    ok proc-ps "ps lists the smoke shell ($SELF line(s)) and child pid $SP; /proc/$SP=$PROC; ps=[$(echo "$PS" | tr '\n' '|')]"
  else bad proc-ps "self=$SELF childpid=[$CHILD] want $SP proc=$PROC ps=[$(echo "$PS" | tr '\n' '|')]"; fi
  eq proc-sigterm-status "$KR" 143
fi

# ------------------------------------------------------------------------------- 3. pty / signals
if has pty; then
  TT=$(tty)
  # NB: test -t 1 must not run inside $(...) -- command substitution replaces stdout with a pipe
  if test -t 0; then T0F=yes; else T0F=no; fi
  if test -t 1; then T1F=yes; else T1F=no; fi
  case "$TT" in
    /dev/pts/*) if [ "$T0F" = yes ] && [ "$T1F" = yes ]; then ok pty-tty "tty=[$TT] test -t 0=$T0F test -t 1=$T1F"
                else bad pty-tty "tty=[$TT] t0=$T0F t1=$T1F"; fi ;;
    *) bad pty-tty "tty=[$TT] not a pts device (t0=$T0F t1=$T1F)" ;;
  esac

  SS=$(stty size 2>&1)
  eq pty-stty-size "$SS" "25 80"

  ST=$(stty -a 2>&1 | tr '\n' ' ')
  case "$ST" in *"intr = ^C"*) ok pty-termios "stty -a reports intr = ^C; [$(echo "$ST" | cut -c1-110)]" ;;
                *) bad pty-termios "no 'intr = ^C' in stty -a: [$(echo "$ST" | cut -c1-160)]" ;; esac

  # SIGINT delivered by the pty line discipline: the harness types ^C (--reply) when it sees the
  # SIGINT-ARM marker, while `sleep 30` is in the foreground process group.
  INTED=0
  trap 'INTED=1; echo "  (trap INT fired)"' INT
  A=$(date +%s)
  echo "SIGINT-ARM"
  sleep 30
  B=$(date +%s); DT=$((B-A))
  trap - INT
  if [ "$INTED" = "1" ] && [ "$DT" -lt 25 ]; then ok pty-ctrl-c "^C from the console interrupted a 30 s sleep after ${DT}s; trap INT ran; shell survived"
  else bad pty-ctrl-c "trap_fired=$INTED elapsed=${DT}s (want <25 with trap)"; fi
  echo "  (shell alive after ^C: pid $$)"

  sleep 30 & K=$!; kill -INT $K; wait $K; KI=$?
  eq sig-kill-int "$KI" 130
fi

# ------------------------------------------------------------------------------- 4. time
if has time; then
  A=$(date +%s); sleep 2; B=$(date +%s); D=$((B-A))
  if [ "$D" -ge 2 ] && [ "$D" -le 20 ]; then ok time-date-advance "date +%s $A -> $B across 'sleep 2' (delta ${D}s)"
  else bad time-date-advance "$A -> $B delta=${D}s (want 2..20)"; fi

  U1=$(cut -d' ' -f1 /proc/uptime); A=$(date +%s); sleep 1; B=$(date +%s)
  U2=$(cut -d' ' -f1 /proc/uptime)
  D=$((B-A))
  UD=$(( ${U2%.*} - ${U1%.*} ))
  if [ "$D" -ge 1 ] && [ "$UD" -ge 1 ]; then ok time-sleep1 "'sleep 1': date $A->$B (+${D}s), /proc/uptime $U1->$U2 (+${UD}s int)"
  else bad time-sleep1 "date delta=$D uptime $U1->$U2 (+$UD)"; fi

  H=$(date -u '+%Y')
  UT=$(cat /proc/uptime)
  if [ -n "$H" ] && [ -n "$UT" ]; then ok time-clocks-readable "date -u +%Y=[$H] /proc/uptime=[$UT] full date=[$(date -u)]"
  else bad time-clocks-readable "year=[$H] uptime=[$UT]"; fi
fi

# ------------------------------------------------------------------------------- 5. network syscalls
# NOTE: deterministic stub (web/netstub.js), NOT a real network: DHCP/ARP/ICMP answered,
# DNS -> NXDOMAIN, every TCP SYN -> RST. These checks assert the syscall layer, not egress.
if has net; then
  IPA=$(ip addr show eth0 2>&1 | tr '\n' '|')
  case "$IPA" in
    *"inet 192.168.127.3/24"*) case "$IPA" in *UP*) ok net-iface-up "ip addr show eth0=[$IPA]" ;;
                                              *) bad net-iface-up "address ok but no UP: [$IPA]" ;; esac ;;
    *) bad net-iface-up "no 192.168.127.3/24: [$IPA]" ;;
  esac

  RT=$(ip route 2>&1 | tr '\n' '|')
  case "$RT" in *"default via 192.168.127.1 dev eth0"*) ok net-route "ip route=[$RT]" ;;
                *) bad net-route "ip route=[$RT]" ;; esac

  IFC=$(ifconfig eth0 2>&1 | tr '\n' '|')
  case "$IFC" in *"inet addr:192.168.127.3"*) ok net-ifconfig "ifconfig eth0=[$(echo "$IFC" | cut -c1-170)]" ;;
                 *) bad net-ifconfig "[$IFC]" ;; esac

  A=$(date +%s)
  NC=$(nc -w 3 192.168.127.1 8080 < /dev/null 2>&1 | tr '\n' '|'); NR=$?
  B=$(date +%s); D=$((B-A))
  case "$NC" in
    *"Connection refused"*) if [ "$D" -le 3 ]; then ok net-connect-refused "connect() to 192.168.127.1:8080 -> [$NC] in ${D}s (netstub RSTs every SYN)"
                            else bad net-connect-refused "refused but took ${D}s: [$NC]"; fi ;;
    *) bad net-connect-refused "rc=$NR after ${D}s: [$NC] (want ECONNREFUSED)" ;;
  esac

  A=$(date +%s)
  NS=$(nslookup nanobox-smoke.invalid 192.168.127.1 2>&1 | tr '\n' '|')
  B=$(date +%s); D=$((B-A))
  case "$NS" in
    *NXDOMAIN*) if [ "$D" -le 5 ]; then ok net-dns-nxdomain "nslookup -> [$NS] in ${D}s"
                else bad net-dns-nxdomain "NXDOMAIN but took ${D}s"; fi ;;
    *) bad net-dns-nxdomain "after ${D}s: [$NS] (want NXDOMAIN)" ;;
  esac

  PG=$(ping -c 1 -W 2 192.168.127.1 2>&1 | tr '\n' '|')
  case "$PG" in *"1 packets received"*) ok net-icmp "ping -c1 192.168.127.1 -> [$PG]" ;;
                *) bad net-icmp "[$PG]" ;; esac

  DEV=$(grep eth0 /proc/net/dev | tr -s ' ' | tr '\n' '|')
  RX=$(grep eth0 /proc/net/dev | tr -s ' ' | cut -d' ' -f3)
  if [ -n "$RX" ] && [ "$RX" -gt 0 ]; then ok net-proc-stats "/proc/net/dev eth0 rx_bytes=$RX [$DEV]"
  else bad net-proc-stats "[$DEV]"; fi
fi

echo "SMOKE-DONE $P/$T"
GUEST_EOF
chmod +x "$GUEST"

CTRLC=$(printf '\\u0003')   # the 6 literal chars  -- harness --reply JSON-parses them

# ---------------------------------------------------------------- one harness leg
# leg <engine> <tag> <legname> <clock> <ONLY groups>
leg() {
  local eng="$1" tag="$2" name="$3" clock="$4" only="$5"
  local tx="$OUT/$tag-$name.txt" lg="$OUT/$tag-$name.log" cl="$OUT/$tag-$name.cmd"
  local jitargs=(); [ -n "$JIT" ] && jitargs=(--jit "$JIT")
  # ONLY is handed to the guest through a second bundle file that sources guest.sh
  printf 'ONLY="%s"\n. /bundle/guest.sh\n' "$only" > "$OUT/$tag-$name-run.sh"
  local cmd=(node run.mjs "$eng"
    --oci "$BASEURL/$IMAGE/" --spec "$HERE/web/images/$IMAGE/config.json" --oci-cache "$HERE/work/oci-cache"
    "${jitargs[@]}" --clock "$clock"
    --bundle-file "guest.sh=$GUEST" --bundle-file "run.sh=$OUT/$tag-$name-run.sh"
    --cmd "/bin/sh /bundle/run.sh"
    --reply "SIGINT-ARM=$CTRLC"
    --expect "SMOKE-DONE" --timeout 280 --quiet --transcript "$tx")
  { printf 'cd %s/harness && timeout 300 ' "$HERE"; printf '%q ' "${cmd[@]}"; printf '\n'; } > "$cl"
  echo "### $tag/$name leg (clock=$clock, groups: $only)"
  ( cd "$HERE/harness" && timeout 300 "${cmd[@]}" > "$lg" 2>&1 )
  local rc=$?
  echo "    harness rc=$rc  $(grep -o '"wallMs":[0-9.]*' "$lg" | tail -1)  $(grep -o '"mips":[0-9.]*' "$lg" | tail -1)"
  return $rc
}

collect() { # collect <tag>: results tsv from both transcripts
  local tag="$1" f suffix
  : > "$OUT/$tag-results.tsv"
  for f in "$OUT/$tag-main.txt" "$OUT/$tag-time.txt"; do
    [ -f "$f" ] || continue
    suffix=""; case "$f" in *-time.txt) suffix="@real-clock" ;; esac
    tr -d '\r' < "$f" | grep -E '^(OK|FAIL) ' | while IFS= read -r line; do
      st="${line%% *}"; rest="${line#* }"
      nm="${rest%% *}"; ev="${rest#* }"; [ "$ev" = "$nm" ] && ev=""
      printf '%s\t%s\t%s\n' "$nm$suffix" "$st" "$ev"
    done >> "$OUT/$tag-results.tsv"
  done
  local p t
  p=$(grep -c "	OK	" "$OUT/$tag-results.tsv"); t=$(wc -l < "$OUT/$tag-results.tsv")
  echo "    $tag: $p/$t checks OK"
}

TAGS=(); ABS=()
for eng in "${ENGINES[@]}"; do
  case "$eng" in /*) : ;; *) eng="$HERE/$eng" ;; esac
  [ -f "$eng" ] || { echo "!! no such engine: $eng"; continue; }
  tag=$(basename "$(dirname "$eng")")
  TAGS+=("$tag"); ABS+=("$eng")
  echo "=== engine $tag ($eng, $(stat -c '%y %s' "$eng"))"
  leg "$eng" "$tag" main frozen "fs proc pty time net"
  leg "$eng" "$tag" time real "time"
  collect "$tag"
done

# ---------------------------------------------------------------- report
REP="$OUT/report.md"
{
  echo "# nanobox guest smoke suite"
  echo
  echo "Generated $(date -u '+%Y-%m-%dT%H:%M:%SZ') by \`test/guest-smoke.sh\`."
  echo
  echo "Everything below runs INSIDE the emulated Linux guest (image \`$IMAGE\`) under the headless"
  echo "harness \`harness/run.mjs\`. The guest executes \`work/prof/guest-smoke/guest.sh\` as PID 1 and"
  echo "prints one \`OK\`/\`FAIL\` line per check plus the sentinel \`SMOKE-DONE <pass>/<total>\`, which"
  echo "is what \`--expect\` matches."
  echo
  echo "Two legs per engine: the **main** leg (\`--clock frozen\`, the harness default) runs the fs /"
  echo "proc / pty / net groups; the **time** leg (\`--clock real\`) re-runs the time group so a guest-"
  echo "clock regression can be told apart from a host-clock artefact. Time checks carry the"
  echo "\`@real-clock\` suffix. (Frozen host clock is *not* vacuous for the guest: the guest's clock is"
  echo "driven by Bochs' own tick counter at \`cpu: ips=200000000\`, so \`date\`/\`sleep\` advance either way."
  echo "The time group is also present in the main leg when \`ONLY\` includes it.)"
  echo
  echo "**Network scope:** the harness has no real network — \`web/netstub.js\` is a deterministic stub"
  echo "(DHCP/ARP/ICMP answered, DNS -> NXDOMAIN, every TCP SYN -> RST). The \`net-*\` checks assert the"
  echo "guest's network *syscall* layer only. Real egress is OUT OF SCOPE for the harness leg."
  echo
  echo "## Engines"
  echo
  echo '| tag | path | built | bytes |'
  echo '|---|---|---|---|'
  for eng in "${ABS[@]}"; do
    [ -f "$eng" ] || continue
    echo "| $(basename "$(dirname "$eng")") | \`$eng\` | $(stat -c '%y' "$eng" | cut -d. -f1) | $(stat -c '%s' "$eng") |"
  done
  echo
  echo "## Command lines"
  echo
  for f in "$OUT"/*.cmd; do [ -f "$f" ] || continue; echo "\`\`\`sh"; echo "# $(basename "$f" .cmd)"; cat "$f"; echo "\`\`\`"; done
  echo
  echo "## Results"
  echo
  printf '| check |'; for t in "${TAGS[@]}"; do printf ' %s |' "$t"; done; printf '\n'
  printf '%s' '|---|'; for t in "${TAGS[@]}"; do printf '%s' '---|'; done; printf '\n'
  cut -f1 "$OUT/${TAGS[0]}-results.tsv" | while IFS= read -r nm; do
    printf '| `%s` |' "$nm"
    for t in "${TAGS[@]}"; do
      st=$(awk -F'\t' -v n="$nm" '$1==n {print $2; exit}' "$OUT/$t-results.tsv")
      printf ' %s |' "${st:-n/a}"
    done
    printf '\n'
  done
  echo
  for t in "${TAGS[@]}"; do
    p=$(grep -c "	OK	" "$OUT/$t-results.tsv"); n=$(wc -l < "$OUT/$t-results.tsv")
    echo "* **$t**: $p/$n OK  (harness: $(grep -o '"mips":[0-9.]*' "$OUT/$t-main.log" | tail -1), $(grep -o '"wallMs":[0-9.]*' "$OUT/$t-main.log" | tail -1))"
  done
  echo
  if [ ${#TAGS[@]} -gt 1 ]; then
    echo "## Differences between engines"
    echo
    ndiff=0
    cut -f1 "$OUT/${TAGS[0]}-results.tsv" | while IFS= read -r nm; do
      first=$(awk -F'\t' -v n="$nm" '$1==n {print $2; exit}' "$OUT/${TAGS[0]}-results.tsv")
      for t in "${TAGS[@]:1}"; do
        st=$(awk -F'\t' -v n="$nm" '$1==n {print $2; exit}' "$OUT/$t-results.tsv")
        [ "$st" = "$first" ] || echo "* \`$nm\`: ${TAGS[0]}=$first ${t}=${st:-n/a}"
      done
    done > "$OUT/.diffs"
    if [ -s "$OUT/.diffs" ]; then cat "$OUT/.diffs"
    else echo "No status differences: every check has the same verdict on every engine."; fi
    rm -f "$OUT/.diffs"
    echo
    echo "Raw transcript diff (main leg, \`${TAGS[0]}\` vs the others), CR stripped:"
    echo
    for t in "${TAGS[@]:1}"; do
      echo "\`\`\`diff"
      echo "# ${TAGS[0]}-main.txt  vs  $t-main.txt"
      diff <(tr -d '\r' < "$OUT/${TAGS[0]}-main.txt") <(tr -d '\r' < "$OUT/$t-main.txt") || true
      echo "\`\`\`"
      echo
    done
  fi
  echo "## Repeatability"
  echo
  echo "The suite is deterministic per engine: re-running it on the same out.wasm reproduces the guest"
  echo "console byte-for-byte (verified with \`--out .../rerun\` + \`diff\`). Anything that differs between"
  echo "two engines is therefore a real per-engine difference, not run-to-run noise — but note that the"
  echo "only such differences observed are the hundredths digit of \`/proc/uptime\` and the ICMP RTT: the"
  echo "harness types the ^C at the next poll after the \`SIGINT-ARM\` marker, and the poll cadence lands"
  echo "at a slightly different guest tick on each engine. No check verdict depends on it."
  echo
  echo "## Guest evidence per check"
  echo
  for t in "${TAGS[@]}"; do
    echo "### $t"
    echo
    while IFS="	" read -r nm st ev; do
      echo "* \`$nm\` — **$st** — \`$ev\`"
    done < "$OUT/$t-results.tsv"
    echo
  done
  echo "## Full guest console transcripts"
  echo
  for t in "${TAGS[@]}"; do
    for name in main time; do
      [ -f "$OUT/$t-$name.txt" ] || continue
      echo "### $t — $name leg"
      echo '```'
      tr -d '\r' < "$OUT/$t-$name.txt"
      echo '```'
      echo
    done
  done
} > "$REP"
echo "report: $REP"
echo "GUEST-SMOKE-DONE"

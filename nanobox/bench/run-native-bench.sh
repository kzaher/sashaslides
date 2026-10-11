#!/usr/bin/env bash
# Native grep(ugrep)/rg timing on the exact 256 MiB corpus the JS workers scan.
set -u
F=/workspaces/sashaslides/nanobox/public/bench/corpus.bin
D=/workspaces/sashaslides/nanobox/public/bench/parts
MIB=256

# warm page cache
cat "$F" > /dev/null 2>&1

bench() { # name  command-string
  local name="$1" cmd="$2" best=99999999 ms s e
  for i in 1 2 3 4 5 6; do
    s=$(date +%s%N); bash -c "$cmd" >/dev/null 2>&1; e=$(date +%s%N)
    ms=$(( (e - s) / 1000000 ))
    if [ "$i" -gt 1 ] && [ "$ms" -lt "$best" ]; then best=$ms; fi
  done
  local gib; gib=$(awk "BEGIN{printf \"%.2f\", ($MIB/1024)/($best/1000)}")
  printf '  %-34s %5d ms   %5s GiB/s   (count=%s)\n' "$name" "$best" "$gib" "$3"
}

echo "== single 256 MiB file =="
c=$(rg --count-matches NEEDLE "$F");                 bench "rg --count-matches (default)"      "rg --count-matches NEEDLE $F" "$c"
c=$(rg -j1 --count-matches NEEDLE "$F");             bench "rg -j1 --count-matches (1 thread)" "rg -j1 --count-matches NEEDLE $F" "$c"
c=$(grep -c NEEDLE "$F");                            bench "grep(ugrep) -c (default)"          "grep -c NEEDLE $F" "$c"
c=$(grep -J1 -c NEEDLE "$F");                        bench "grep(ugrep) -J1 -c (1 thread)"     "grep -J1 -c NEEDLE $F" "$c"
c=$(grep -o NEEDLE "$F" | wc -l);                    bench "grep -o | wc -l (occurrences)"     "grep -o NEEDLE $F | wc -l" "$c"

echo "== 64 x 4 MiB files (parallel across files) =="
rm -rf "$D"; mkdir -p "$D"; split -b 4194304 -d -a 2 "$F" "$D/p"
cat "$D"/* > /dev/null 2>&1
c=$(rg --count-matches NEEDLE "$D" | awk -F: '{s+=$2} END{print s}');    bench "rg dir (default -j)"        "rg --count-matches NEEDLE $D" "$c"
c=$(rg -j1 --count-matches NEEDLE "$D" | awk -F: '{s+=$2} END{print s}');bench "rg -j1 dir (1 thread)"      "rg -j1 --count-matches NEEDLE $D" "$c"
c=$(grep -rc NEEDLE "$D" | awk -F: '{s+=$2} END{print s}');             bench "grep(ugrep) -rc dir (default)" "grep -rc NEEDLE $D" "$c"
c=$(grep -J1 -rc NEEDLE "$D" | awk -F: '{s+=$2} END{print s}');         bench "grep(ugrep) -J1 -rc (1 thread)" "grep -J1 -rc NEEDLE $D" "$c"
rm -rf "$D"

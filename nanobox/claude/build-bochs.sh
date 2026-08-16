#!/usr/bin/env bash
# Build the Bochs (WASI) engine out of ./bochs with the toolchains under ./work/toolchain.
# Mirrors the `bochs-dev-*` stages of container2wasm v0.8.4's Dockerfile, but runs natively (no
# Docker) so an incremental rebuild takes ~1.5 minutes instead of the ~25 of the full pipeline.
#
#   ./build-bochs.sh [name] [--configure] [--no-wizer] [--pack DIR] [--legacy] [-- extra configure flags]
#
#   name          output basename (default: dev) -> build/<name>/out.wasm (+ intermediates)
#   --configure   re-run ./configure (needed after changing configure flags or the first time;
#                 also forced automatically when switching between --legacy and the default)
#   --pack DIR    the /pack contents to preinit with (default: work/pack-out/pack)
#   --legacy      the upstream toolchain: wasi-sdk 19 + Asyncify setjmp/longjmp + wizer 3 + wasi-vfs 0.3
#                 (default: wasi-sdk 33 + native wasm-EH setjmp/longjmp + wizer 11(EH) + wasi-vfs 0.6.3)
#
# Env knobs (all optional):
#   BX_OPT         optimisation flags, default "-O2" (the upstream build)
#   BX_ASYNCIFY    (--legacy only) 1 to run wasm-opt --asyncify (needed by the setjmp/longjmp shim)
#   BX_KEEP_NAMES  1 keep the wasm name section (for profiling)
#   BX_WASM_OPT    (default 1) run wasm-opt -O2 post-pass in the EH build (0 to skip)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TC="$HERE/work/toolchain"
SRC="${BX_SRC:-$HERE/bochs/bochs}"   # BX_SRC: alternate source tree (experiments)

NAME=dev; CONFIGURE=0; PACK="$HERE/work/pack-out/pack"; DO_WIZER=1; LEGACY=0; EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --configure) CONFIGURE=1 ;;
    --no-wizer) DO_WIZER=0 ;;
    --pack) PACK="$(cd "$2" && pwd)"; shift ;;
    --legacy) LEGACY=1 ;;
    --) shift; EXTRA=("$@"); break ;;
    -*) echo "unknown flag $1" >&2; exit 2 ;;
    *) NAME="$1" ;;
  esac
  shift
done
OUT="$HERE/build/$NAME"
mkdir -p "$OUT"
BX_OPT="${BX_OPT:--O2}"
BX_ASYNCIFY="${BX_ASYNCIFY:-1}"
BX_WASM_OPT="${BX_WASM_OPT:-1}"

log() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }

if [ "$LEGACY" = 1 ]; then
  WASI_SDK="$TC/wasi-sdk-19.0"; TARGET=wasm32-unknown-wasi
  WIZER="$TC/wizer-v3.0.1-x86_64-linux/wizer"; WIZER_ARGS=(--allow-wasi --wasm-bulk-memory=true -r _start=wizer.resume)
  WASI_VFS="$TC/wasi-vfs/wasi-vfs"; WASI_VFS_LIB="$TC/wasi-vfs/libwasi_vfs.a"
  WIZER_INC="$TC/wizer-include"
  BINARYEN="$TC/binaryen-version_114/bin"
  MODE_TAG=legacy
else
  WASI_SDK="$TC/wasi-sdk-33.0-x86_64-linux"; TARGET=wasm32-wasip1
  WIZER="$TC/wizer-eh"; WIZER_ARGS=(--allow-wasi --init-func wizer.initialize -r _start=wizer.resume)
  WASI_VFS="$TC/wasi-vfs-0.6.3/wasi-vfs"; WASI_VFS_LIB="$TC/wasi-vfs-0.6.3-nanobox/libwasi_vfs.a"  # patched: skips non-directory prestats (see work/wasi-vfs-src)
  WIZER_INC="$TC/wizer11-include"
  BINARYEN="$TC/binaryen-version_132/bin"
  MODE_TAG=eh
fi
CC="$WASI_SDK/bin/clang"; CXX="$WASI_SDK/bin/clang++"; SYSROOT="$WASI_SDK/share/wasi-sysroot"

# switching toolchains invalidates the configure cache + every object file
if [ -f "$SRC/.nanobox-mode" ] && [ "$(cat "$SRC/.nanobox-mode")" != "$MODE_TAG" ]; then
  log "toolchain mode changed -> full reconfigure"
  ( cd "$SRC" && make clean > /dev/null 2>&1 || true )
  CONFIGURE=1
fi
echo "$MODE_TAG" > "$SRC/.nanobox-mode"

# --- wasi_extra: setjmp/longjmp shim (legacy only) + poll_oneoff passthrough --------------------------
JMP="$OUT/jmp"; mkdir -p "$JMP"
if [ "$LEGACY" = 1 ]; then
  if [ ! -f "$JMP/jmp" ] || [ "$SRC/wasi_extra/jmp/jmp.c" -nt "$JMP/jmp" ] || [ "$SRC/wasi_extra/jmp/jmp.S" -nt "$JMP/jmp" ]; then
    log "building wasi_extra/jmp"
    cp "$SRC/wasi_extra/jmp/jmp.h" "$JMP/"
    ( cd "$SRC/wasi_extra/jmp" &&
      "$CC" --sysroot="$SYSROOT" -O2 --target=$TARGET -c jmp.c -I . -o "$JMP/jmp.o" &&
      "$CC" --sysroot="$SYSROOT" -O2 --target=$TARGET -Wl,--export=wasm_setjmp -c jmp.S -o "$JMP/jmp_wrapper.o" &&
      "$WASI_SDK/bin/wasm-ld" "$JMP/jmp.o" "$JMP/jmp_wrapper.o" --export=wasm_setjmp --export=wasm_longjmp --export=handle_jmp --no-entry -r -o "$JMP/jmp" )
  fi
  JMP_DEP="$JMP/jmp"; EH_CFLAGS=""; EH_LIBS="-Wl,--export-table"  # table export: lets the harness install the dbg/JIT hook trampolines
else
  JMP_DEP=""; EH_CFLAGS="-DNANOBOX_EH -fno-exceptions -mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false"; EH_LIBS="-lsetjmp -Wl,--export-table -Wl,--growable-table"
fi
VFS="$OUT/vfs"; mkdir -p "$VFS"
if [ ! -f "$VFS/vfs.o" ]; then
  log "building wasi_extra/vfs"
  ( cd "$SRC/wasi_extra/vfs" && "$CC" --sysroot="$SYSROOT" -O2 --target=$TARGET -c vfs.c -I . -o "$VFS/vfs.o" )
fi

# --- configure ------------------------------------------------------------------------------------
cd "$SRC"
if [ "$CONFIGURE" = 1 ] || [ ! -f "$SRC/config.h" ]; then
  log "configure ($MODE_TAG, BX_OPT=$BX_OPT)"
  CFLAGS="--sysroot=$SYSROOT --target=$TARGET -D_WASI_EMULATED_SIGNAL -DWASI -D__GNU__ -DNANOBOX_DETERMINISTIC $BX_OPT $EH_CFLAGS -I$JMP/ -I$WIZER_INC/"
  CC="$CC" CXX="$CXX" RANLIB="$WASI_SDK/bin/ranlib" CFLAGS="$CFLAGS" CXXFLAGS="$CFLAGS" LDFLAGS="$EH_LIBS" \
    ./configure --host wasm32-unknown-wasi --enable-x86-64 --with-nogui --enable-usb --enable-usb-ehci \
      --disable-large-ramfile --disable-show-ips --disable-stats --disable-logging \
      --enable-repeat-speedups --enable-fast-function-calls --disable-trace-linking --enable-handlers-chaining --enable-avx \
      "${EXTRA[@]}" > "$OUT/configure.log" 2>&1 || { tail -30 "$OUT/configure.log"; exit 1; }
fi

# --- compile --------------------------------------------------------------------------------------
log "make bochs"
rm -f bochs   # always relink: link flags (EH_LIBS) are not a make dependency
make -j"$(nproc)" bochs EMU_DEPS="$WASI_VFS_LIB $JMP_DEP $VFS/vfs.o -lrt $EH_LIBS" > "$OUT/make.log" 2>&1 || { tail -40 "$OUT/make.log"; exit 1; }
cp bochs "$OUT/bochs.raw.wasm"

# --- post-process ---------------------------------------------------------------------------------
if [ "$LEGACY" = 1 ]; then
  if [ "$BX_ASYNCIFY" = 1 ]; then
    log "wasm-opt --asyncify -O2"
    "$BINARYEN/wasm-opt" "$OUT/bochs.raw.wasm" --asyncify -O2 ${BX_KEEP_NAMES:+-g} -o "$OUT/bochs.opt.wasm" --pass-arg=asyncify-ignore-imports
  else
    cp "$OUT/bochs.raw.wasm" "$OUT/bochs.opt.wasm"
  fi
else
  if [ "$BX_WASM_OPT" = 1 ]; then
    log "wasm-opt -O2 (EH aware)"
    "$BINARYEN/wasm-opt" "$OUT/bochs.raw.wasm" -O2 ${BX_KEEP_NAMES:+-g} --enable-exception-handling --enable-bulk-memory --enable-reference-types \
      --enable-multivalue --enable-sign-ext --enable-nontrapping-float-to-int --enable-mutable-globals --enable-simd \
      -o "$OUT/bochs.opt.wasm"
  else
    cp "$OUT/bochs.raw.wasm" "$OUT/bochs.opt.wasm"
  fi
fi

# --- wizer pre-init + wasi-vfs pack ---------------------------------------------------------------
if [ "$DO_WIZER" = 1 ]; then
  log "wizer (pre-initialising with $PACK)"
  WASMTIME_BACKTRACE_DETAILS=1 "$WIZER" "${WIZER_ARGS[@]}" --mapdir /pack::"$PACK" -o "$OUT/bochs.wizer.wasm" "$OUT/bochs.opt.wasm"
  MINPACK="$OUT/minpack"; rm -rf "$MINPACK"; mkdir -p "$MINPACK"
  cp "$PACK/rootfs.bin" "$PACK/boot.iso" "$MINPACK/"
  log "wasi-vfs pack"
  "$WASI_VFS" pack "$OUT/bochs.wizer.wasm" --mapdir /pack::"$MINPACK" -o "$OUT/out.wasm"
else
  "$WASI_VFS" pack "$OUT/bochs.opt.wasm" --mapdir /pack::"$PACK" -o "$OUT/out.wasm"
fi
ls -la "$OUT/out.wasm"
log "done: $OUT/out.wasm"

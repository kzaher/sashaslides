# Symbolizing guest addresses (`tools/guest-symbolize.mjs`)

The engine's profilers report *guest* addresses: `--pages` gives per-4 KiB-page instruction counts,
`--focus` a per-offset histogram inside one page, `--dbg` a per-trace RIP log. This tool turns those
into function names.

```
node tools/guest-symbolize.mjs --elf <unstripped ELF> (--maps FILE | --base 0xADDR) \
     (--pages F | --pages-diff BEFORE AFTER | --focus F | --rips F) [--top N] [--lines]
```

Worked example (the codex typing profile, see `docs/codex-typing.md`):

```
node tools/guest-symbolize.mjs \
  --elf work/symbols/codex-symbols-x86_64-unknown-linux-musl/codex.debug \
  --maps work/prof/typing/tr7.txt \
  --pages-diff work/prof/typing/pages7.1 work/prof/typing/pages7.2 --top 20
```

## 1. Getting the load base (guest VA → file offset)

The guest binaries are PIE, so the base is per-run. Two ways:

* **`--maps FILE`** — a `/proc/<pid>/maps` capture. `--base = mapping.start − mapping.fileOffset`
  (the tool takes the *executable* mapping and warns if two executable mappings of the same file
  disagree; the writable segment legitimately differs by a page and is ignored).
  Capture it in the **same run** as the profile — the base changes with the process tree:

  ```
  node harness/run.mjs ... \
    --cmd '/bin/sh -c "(sleep 4; echo @@MAPS-BEGIN@@; cat /proc/*/maps 2>/dev/null; echo @@MAPS-END@@) & exec /usr/local/bin/codex"' \
    --expect "…" --transcript tr.txt --pages p.txt
  ```

  `--maps` scans any text for maps-shaped lines, so pointing it at the raw harness transcript works
  even though the TUI's escape sequences are interleaved.
* **`--base 0xADDR`** — when you know it (e.g. from an earlier run with the same `--cmd`; the harness
  host is deterministic, so the same command line reproduces the same base).

## 2. Getting symbols

`readelf -SW <binary>` tells you what you have. Order of preference, and what worked for codex
0.147.0 (`/usr/local/bin/codex`, 258 MB, `.text` 201 MB):

| source | result for codex |
|---|---|
| `.symtab` in the shipped binary | **absent** — fully stripped (`.dynsym` has 1 entry) |
| GNU build-id → debuginfod | **impossible** — the binary carries no `NT_GNU_BUILD_ID` note (`readelf -n` is empty) |
| npm `@openai/codex@…-linux-x64` | not needed (it ships the same stripped binary) |
| **GitHub release asset** `codex-symbols-x86_64-unknown-linux-musl.tar.gz` for tag `rust-v0.147.0` | **this is the one.** 226 MB download → `codex.debug`, 977 MB, full `.symtab` (**321,958 `STT_FUNC`**) + DWARF. It is exactly what `.gnu_debuglink` in the shipped binary names (`codex.debug`, CRC 0x4b02e0c3). |
| `.eh_frame_hdr` of the stripped binary | fallback: **294,541 function boundaries, no names**. Verified to produce byte-identical function starts to `.symtab` on the hot page. |

The tool reads the ELF itself (no binutils needed) and prints which source it used:

```
# symbols .symtab (321958 functions)
# symbols .eh_frame_hdr (294541 function boundaries, NO NAMES — pass an unstripped --elf for names)
```

Version discovery: `grep` the binary for a version string (`0.147.0`) and read `.comment`
(`rustc version 1.95.0`, zig-bootstrap clang → the `x86_64-unknown-linux-musl` build).

## 3. Demangling

`rustfilt` is not installed and `c++filt` mangles Rust's `$…$` escapes, so the tool demangles itself:

* **legacy** `_ZN<len><ident>…E` — length-prefixed components, `$LT$ $GT$ $u20$ $C$ $RF$ $BP$ …`
  escapes, `..` → `::`, the trailing `17h<hash>` component dropped, and the `_` rustc prepends to a
  component that would start with `<` removed. 312 k of codex's symbols are this form.
* **v0** `_R…` — a recursive-descent subset (crate/nested/impl/trait-impl paths, generic argument
  lists, the basic types, references/pointers/slices/tuples); backrefs render as `…`. 3.9 k symbols.
  Anything it cannot parse falls back to the raw symbol rather than guessing.

## 4. Attribution granularity

* `--focus` and `--rips` are **exact** (one address → one function).
* `--pages` / `--pages-diff` are **4 KiB-page granular**: the tool splits a page's count across the
  functions that overlap it in proportion to their bytes. Cross-checked on the hottest page of the
  codex typing profile: the page-split estimate and the exact `--focus` histogram agree that the page
  is dominated by `ratatui_core::buffer::buffer::Buffer::set_style` (exact: 92.7 % of that page).
  When a number matters, re-run with `--focus 0x<page>:FILE`.
* `--lines` calls `addr2line -e <elf> -f -i`. On codex.debug (435 MB of `.debug_info`) a *single*
  batch call takes minutes — treat it as an offline step, not part of the loop.

## 5. Kernel addresses

The nanobox guest kernel (Linux 6.1.0, built by container2wasm's Dockerfile) is **stripped and has
no `CONFIG_KALLSYMS`** — `/proc/kallsyms` does not exist in the guest and `vmlinux` extracted from
`work/pack-out-nb/pack/boot.iso` has no `.symtab`. So there are **no kernel function names**; kernel
attribution is by page (and, with the slide below, by `vmlinux` file offset, which you can then
`objdump -d --start-address=…`).

Recovering the KASLR slide (needed to turn a guest kernel VA into a `vmlinux` offset): the running
kernel is relocated *and* self-patched, so a saved page never matches byte for byte. The tool anchors
on many 16-byte windows and takes the modal offset:

```
# extract vmlinux: find the "HdrS" signature in boot.iso, then zlib-inflate from the following gzip magic
node harness/run.mjs … --save-phys 0xf41d000:kpage.bin      # phys = guest VA − 0xffffffff86000000
node tools/guest-symbolize.mjs --kslide vmlinux --phys-page 0xffffffff9541d000=kpage.bin
#  kpage.bin: 326 anchors agree -> link address 0xffffffff8101d000, guest 0xffffffff9541d000  =>  --kernel-base 0x14400000
```

Two independent pages agree on `0x14400000` for the current `build/eh-nb` snapshot. Pass a real
`--kernel-map` (System.map / kallsyms format) if a kernel with symbols is ever built.

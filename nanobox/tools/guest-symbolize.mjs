#!/usr/bin/env node
// guest-symbolize.mjs — turn nanobox guest addresses into function names.
//
//   node tools/guest-symbolize.mjs --elf codex.debug --maps run-transcript.txt \
//        --pages-diff before.txt after.txt --top 20 [--lines]
//   node tools/guest-symbolize.mjs --elf codex.debug --base 0x7f331402f000 --focus focus.txt
//   node tools/guest-symbolize.mjs --elf codex.debug --maps maps.txt --rips rips.txt
//   node tools/guest-symbolize.mjs --kslide vmlinux --phys-page 0xffffffff9541d000=kpage.bin
//
// Inputs (one profile source is required):
//   --pages FILE          harness `--pages` output: "lpage count ppage flags traces" (cumulative)
//   --pages-diff A B      the delta of two such files — the per-keystroke / per-phase profile
//   --focus FILE          harness `--focus` output: "0xaddr instructions traces" inside one page
//   --rips FILE           any text with hex addresses, one per line, optional leading count
// Address -> (binary, file offset):
//   --maps FILE           a guest /proc/<pid>/maps capture (or any text containing one: the harness
//                         transcript of `cat /proc/*/maps` works). PIE load base = mapping.start - mapping.fileOffset.
//   --base 0xADDR         explicit load base, when the maps of that exact run were not captured
// Symbols:
//   --elf FILE            the ELF to symbolize with. A stripped binary still works via .eh_frame_hdr
//                         (function boundaries, no names); a `.gnu_debuglink` companion (codex.debug)
//                         or any unstripped copy gives real names from .symtab.
//   --lines               also resolve file:line with addr2line (needs DWARF in --elf; slow: one batch call)
//   --kernel-map FILE     System.map / kallsyms style "addr T name" for guest-kernel addresses
// Helper:
//   --kslide ELF --phys-page 0xGUESTVA=FILE   recover a KASLR slide by matching a saved guest page
//                         (harness `--save-phys`) against the ELF; prints the slide to pass as --kernel-base.
//
// Everything about the ELF is read directly (no binutils needed) and Rust symbols are demangled here
// (legacy _ZN…17h<hash>E and v0 _R…), because rustfilt/llvm-cxxfilt are not in this devcontainer.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const KERNEL_SPACE_START = 0xffff800000000000n;

function main() {
  const options = parseArguments({ argv: process.argv.slice(2) });
  if (options.kslide) { reportKernelSlide({ elfPath: options.kslide, physPages: options.physPages }); return; }
  if (!options.elf) fail("--elf FILE is required (the binary to symbolize; codex.debug for names)");

  const samples = loadProfile({ options });
  if (samples.length === 0) fail("no samples: pass --pages / --pages-diff / --focus / --rips");

  const image = loadImage({ elfPath: options.elf });
  const loadBase = resolveLoadBase({ options, image });
  const kernelSymbols = options.kernelMap ? loadSystemMap({ path: options.kernelMap }) : null;

  const attributed = attribute({ samples, image, loadBase, kernelSymbols, kernelBase: options.kernelBase });
  const lines = options.lines ? resolveSourceLines({ elfPath: options.elf, rows: attributed, top: options.top }) : null;
  report({ rows: attributed, top: options.top, image, loadBase, options, lines });
}

// ---- command line ------------------------------------------------------------------------------

function parseArguments({ argv }) {
  const options = { elf: null, maps: null, base: null, pages: null, pagesDiff: null, focus: null, rips: null,
    top: 20, lines: false, kernelMap: null, kernelBase: 0n, kslide: null, physPages: [], by: "function" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = () => argv[++i];
    if (flag === "--elf") options.elf = value();
    else if (flag === "--maps") options.maps = value();
    else if (flag === "--base") options.base = BigInt(value());
    else if (flag === "--pages") options.pages = value();
    else if (flag === "--pages-diff") { options.pagesDiff = [argv[++i], argv[++i]]; }
    else if (flag === "--focus") options.focus = value();
    else if (flag === "--focus-diff") { options.focusDiff = [argv[++i], argv[++i]]; }
    else if (flag === "--rips") options.rips = value();
    else if (flag === "--top") options.top = Number(value());
    else if (flag === "--lines") options.lines = true;
    else if (flag === "--kernel-map") options.kernelMap = value();
    else if (flag === "--kernel-base") options.kernelBase = BigInt(value());
    else if (flag === "--kslide") options.kslide = value();
    else if (flag === "--phys-page") { const raw = value(); const eq = raw.indexOf("="); options.physPages.push({ addr: BigInt(raw.slice(0, eq)), file: raw.slice(eq + 1) }); }
    else if (flag === "--by") options.by = value();
    else fail("unknown option " + flag);
  }
  return options;
}

function fail(message) { console.error("guest-symbolize: " + message); process.exit(2); }

// ---- profile inputs ----------------------------------------------------------------------------
// Every source is normalised to {addr, count, traces, span} where span is the number of bytes the
// count covers (4096 for a page profile, 1 for an exact RIP) — attribution needs it to decide
// whether a page belongs to one function or has to be split.

function loadProfile({ options }) {
  if (options.pagesDiff) return diffPageProfiles({ before: readPageProfile(options.pagesDiff[0]), after: readPageProfile(options.pagesDiff[1]) });
  if (options.pages) return [...readPageProfile(options.pages).values()].map((row) => ({ addr: row.addr, count: row.count, traces: row.traces, span: 4096 }));
  if (options.focusDiff) return diffFocusProfiles({ before: readFocusProfile(options.focusDiff[0]), after: readFocusProfile(options.focusDiff[1]) });
  if (options.focus) return readFocusProfile(options.focus);
  if (options.rips) return readRipList(options.rips);
  return [];
}

function readPageProfile(path) {
  const rows = new Map();
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    if (!line || line[0] === "#") continue;
    const [page, count, , , traces] = line.split(" ");
    if (page === undefined) continue;
    const addr = BigInt(page) * 4096n;
    rows.set(addr, { addr, count: Number(count), traces: Number(traces) });
  }
  return rows;
}

function diffPageProfiles({ before, after }) {
  const samples = [];
  for (const [addr, row] of after) {
    const earlier = before.get(addr);
    const count = row.count - (earlier ? earlier.count : 0);
    if (count <= 0) continue;
    samples.push({ addr, count, traces: row.traces - (earlier ? earlier.traces : 0), span: 4096 });
  }
  return samples;
}

function readFocusProfile(path) {
  const samples = [];
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    if (!line || line[0] === "#") continue;
    const [addr, count, traces] = line.split(" ");
    samples.push({ addr: BigInt(addr), count: Number(count), traces: Number(traces), span: 1 });
  }
  return samples;
}

// Two cumulative --focus histograms of the same page: the delta is what one keystroke (or phase) did.
function diffFocusProfiles({ before, after }) {
  const earlier = new Map(before.map((sample) => [sample.addr, sample]));
  const samples = [];
  for (const sample of after) {
    const previous = earlier.get(sample.addr);
    const count = sample.count - (previous ? previous.count : 0);
    if (count <= 0) continue;
    samples.push({ addr: sample.addr, count, traces: sample.traces - (previous ? previous.traces : 0), span: 1 });
  }
  return samples;
}

function readRipList(path) {
  const counted = new Map();
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*(?:(\d+)\s+)?(0x[0-9a-fA-F]+|[0-9a-fA-F]{8,16})\s*$/.exec(line);
    if (!match) continue;
    const addr = BigInt(match[2].startsWith("0x") ? match[2] : "0x" + match[2]);
    counted.set(addr, (counted.get(addr) || 0) + Number(match[1] || 1));
  }
  return [...counted].map(([addr, count]) => ({ addr, count, traces: count, span: 1 }));
}

// ---- the ELF -----------------------------------------------------------------------------------

// Reads only the section header table and the sections we need, so a 1 GB debug file costs ~55 MB.
function loadImage({ elfPath }) {
  const handle = fs.openSync(elfPath, "r");
  try {
    const header = readAt({ handle, offset: 0, length: 64 });
    if (header.toString("latin1", 0, 4) !== "\x7fELF") fail(elfPath + ": not an ELF file");
    if (header[4] !== 2) fail(elfPath + ": only ELF64 is supported");
    const sectionOffset = Number(header.readBigUInt64LE(0x28));
    const sectionSize = header.readUInt16LE(0x3a), sectionCount = header.readUInt16LE(0x3c), nameIndex = header.readUInt16LE(0x3e);
    const table = readAt({ handle, offset: sectionOffset, length: sectionSize * sectionCount });
    const raw = [];
    for (let i = 0; i < sectionCount; i++) {
      const at = i * sectionSize;
      raw.push({ nameOff: table.readUInt32LE(at), type: table.readUInt32LE(at + 4), addr: table.readBigUInt64LE(at + 16),
        offset: Number(table.readBigUInt64LE(at + 24)), size: Number(table.readBigUInt64LE(at + 32)), link: table.readUInt32LE(at + 40) });
    }
    const names = readAt({ handle, offset: raw[nameIndex].offset, length: raw[nameIndex].size });
    const sections = raw.map((section) => Object.assign({}, section, { name: cstring(names, section.nameOff) }));
    const functions = readFunctionSymbols({ handle, sections }) || readEhFrameStarts({ handle, sections });
    const debugLink = sections.find((section) => section.name === ".gnu_debuglink");
    return { path: elfPath, sections, functions: functions.list, source: functions.source,
      debugLink: debugLink ? cstring(readAt({ handle, offset: debugLink.offset, length: debugLink.size }), 0) : null };
  } finally { fs.closeSync(handle); }
}

// .symtab (or .dynsym) STT_FUNC entries: the only source that carries names.
function readFunctionSymbols({ handle, sections }) {
  const symtab = sections.find((section) => section.name === ".symtab" && section.size > 0)
             || sections.find((section) => section.name === ".dynsym" && section.size > 24);
  if (!symtab) return null;
  const strtab = sections[symtab.link];
  const symbols = readAt({ handle, offset: symtab.offset, length: symtab.size });
  const strings = readAt({ handle, offset: strtab.offset, length: strtab.size });
  const list = [];
  for (let at = 0; at + 24 <= symbols.length; at += 24) {
    const type = symbols[at + 4] & 0xf;
    if (type !== 2) continue; // STT_FUNC
    const addr = symbols.readBigUInt64LE(at + 8);
    if (addr === 0n) continue;
    list.push({ addr, size: Number(symbols.readBigUInt64LE(at + 16)), name: cstring(strings, symbols.readUInt32LE(at)) });
  }
  if (list.length === 0) return null;
  list.sort((left, right) => (left.addr < right.addr ? -1 : left.addr > right.addr ? 1 : 0));
  return { list, source: `${symtab.name} (${list.length} functions)` };
}

// Stripped binary: .eh_frame_hdr's binary-search table is a sorted (function start, FDE) array, so it
// yields exact function boundaries — without names. Better than nothing: the profile at least splits
// into distinct functions instead of 4 KiB pages.
function readEhFrameStarts({ handle, sections }) {
  const header = sections.find((section) => section.name === ".eh_frame_hdr");
  if (!header) return { list: [], source: "none (stripped, no .eh_frame_hdr)" };
  const data = readAt({ handle, offset: header.offset, length: header.size });
  if (data[0] !== 1) return { list: [], source: "none (unsupported .eh_frame_hdr version)" };
  const tableEncoding = data[3];
  if (tableEncoding !== 0x3b) return { list: [], source: `none (.eh_frame_hdr table encoding 0x${tableEncoding.toString(16)} unsupported)` };
  let at = 4;
  at += encodedSize(data[1]);                                     // eh_frame_ptr
  const count = readEncoded({ data, at, encoding: data[2], sectionAddr: header.addr });
  at += encodedSize(data[2]);
  const list = [];
  for (let i = 0; i < count && at + 8 <= data.length; i++, at += 8) {
    const start = BigInt(header.addr) + BigInt(data.readInt32LE(at));
    list.push({ addr: start, size: 0, name: null });
  }
  list.sort((left, right) => (left.addr < right.addr ? -1 : left.addr > right.addr ? 1 : 0));
  for (let i = 0; i < list.length; i++) list[i].size = i + 1 < list.length ? Number(list[i + 1].addr - list[i].addr) : 0;
  return { list, source: `.eh_frame_hdr (${list.length} function boundaries, NO NAMES — pass an unstripped --elf for names)` };
}

function encodedSize(encoding) { const format = encoding & 0x0f; return format === 0x03 || format === 0x0b ? 4 : format === 0x04 || format === 0x0c ? 8 : format === 0x02 || format === 0x0a ? 2 : 4; }
function readEncoded({ data, at, encoding, sectionAddr }) {
  const format = encoding & 0x0f;
  if (format === 0x03 || format === 0x0b) return data.readUInt32LE(at);
  if (format === 0x04 || format === 0x0c) return Number(data.readBigUInt64LE(at));
  if (format === 0x02 || format === 0x0a) return data.readUInt16LE(at);
  return data.readUInt32LE(at);
}

function readAt({ handle, offset, length }) {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(handle, buffer, read, length - read, offset + read);
    if (n <= 0) break;
    read += n;
  }
  return buffer;
}

function cstring(buffer, at) { let end = at; while (end < buffer.length && buffer[end]) end++; return buffer.toString("utf8", at, end); }

// ---- load base ---------------------------------------------------------------------------------

function resolveLoadBase({ options, image }) {
  if (options.base != null) return { base: options.base, source: "--base" };
  if (!options.maps) fail("need --maps FILE (a guest /proc/<pid>/maps) or --base 0xADDR: a PIE's load base is per-run");
  const mappings = parseMaps({ text: fs.readFileSync(options.maps, "utf8") });
  if (mappings.length === 0) fail(options.maps + ": no file-backed mappings found");
  const executable = mappings.filter((mapping) => mapping.executable);
  const chosen = executable[0] || mappings[0];
  const base = chosen.start - BigInt(chosen.fileOffset);
  const disagreeing = mappings.filter((mapping) => mapping.path === chosen.path && mapping.executable && mapping.start - BigInt(mapping.fileOffset) !== base);
  if (disagreeing.length) console.error(`[warn] mappings of ${chosen.path} disagree on the load base; using ${hex(base)}`);
  return { base, source: `${options.maps}: ${chosen.path} ${hex(chosen.start)} @ file+0x${chosen.fileOffset.toString(16)}` };
}

// Tolerant on purpose: the maps usually arrive inside a harness transcript, mixed with TUI escapes.
function parseMaps({ text }) {
  const mappings = [];
  const pattern = /([0-9a-f]{6,16})-([0-9a-f]{6,16})\s+([rwxps-]{4})\s+([0-9a-f]{8,16})\s+\S+\s+\d+\s+(\/\S+)/g;
  let match;
  while ((match = pattern.exec(text))) {
    mappings.push({ start: BigInt("0x" + match[1]), end: BigInt("0x" + match[2]), executable: match[3][2] === "x",
      fileOffset: parseInt(match[4], 16), path: match[5] });
  }
  return mappings;
}

function loadSystemMap({ path }) {
  const list = [];
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    const match = /^([0-9a-fA-F]{8,16})\s+([tTwW])\s+(\S+)/.exec(line);
    if (!match) continue;
    list.push({ addr: BigInt("0x" + match[1]), size: 0, name: match[3] });
  }
  list.sort((left, right) => (left.addr < right.addr ? -1 : left.addr > right.addr ? 1 : 0));
  for (let i = 0; i < list.length; i++) list[i].size = i + 1 < list.length ? Number(list[i + 1].addr - list[i].addr) : 0;
  return list;
}

// ---- attribution -------------------------------------------------------------------------------

function attribute({ samples, image, loadBase, kernelSymbols, kernelBase }) {
  const perFunction = new Map();
  for (const sample of samples) {
    const kernel = sample.addr >= KERNEL_SPACE_START;
    const table = kernel ? kernelSymbols : image.functions;
    const linkAddr = kernel ? sample.addr - kernelBase : sample.addr - loadBase.base;
    const key = kernel ? "K" + hex(sample.addr & ~0xfffn) : null;
    const hits = table && table.length ? functionsOverlapping({ table, start: linkAddr, span: sample.span }) : [];
    if (hits.length === 0) {
      const label = kernel ? `[kernel page ${hex(sample.addr & ~0xfffn)}]` : `[${image.path.split("/").pop()}+${hex(linkAddr)} — no symbol]`;
      addTo({ perFunction, key: key || label, label, sample, linkAddr, kernel });
      continue;
    }
    // A page can straddle several functions; split the count by how much of the page each covers.
    const covered = hits.reduce((sum, hit) => sum + hit.bytes, 0) || 1;
    for (const hit of hits) {
      const share = hits.length === 1 ? sample.count : Math.round(sample.count * hit.bytes / covered);
      addTo({ perFunction, key: hit.symbol.name || hex(hit.symbol.addr), label: prettyName(hit.symbol),
        sample: { count: share, traces: Math.round(sample.traces * hit.bytes / covered) }, linkAddr: hit.symbol.addr, kernel, split: hits.length > 1,
        // a trace that STARTS at the entry address is one call of the function (a CALL always begins a trace there)
        calls: sample.span === 1 && linkAddr === hit.symbol.addr ? sample.traces : 0 });
    }
  }
  const rows = [...perFunction.values()].sort((left, right) => right.count - left.count);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return rows.map((row) => Object.assign({}, row, { share: total ? row.count / total : 0, total }));
}

function addTo({ perFunction, key, label, sample, linkAddr, kernel, split, calls }) {
  const existing = perFunction.get(key);
  if (!existing) { perFunction.set(key, { key, label, count: sample.count, traces: sample.traces || 0, calls: calls || 0, linkAddr, kernel, split: !!split }); return; }
  existing.count += sample.count;
  existing.traces += sample.traces || 0;
  existing.calls += calls || 0;
  if (linkAddr < existing.linkAddr) existing.linkAddr = linkAddr;
}

function functionsOverlapping({ table, start, span }) {
  const end = start + BigInt(span);
  let low = 0, high = table.length - 1, index = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (table[middle].addr <= start) { index = middle; low = middle + 1; } else high = middle - 1;
  }
  const hits = [];
  for (let i = Math.max(0, index); i < table.length; i++) {
    const symbol = table[i];
    if (symbol.addr >= end) break;
    const symbolEnd = symbol.size > 0 ? symbol.addr + BigInt(symbol.size) : (i + 1 < table.length ? table[i + 1].addr : symbol.addr + 1n);
    if (symbolEnd <= start) continue;
    const bytes = Number((symbolEnd < end ? symbolEnd : end) - (symbol.addr > start ? symbol.addr : start));
    if (bytes > 0) hits.push({ symbol, bytes });
  }
  return hits;
}

// ---- output ------------------------------------------------------------------------------------

function report({ rows, top, image, loadBase, options, lines }) {
  const total = rows.length ? rows[0].total : 0;
  console.log(`# guest-symbolize: ${rows.length} functions, ${total.toLocaleString()} instructions attributed`);
  console.log(`# elf     ${image.path}`);
  console.log(`# symbols ${image.source}${image.debugLink ? `; .gnu_debuglink -> ${image.debugLink}` : ""}`);
  console.log(`# base    ${hex(loadBase.base)}  (${loadBase.source})`);
  if (options.kernelMap) console.log(`# kernel  ${options.kernelMap} at slide ${hex(options.kernelBase)}`);
  else console.log("# kernel  no --kernel-map: kernel addresses are reported by page only");
  if (options.pages || options.pagesDiff) console.log("# NOTE  a --pages profile counts per 4 KiB page; a page's count is split across the functions it\n#       covers in proportion to their bytes. Use --focus on a hot page for exact per-offset counts.");
  console.log(rows.some((row) => row.calls > 0) ? "#    count    share      calls  instr/call  link addr        symbol"
                                                 : "#    count    share  link addr        symbol");
  let cumulative = 0;
  for (const [index, row] of rows.slice(0, top).entries()) {
    cumulative += row.share;
    const where = lines && lines[index] ? `  (${lines[index]})` : "";
    const callColumns = rows.some((other) => other.calls > 0)
      ? `  ${String(row.calls || "-").padStart(9)}  ${(row.calls ? (row.count / row.calls).toFixed(1) : "-").padStart(10)}` : "";
    console.log(`${String(row.count).padStart(12)}  ${(100 * row.share).toFixed(2).padStart(6)}%${callColumns}  ${hex(row.linkAddr).padEnd(14)}  ${row.label}${where}`);
  }
  const kernelShare = rows.filter((row) => row.kernel).reduce((sum, row) => sum + row.share, 0);
  console.log(`# kernel ${(100 * kernelShare).toFixed(1)}% / user ${(100 * (1 - kernelShare)).toFixed(1)}%; top ${Math.min(top, rows.length)} = ${(100 * cumulative).toFixed(1)}%`);
}

function resolveSourceLines({ elfPath, rows, top }) {
  const wanted = rows.slice(0, top).filter((row) => !row.kernel);
  if (wanted.length === 0) return null;
  try {
    const output = execFileSync("addr2line", ["-e", elfPath, "-f", "-i", ...wanted.map((row) => hex(row.linkAddr))], { encoding: "utf8", maxBuffer: 1 << 24 });
    const blocks = output.trim().split("\n");
    const perRow = new Map();
    for (let i = 0, at = 0; i < wanted.length && at + 1 < blocks.length; i++, at += 2) perRow.set(rows.indexOf(wanted[i]), blocks[at + 1]);
    return Object.fromEntries(perRow);
  } catch (error) { console.error("[warn] addr2line failed: " + error.message.split("\n")[0]); return null; }
}

function hex(value) { return "0x" + (value < 0n ? 0n : value).toString(16); }

// ---- KASLR slide helper ------------------------------------------------------------------------
// The guest kernel is relocated (and self-patched) at boot, so a saved guest page never matches the
// vmlinux byte for byte; anchoring on many short windows and taking the modal offset does.
function reportKernelSlide({ elfPath, physPages }) {
  if (physPages.length === 0) fail("--kslide needs --phys-page 0xGUESTVA=FILE (a harness --save-phys dump)");
  const image = loadImage({ elfPath });
  const text = image.sections.find((section) => section.name === ".text");
  if (!text) fail(elfPath + ": no .text");
  const handle = fs.openSync(elfPath, "r");
  const body = readAt({ handle, offset: text.offset, length: text.size });
  fs.closeSync(handle);
  for (const page of physPages) {
    const guest = fs.readFileSync(page.file);
    const votes = new Map();
    for (let at = 0; at + 16 <= guest.length; at += 8) {
      const anchor = guest.subarray(at, at + 16);
      if (anchor.every((byte) => byte === anchor[0])) continue;
      let found = body.indexOf(anchor);
      while (found >= 0) { const offset = found - at; votes.set(offset, (votes.get(offset) || 0) + 1); found = body.indexOf(anchor, found + 1); }
    }
    const best = [...votes].sort((left, right) => right[1] - left[1])[0];
    if (!best || best[1] < 8) { console.log(`${page.file}: no confident match in .text (best ${best ? best[1] : 0} anchors)`); continue; }
    const linkAddr = text.addr + BigInt(best[0]);
    console.log(`${page.file}: ${best[1]} anchors agree -> link address ${hex(linkAddr)}, guest ${hex(page.addr)}  =>  --kernel-base ${hex(page.addr - linkAddr)}`);
  }
}

// ---- Rust symbol demangling --------------------------------------------------------------------

function prettyName(symbol) {
  if (!symbol.name) return `[fn ${hex(symbol.addr)} — .eh_frame boundary, no name]`;
  return demangle(symbol.name);
}

function demangle(name) {
  if (name.startsWith("_RN") || name.startsWith("_R")) { const decoded = demangleV0(name); if (decoded) return decoded; }
  if (name.startsWith("_ZN")) { const decoded = demangleLegacy(name); if (decoded) return decoded; }
  return name;
}

// Rust legacy: _ZN <len><ident> … E, idents carrying $XX$ escapes, last component "17h<16 hex>".
function demangleLegacy(name) {
  let at = 3;
  const parts = [];
  while (at < name.length && name[at] !== "E") {
    let digits = 0;
    while (at + digits < name.length && name[at + digits] >= "0" && name[at + digits] <= "9") digits++;
    if (digits === 0) return null;
    const length = Number(name.slice(at, at + digits));
    at += digits;
    parts.push(name.slice(at, at + length));
    at += length;
  }
  if (parts.length === 0) return null;
  if (/^h[0-9a-f]{8,32}$/.test(parts[parts.length - 1])) parts.pop();
  // rustc prefixes a component that cannot start with an identifier character ("<X as Y>") with "_"
  return parts.map((part) => unescapeLegacy(part.startsWith("_$") ? part.slice(1) : part)).join("::");
}

const LEGACY_ESCAPES = { $SP$: "@", $BP$: "*", $RF$: "&", $LT$: "<", $GT$: ">", $LP$: "(", $RP$: ")", $C$: ",", $u20$: " ", $u22$: '"', $u27$: "'", $u2b$: "+", $u3b$: ";", $u5b$: "[", $u5d$: "]", $u7b$: "{", $u7d$: "}", $u7e$: "~" };
function unescapeLegacy(part) {
  return part.replace(/\$[A-Za-z0-9_]{1,4}\$/g, (escape) => LEGACY_ESCAPES[escape] !== undefined ? LEGACY_ESCAPES[escape] : escape)
             .replace(/\.\./g, "::").replace(/(^|[^:])\.([^.]|$)/g, "$1-$2");
}

// Rust v0 (RFC 2603), the subset that appears in a profile: paths with nested/impl/generic segments.
// Anything unusual (const generics, exotic backrefs) makes it bail out to the raw symbol.
function demangleV0(mangled) {
  const state = { text: mangled, at: mangled.startsWith("_R") ? 2 : 1, depth: 0 };
  try {
    const path = parseV0Path(state);
    return path || null;
  } catch (error) { return null; }
}

function parseV0Path(state) {
  if (state.depth++ > 24) throw new Error("too deep");
  const tag = state.text[state.at++];
  if (tag === "C") { readV0Disambiguator(state); return readV0Ident(state); }                      // crate root
  if (tag === "M") { readV0Disambiguator(state); const type = parseV0Type(state); return `<${type}>`; }     // inherent impl
  if (tag === "X") { readV0Disambiguator(state); const type = parseV0Type(state); const trait = parseV0Path(state); return `<${type} as ${trait}>`; }
  if (tag === "Y") { const type = parseV0Type(state); const trait = parseV0Path(state); return `<${type} as ${trait}>`; }
  if (tag === "N") { const namespace = state.text[state.at++]; const parent = parseV0Path(state); readV0Disambiguator(state); const name = readV0Ident(state);
    return namespace >= "A" && namespace <= "Z" ? `${parent}::{${namespace.toLowerCase()}#${name || "?"}}` : `${parent}::${name}`; }
  if (tag === "I") { const parent = parseV0Path(state); const args = []; while (state.text[state.at] !== "E") args.push(parseV0Generic(state)); state.at++; return `${parent}::<${args.join(", ")}>`; }
  if (tag === "B") { readV0Base62(state); return "…"; }                                            // backref: not resolved, shown as an ellipsis
  throw new Error("unknown path tag " + tag);
}

function parseV0Generic(state) {
  const tag = state.text[state.at];
  if (tag === "L") { state.at++; readV0Base62(state); return "'_"; }
  if (tag === "K") { state.at++; return parseV0Type(state); }
  return parseV0Type(state);
}

const V0_BASIC = { a: "i8", b: "bool", c: "char", d: "f64", e: "str", f: "f32", h: "u8", i: "isize", j: "usize", l: "i32", m: "u32", n: "i128", o: "u128", s: "i16", t: "u16", u: "()", v: "...", x: "i64", y: "u64", z: "!", p: "_" };
function parseV0Type(state) {
  if (state.depth++ > 24) throw new Error("too deep");
  const tag = state.text[state.at];
  if (V0_BASIC[tag] && tag === tag.toLowerCase() && !"befjlnp".includes("")) { state.at++; return V0_BASIC[tag]; }
  if (tag === "R") { state.at++; if (state.text[state.at] === "L") { state.at++; readV0Base62(state); } return "&" + parseV0Type(state); }
  if (tag === "Q") { state.at++; if (state.text[state.at] === "L") { state.at++; readV0Base62(state); } return "&mut " + parseV0Type(state); }
  if (tag === "P") { state.at++; return "*const " + parseV0Type(state); }
  if (tag === "O") { state.at++; return "*mut " + parseV0Type(state); }
  if (tag === "S") { state.at++; return "[" + parseV0Type(state) + "]"; }
  if (tag === "A") { state.at++; const element = parseV0Type(state); parseV0Generic(state); return `[${element}; _]`; }
  if (tag === "T") { state.at++; const parts = []; while (state.text[state.at] !== "E") parts.push(parseV0Type(state)); state.at++; return `(${parts.join(", ")})`; }
  if (tag === "B") { state.at++; readV0Base62(state); return "…"; }
  if (tag === "F" || tag === "D") { state.at++; return "fn(…)"; }
  return parseV0Path(state);
}

function readV0Disambiguator(state) { if (state.text[state.at] === "s") { state.at++; readV0Base62(state); } }
function readV0Base62(state) { while (state.at < state.text.length && state.text[state.at] !== "_") state.at++; state.at++; }
function readV0Ident(state) {
  let punycode = false;
  if (state.text[state.at] === "u") { punycode = true; state.at++; }
  let digits = 0;
  while (state.at + digits < state.text.length && state.text[state.at + digits] >= "0" && state.text[state.at + digits] <= "9") digits++;
  if (digits === 0) throw new Error("identifier without a length");
  const length = Number(state.text.slice(state.at, state.at + digits));
  state.at += digits;
  if (state.text[state.at] === "_") state.at++;   // separator when the identifier starts with a digit
  const text = state.text.slice(state.at, state.at + length);
  state.at += length;
  return punycode ? text.replace(/_/g, "-") : text;
}

// The module-level tables above are load-time values, so the entry point runs once the file is read.
main();

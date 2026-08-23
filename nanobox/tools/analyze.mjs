#!/usr/bin/env node
// npm run analyze — one codex boot, every per-instruction statistic the engine can report.
//
// Prints, for the guest's own workload:
//   1. totals: compiled bytes, executed instructions, executed template bytes
//   2. cost ranking: bytes/site x executions, i.e. where the emitted code actually runs
//   3. per-opcode bytes split by PHASE of a site (address resolution, fault arm, access, exit, ...)
//   4. per-opcode fast/slow counts (DTLB hits, slow arm, exits)
//   5. per-opcode SLOW-ARM REASONS (what the DTLB entry held instead)
//   6. distance from what an ideal x86-64 -> wasm compiler would emit
//
// The census exists only at --jit level 3, which costs ~9 % on the boot; level 2 emission is
// unchanged, so the byte columns describe the shipping engine.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "work/prof/analyze");
const argv = process.argv.slice(2);
const option = (name, fallback) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : fallback; };
const engine = option("--engine", join(ROOT, "build/eh-nb/out.wasm"));
const image = option("--image", "codex");
const command = option("--cmd", image === "codex" ? "/usr/local/bin/codex" : "/bin/true");
const expect = option("--expect", image === "codex" ? "Press enter to continue" : null);

// An ideal compiler's sequence for the same guest semantics, assembled and counted in
// work/fib/wb-ideal.mjs (TASKS.md V.10): registers in wasm globals, guest linear address = wasm
// offset, flags only where a consumer exists, return address on wasm's own call stack.
const IDEAL_BYTES = { MOV_GqEq: 8, MOV_EqGq: 8, PUSH_Eq: 13, POP_Eq: 13, CALL_Jq: 22, RET_Op64: 26 };

// Where an instruction's bytes go once you ask "could outlining have removed this?".
//   fast      — runs on the hot path, so it stays inline by definition
//   call site — the argument setup, the call, and the reloads for an arm whose BODY is already
//               outlined into one shared copy. A wasm callee cannot write its caller's locals and
//               the C++ helpers cannot return multiple values, so this is an ABI floor, not
//               un-outlined code (see work/fib/cm0-t000002.wat, the three reloads after `call 1`).
//   boundary  — inline, but only executes when control leaves the translation.
const BUCKETS = {
  fast: ["addr-resolve", "access", "eff-addr", "reg-load", "other", "lazy-flags", "conform", "tpl-wrapper"],
  callSite: ["stack-refill", "slow-arm", "spill-fault", "handler-step", "spill"],
  boundary: ["exit", "async-check", "transition"],
};

await main();

async function main() {
  await ensureImageServer();
  const { matrix, census, reasons } = await measure();
  printTotals(matrix, census);
  printCostRanking(matrix, census);
  printPhaseTable(matrix);
  printInlineSplit(matrix);
  printSlowPath(census);
  printSlowReasons(reasons);
  printIdealGap(matrix);
}

// The harness fetches the guest image over HTTP; serve.mjs owns that port.
async function ensureImageServer() {
  if (await serverAnswers()) return;
  console.error("analyze: starting serve.mjs on :8093");
  spawn("node", [join(ROOT, "serve.mjs")], { cwd: ROOT, detached: true, stdio: "ignore" }).unref();
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await serverAnswers()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));   // retry window: the server binds in well under 10 s
  }
  throw new Error("analyze: serve.mjs did not answer on :8093 within 10 s");
}

async function serverAnswers() {
  try { await fetch("http://localhost:8093/", { signal: AbortSignal.timeout(500) }); return true; } catch { return false; }
}

// Two runs, because the census and the byte counts cannot come from the same one: the census exists
// only at --jit level 3, and level 3 emits its own counters, which roughly doubles bytes per site
// (227.3 against the shipping 112.9). Level 2 therefore supplies every byte column and level 3 every
// execution column.
function measure() {
  const started = Date.now();
  const matrix = readMatrix(harness(["--jit", "2:2000", "--tpl-bytes", `${OUT}-tpl.txt`], `${OUT}-tpl.txt`));
  const censusPath = harness(["--jit", "3:2000", "--op-census", `${OUT}-census.csv`], `${OUT}-census.csv`);
  console.log(`# nanobox analyze — ${image}, ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log(`# bytes from level 2 (shipping emission), executions from level 3 (census build)\n`);
  return { matrix, census: readCsv(censusPath), reasons: readCsv(`${OUT}-census-reasons.csv`) };
}

function harness(extra, produces) {
  const args = [
    "run.mjs", engine,
    "--oci", `http://localhost:8093/c2w/images/${image}/`,
    "--spec", join(ROOT, `web/images/${image}/config.json`),
    "--oci-cache", join(ROOT, "work/oci-cache"),
    "--quiet", "--no-hash", "--cmd", command, "--timeout", "25", ...extra,
  ];
  if (expect) args.push("--expect", expect);
  const run = spawnSync("node", args, { cwd: join(ROOT, "harness"), encoding: "utf8", maxBuffer: 1 << 28 });
  if (run.status !== 0) throw new Error(`analyze: the harness exited ${run.status}\n${(run.stderr || "").slice(-800)}`);
  return produces;
}

// the per-opcode x phase table --tpl-bytes writes: a header naming the phases, then one row per opcode
function readMatrix(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  const headerAt = lines.findIndex((line) => line.startsWith("opcode "));
  const phases = lines[headerAt].trim().split(/\s+/).slice(3);
  const rows = new Map();
  for (const line of lines.slice(headerAt + 1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < phases.length + 3 || !/^[A-Z]/.test(fields[0])) continue;
    rows.set(fields[0], { sites: Number(fields[1]), bytesPerSite: Number(fields[2]),
                          phase: Object.fromEntries(phases.map((name, i) => [name, Number(fields[i + 3])])) });
  }
  const totalLine = lines.find((line) => line.includes("all opcodes:")) || "";
  const total = /([\d.]+) B each/.exec(totalLine);
  return { rows, phases, bytesPerInstruction: total ? Number(total[1]) : NaN,
           instructions: Number((/(\d+) compiled guest instructions/.exec(totalLine) || [])[1] || 0) };
}

function readCsv(path) {
  if (!existsSync(path)) return new Map();
  const [header, ...body] = readFileSync(path, "utf8").trim().split("\n");
  const names = header.split(",");
  const rows = new Map();
  for (const line of body) {
    const fields = line.split(",");
    rows.set(fields[0], Object.fromEntries(names.slice(1).map((name, i) => [name, Number(fields[i + 1])])));
  }
  return rows;
}

function printTotals(matrix, census) {
  const executed = [...census.values()].reduce((sum, row) => sum + row.executed, 0);
  const executedBytes = [...census.entries()].reduce((sum, [opcode, row]) =>
    sum + row.executed * (matrix.rows.get(opcode)?.bytesPerSite || 0), 0);
  table("Totals", ["metric", "value"], [
    ["compiled guest instructions", fmt(matrix.instructions)],
    ["emitted bytes per instruction", matrix.bytesPerInstruction.toFixed(1)],
    ["executed guest instructions", fmt(executed)],
    ["executed template bytes", `${(executedBytes / 1e9).toFixed(2)} G`],
  ]);
}

function printCostRanking(matrix, census) {
  const total = [...census.entries()].reduce((sum, [opcode, row]) =>
    sum + row.executed * (matrix.rows.get(opcode)?.bytesPerSite || 0), 0);
  const rows = [...census.entries()]
    .map(([opcode, row]) => ({ opcode, executed: row.executed, bytes: matrix.rows.get(opcode)?.bytesPerSite || 0 }))
    .map((row) => ({ ...row, cost: row.executed * row.bytes }))
    .sort((a, b) => b.cost - a.cost).slice(0, 12);
  table("Cost: bytes per site x executions", ["opcode", "B/site", "executed", "share"],
    rows.map((row) => [row.opcode, row.bytes.toFixed(1), fmt(row.executed), `${(100 * row.cost / total).toFixed(1)} %`]));
}

function printPhaseTable(matrix) {
  const show = ["other", "addr-resolve", "stack-refill", "spill-fault", "slow-arm", "exit", "async-check", "access"];
  const rows = [...matrix.rows.entries()].sort((a, b) => b[1].bytesPerSite - a[1].bytesPerSite).slice(0, 10);
  table("Bytes per site, by phase", ["opcode", "B/site", ...show],
    rows.map(([opcode, row]) => [opcode, row.bytesPerSite.toFixed(1), ...show.map((p) => (row.phase[p] ?? 0).toFixed(1))]));
}

function printInlineSplit(matrix) {
  const rows = [...matrix.rows.entries()].sort((a, b) => b[1].bytesPerSite - a[1].bytesPerSite).slice(0, 12);
  const sum = (row, names) => names.reduce((total, name) => total + (row.phase[name] ?? 0), 0);
  const body = rows.map(([opcode, row]) => {
    const fast = sum(row, BUCKETS.fast), call = sum(row, BUCKETS.callSite), boundary = sum(row, BUCKETS.boundary);
    const total = fast + call + boundary || 1;
    const cell = (bytes) => `${bytes.toFixed(1)} (${(100 * bytes / total).toFixed(0)}%)`;
    return [opcode, row.bytesPerSite.toFixed(1), cell(fast), cell(call), cell(boundary)];
  });
  table("Inlined vs call-site-to-outlined-body", ["opcode", "B/site", "fast path", "call site", "boundary"], body);
  const totals = [...matrix.rows.values()].reduce((acc, row) => {
    for (const [name, phases] of Object.entries(BUCKETS)) acc[name] += sum(row, phases) * row.sites;
    acc.sites += row.sites; return acc;
  }, { fast: 0, callSite: 0, boundary: 0, sites: 0 });
  const grand = totals.fast + totals.callSite + totals.boundary || 1;
  table("Same split, weighted by compiled sites", ["bucket", "B/site", "share"], [
    ["fast path (cannot be outlined)", (totals.fast / totals.sites).toFixed(1), `${(100 * totals.fast / grand).toFixed(1)} %`],
    ["call site into an outlined body", (totals.callSite / totals.sites).toFixed(1), `${(100 * totals.callSite / grand).toFixed(1)} %`],
    ["boundary (exit, async)", (totals.boundary / totals.sites).toFixed(1), `${(100 * totals.boundary / grand).toFixed(1)} %`],
  ]);
}

function printSlowPath(census) {
  const rows = [...census.entries()].filter(([, row]) => row.executed > 1e6)
    .sort((a, b) => b[1].slow - a[1].slow).slice(0, 12);
  table("Fast vs slow path per instruction", ["opcode", "executed", "accesses", "dtlb", "slow %", "stack win", "slow", "exits"],
    rows.map(([opcode, row]) => [opcode, fmt(row.executed), fmt(row.accesses), fmt(row.dtlb),
      row.accesses ? `${row.slowPct.toFixed(1)} %` : "-", fmt(row.stkwin), fmt(row.slow), fmt(row.exits)]));
}

function printSlowReasons(reasons) {
  const rows = [...reasons.entries()].filter(([, row]) => row.slowArm > 1e3)
    .sort((a, b) => b[1].slowArm - a[1].slowArm).slice(0, 10);
  const share = (row, field) => row.slowArm ? `${(100 * row[field] / row.slowArm).toFixed(1)} %` : "-";
  table("What the DTLB entry held instead", ["opcode", "slow-arm", "other page", "misaligned", "no permission", "no host page"],
    rows.map(([opcode, row]) => [opcode, fmt(row.slowArm), share(row, "lpf"), share(row, "acm"),
      share(row, "perm"), share(row, "nohost")]));
}

function printIdealGap(matrix) {
  const rows = Object.entries(IDEAL_BYTES).filter(([opcode]) => matrix.rows.has(opcode));
  table("Distance from an ideal x86-64 -> wasm compiler", ["opcode", "today", "ideal", "ratio"],
    rows.map(([opcode, ideal]) => {
      const today = matrix.rows.get(opcode).bytesPerSite;
      return [opcode, today.toFixed(1), String(ideal), `${(today / ideal).toFixed(1)}x`];
    }));
}

function table(title, header, rows) {
  const widths = header.map((name, column) => Math.max(name.length, ...rows.map((row) => String(row[column] ?? "").length)));
  const line = (cells) => "  " + cells.map((cell, column) =>
    (column === 0 ? String(cell).padEnd(widths[column]) : String(cell).padStart(widths[column]))).join("  ");
  console.log(`## ${title}\n`);
  console.log(line(header));
  console.log("  " + widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
  console.log("");
}

function fmt(value) { return Number(value).toLocaleString("en-US"); }

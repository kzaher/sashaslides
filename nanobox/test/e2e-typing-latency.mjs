// What one keystroke costs in the emulated guest — the number behind "typing in codex lags".
//
//   node test/e2e-typing-latency.mjs [--only codex|sh] [--keys 5] [--out web/results]
//
// For each program it boots the codex image in the harness, waits for the program's prompt, then
// injects single characters 1.5 s apart with --io-log, which stamps every stdin/console event with
// wall time AND the guest's own instruction counter. Per keystroke that gives:
//
//   delivery  — key injected -> the engine hands the byte to the guest (our console path)
//   echo      — that byte -> the guest's first output chunk (the program's own work)
//
// `sh` is the floor of the guest's tty path (~0.07 M instructions); codex redraws its TUI, which is
// hundreds of times more. The budgets below are regression gates, not targets: they are set well
// above what is measured today (docs/codex-typing.md) so only a real regression trips them.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const KEYS = Number(opt("--keys", 4));
const OUT = opt("--out", join(ROOT, "web/results"));

const CASES = [
  { name: "sh", cmd: "/bin/sh -i", prompt: "#", budget: { echoMs: 60, echoMi: 2 } },
  { name: "codex", cmd: "/usr/local/bin/codex", prompt: "Press enter to continue", enterFirst: true, budget: { echoMs: 400, echoMi: 60 } },
];

const only = opt("--only", null);
const cases = only ? CASES.filter((c) => c.name === only) : CASES;
const results = [];
for (const c of cases) results.push(await measure(c));

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "typing-latency.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
console.log("\n=== summary (median of the typed characters) ===");
for (const r of results) {
  console.log(`${r.name.padEnd(6)} ${r.ok ? "PASS" : "FAIL"}  delivery ${r.deliveryMs} ms  echo ${r.echoMs} ms / ${r.echoMi} M instructions` +
    `  (budget ${r.budget.echoMs} ms / ${r.budget.echoMi} M)` + (r.note ? `  ${r.note}` : ""));
}
process.exit(results.every((r) => r.ok) ? 0 : 1);

async function measure(c) {
  const log = join(ROOT, `work/prof/typing-gate-${c.name}.jsonl`);
  mkdirSync(dirname(log), { recursive: true });
  rmSync(log, { force: true });
  const keys = [];
  if (c.enterFirst) keys.push("--after-expect", "\\r@800");           // codex's welcome screen wants Enter first
  for (let i = 0; i < KEYS; i++) keys.push("--after-expect", `${"abcdefgh"[i]}@${2500 + i * 1500}`);
  const stopAt = 2500 + KEYS * 1500;
  const args = [
    "harness/run.mjs", "build/eh-nb/out.wasm",
    "--oci", "http://localhost:8093/c2w/images/codex/", "--spec", "web/images/codex/config.json",
    "--oci-cache", "work/oci-cache", "--cmd", c.cmd, "--expect", c.prompt,
    "--quiet", "--no-hash", "--jit", "2:2000",
    "--jit-bundle", "build/eh-nb/jit/kernel.nbjb", "--jit-bundle", "build/eh-nb/jit/codex.nbjb",
    "--io-log", log, ...keys, "--stop-after-expect", String(stopAt), "--timeout", String(30 + Math.ceil(stopAt / 1000)),
  ];
  console.log(`\n=== ${c.name} — ${c.cmd}`);
  const rc = await run("node", args);
  const events = readEvents(log);
  const samples = perKeystroke(events).filter((s) => /^[a-h]$/.test(s.text));
  if (!samples.length) return { ...base(c), ok: false, note: `no keystroke echoed (harness rc=${rc}, ${events.length} events)` };
  const r = {
    ...base(c),
    keys: samples.length,
    deliveryMs: median(samples.map((s) => s.deliveryMs)),
    echoMs: median(samples.map((s) => s.echoMs)),
    echoMi: median(samples.map((s) => s.echoMi)),
    samples,
  };
  r.ok = r.echoMs <= c.budget.echoMs && r.echoMi <= c.budget.echoMi;
  if (!r.ok) r.note = `over budget (${r.echoMs} ms / ${r.echoMi} M vs ${c.budget.echoMs} ms / ${c.budget.echoMi} M)`;
  console.log(`  ${r.ok ? "PASS" : "FAIL"} ${c.name}: ${r.keys} keys, echo ${r.echoMs} ms / ${r.echoMi} M instructions, delivery ${r.deliveryMs} ms`);
  return r;
}

// key -> the engine taking the byte -> the guest's first output, in wall time and guest instructions
function perKeystroke(events) {
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const key = events[i];
    if (key.kind !== "key") continue;
    const rest = events.slice(i + 1);
    const taken = rest.find((e) => e.kind === "in"), echoed = rest.find((e) => e.kind === "out");
    if (!taken || !echoed) continue;
    out.push({
      text: key.text,
      deliveryMs: round(taken.wallMs - key.wallMs),
      echoMs: round(echoed.wallMs - taken.wallMs),
      echoMi: round((echoed.icount - taken.icount) / 1e6),
    });
  }
  return out;
}

function base(c) { return { name: c.name, cmd: c.cmd, budget: c.budget, ok: false }; }
function readEvents(file) {
  try { return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function median(values) { const s = [...values].sort((a, b) => a - b); return round(s[s.length >> 1]); }
function round(n) { return Math.round(n * 100) / 100; }
function run(bin, args) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
    p.stderr.on("data", (b) => { const s = String(b); if (/SUMMARY|STOP|ERROR|failed/.test(s)) process.stderr.write("  " + s.slice(0, 200).trim() + "\n"); });
    p.on("exit", (code) => resolve(code));
  });
}

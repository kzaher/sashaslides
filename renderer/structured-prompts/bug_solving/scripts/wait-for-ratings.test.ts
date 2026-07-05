/**
 * wait-for-ratings.test.ts — the per-fork BLOCKING rating gate CLI, exercised as
 * a subprocess (npx tsx wait-for-ratings.ts …). The CLI reads a resultsDir's
 * ratings.json, writes a rating-outcome marker, and ALWAYS exits 0 (a non-zero
 * exit would abort the already-SOLVED fork). Each case must be fast: we use a
 * tiny --poll-ms + a short BUG_SOLVING_RATING_TIMEOUT_MS so the not-all-rated
 * path returns off the deadline instead of blocking.
 */
import { execFileSync } from "child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const CLI = "wait-for-ratings.ts";

interface RunResult { code: number; stdout: string; stderr: string; }

/** Run the CLI; capture exit code + stdio. execFileSync throws on non-zero, so
 *  we catch and read status/stdout/stderr off the error. Never let it hang: a
 *  hard timeout aborts the child. */
function runCli(args: string[], env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync("npx", ["tsx", CLI, ...args], {
      cwd: SCRIPTS_DIR,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; signal?: string };
    if (err.signal) throw new Error(`CLI killed by signal ${err.signal} (likely a hang)`);
    return {
      code: err.status ?? -1,
      stdout: err.stdout ? String(err.stdout) : "",
      stderr: err.stderr ? String(err.stderr) : "",
    };
  }
}

function readMarker(f: string): Record<string, unknown> | null {
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}

function main() {
  console.log("\nwait-for-ratings CLI tests (subprocess, always exit 0)\n");
  const root = mkdtempSync(join(tmpdir(), "wfr-"));

  // (1) all requested slides good → exit 0, marker green:true, rated:true, empty bad/unrated.
  {
    const dir = mkdtempSync(join(root, "allgood-"));
    writeFileSync(join(dir, "ratings.json"), JSON.stringify({ slide_01: { status: "good" }, slide_02: { status: "good" } }));
    const marker = join(dir, "rating-outcome.json");
    const r = runCli(["--results-dir", dir, "--slides", "slide_01,slide_02", "--task-id", "t1", "--marker", marker, "--poll-ms", "20"]);
    const m = readMarker(marker);
    ok("(1) all good → exit 0", r.code === 0, `code=${r.code} stderr=${r.stderr.slice(-200)}`);
    ok("(1a) marker green:true, rated:true, bad=[], unrated=[]",
      m !== null && m.green === true && m.rated === true &&
      Array.isArray(m.bad) && (m.bad as unknown[]).length === 0 &&
      Array.isArray(m.unrated) && (m.unrated as unknown[]).length === 0, JSON.stringify(m));
  }

  // (2) one slide bad → green:false, bad lists it.
  {
    const dir = mkdtempSync(join(root, "onebad-"));
    writeFileSync(join(dir, "ratings.json"), JSON.stringify({ slide_01: { status: "good" }, slide_02: { status: "bad" } }));
    const marker = join(dir, "rating-outcome.json");
    const r = runCli(["--results-dir", dir, "--slides", "slide_01,slide_02", "--task-id", "t2", "--marker", marker, "--poll-ms", "20"]);
    const m = readMarker(marker);
    ok("(2) one bad → exit 0", r.code === 0, `code=${r.code}`);
    ok("(2a) marker green:false, bad=[slide_02]", m !== null && m.green === false && JSON.stringify(m.bad) === '["slide_02"]', JSON.stringify(m));
  }

  // (3) a slide missing/pending → green:false, unrated lists it (returns off the deadline).
  {
    const dir = mkdtempSync(join(root, "unrated-"));
    // slide_02 absent, slide_03 pending → both unrated → never allRated → deadline path.
    writeFileSync(join(dir, "ratings.json"), JSON.stringify({ slide_01: { status: "good" }, slide_03: { status: "pending" } }));
    const marker = join(dir, "rating-outcome.json");
    const r = runCli(
      ["--results-dir", dir, "--slides", "slide_01,slide_02,slide_03", "--task-id", "t3", "--marker", marker, "--poll-ms", "20"],
      { BUG_SOLVING_RATING_TIMEOUT_MS: "150" },
    );
    const m = readMarker(marker);
    ok("(3) unrated + deadline → exit 0 (no block)", r.code === 0, `code=${r.code}`);
    ok("(3a) marker green:false, unrated has the pending/missing slides",
      m !== null && m.green === false && Array.isArray(m.unrated) &&
      (m.unrated as string[]).includes("slide_02") && (m.unrated as string[]).includes("slide_03"), JSON.stringify(m));
  }

  // (4) BUG_SOLVING_NO_ACCEPT=1 → exits 0 immediately, marker green:false rated:false (skip path).
  {
    const dir = mkdtempSync(join(root, "noaccept-"));
    // no ratings.json at all — the skip path must not even read it.
    const marker = join(dir, "rating-outcome.json");
    const r = runCli(
      ["--results-dir", dir, "--slides", "slide_01", "--task-id", "t4", "--marker", marker, "--poll-ms", "20"],
      { BUG_SOLVING_NO_ACCEPT: "1" },
    );
    const m = readMarker(marker);
    ok("(4) NO_ACCEPT → exit 0", r.code === 0, `code=${r.code}`);
    ok("(4a) marker green:false, rated:false (skip path)", m !== null && m.green === false && m.rated === false, JSON.stringify(m));
  }

  // (5) missing --results-dir → still exit 0, best-effort not-green marker when --marker known.
  {
    const dir = mkdtempSync(join(root, "noresults-"));
    const marker = join(dir, "rating-outcome.json");
    const r = runCli(["--slides", "slide_01,slide_02", "--task-id", "t5", "--marker", marker, "--poll-ms", "20"]);
    const m = readMarker(marker);
    ok("(5) missing --results-dir → exit 0", r.code === 0, `code=${r.code}`);
    ok("(5a) best-effort not-green marker written",
      m !== null && m.green === false && JSON.stringify(m.slides) === '["slide_01","slide_02"]', JSON.stringify(m));
  }

  rmSync(root, { recursive: true, force: true });
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exit(1);
}
main();

/**
 * rating-server-overrides.test.ts — serve-sxs.sh's and rate-slides.sh's flags reach
 * rating-server.ts (they used to go through a wrapper that dropped them):
 *
 *   --goldens-dir   a "Good" click blesses the thumb THERE (serve-sxs.sh);
 *   --html-dir      each card links its fixture HTML, but it NEVER enables blessing
 *                   on its own (rate-slides.sh reviews arbitrary dirs);
 *   --ratings-file  verdicts land in that file, not <results>/ratings.json;
 *   and no candidate mode / history ledger unless asked: a goldens session must
 *   not write into bug_solving's candidates ledger.
 *
 * Boots the real server on temp dirs only (never e2e/goldens*).
 */
import { spawn, ChildProcess } from "child_process";
import { createServer } from "net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, "../../html2slides/rating-server.ts");

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

async function waitReady(port: number, deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try { if ((await fetch(`http://localhost:${port}/`)).ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function kill(child: ChildProcess): void {
  try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
  try { child.kill("SIGKILL"); } catch { /* gone */ }
}

async function boot(dir: string, extraArgs: string[]): Promise<{ child: ChildProcess; port: number; up: boolean; log: () => string }> {
  const port = await freePort();
  const child = spawn("npx", ["tsx", SERVER, dir, "--port", String(port), ...extraArgs], {
    cwd: dirname(SERVER), env: { ...process.env }, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (d) => { log += String(d); });
  child.stderr?.on("data", (d) => { log += String(d); });
  return { child, port, up: await waitReady(port, 25_000), log: () => log };
}

/** A results dir in the regen layout (originals/ + slides/), no meta.json. */
function seed(root: string, name: string): { results: string; html: string } {
  const results = join(root, name);
  mkdirSync(join(results, "originals"), { recursive: true });
  mkdirSync(join(results, "slides"), { recursive: true });
  writeFileSync(join(results, "originals", "slide_01.png"), "ORIGINAL");
  writeFileSync(join(results, "slides", "slide_01.png"), "THUMB-01");
  const html = join(root, `${name}-html`);
  mkdirSync(html, { recursive: true });
  writeFileSync(join(html, "slide_01.html"), "<html></html>");
  return { results, html };
}

async function rateGood(port: number): Promise<number> {
  const r = await fetch(`http://localhost:${port}/api/rate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "slide_01", status: "good" }),
  });
  return r.status;
}

async function main(): Promise<void> {
  console.log("\nrating-server --goldens-dir / --html-dir / --ratings-file\n");
  const root = mkdtempSync(join(tmpdir(), "rso-"));
  try {
    // serve-sxs.sh's invocation
    {
      const { results, html } = seed(root, "sxs");
      const goldens = join(root, "g-test");
      const ratingsFile = join(root, "elsewhere", "ratings.json");
      mkdirSync(dirname(ratingsFile), { recursive: true });
      const s = await boot(results, ["--goldens-dir", goldens, "--html-dir", html, "--ratings-file", ratingsFile, "--task-title", "t"]);
      ok("(1) server booted", s.up, s.log().slice(0, 500));
      if (s.up) {
        const comparisons = await (await fetch(`http://localhost:${s.port}/api/comparisons`)).json() as Array<{ id: string; htmlFile?: string }>;
        ok("(2) --html-dir links the fixture", comparisons.find((c) => c.id === "slide_01")?.htmlFile === join(html, "slide_01.html"), JSON.stringify(comparisons));
        ok("(3) Good → 200", (await rateGood(s.port)) === 200);
        ok("(4) --goldens-dir receives the blessed thumb", existsSync(join(goldens, "slide_01.png")) && readFileSync(join(goldens, "slide_01.png"), "utf-8") === "THUMB-01");
        ok("(5) --ratings-file receives the verdict", existsSync(ratingsFile) && JSON.parse(readFileSync(ratingsFile, "utf-8")).slide_01?.status === "good");
        ok("(6) <results>/ratings.json untouched", !existsSync(join(results, "ratings.json")));
        ok("(7) not candidate mode (no history ledger flag)", !s.log().includes("mode   candidate"), s.log().slice(0, 300));
      }
      kill(s.child);
    }
    // rate-slides.sh's invocation: --html-dir without --goldens-dir never blesses
    {
      const { results, html } = seed(root, "rate");
      const s = await boot(results, ["--html-dir", html, "--ratings-file", join(results, "ratings.json")]);
      ok("(8) server booted", s.up, s.log().slice(0, 500));
      if (s.up) {
        ok("(9) Good → 200", (await rateGood(s.port)) === 200);
        ok("(10) no goldens dir appears next to --html-dir", !existsSync(join(root, "goldens")));
      }
      kill(s.child);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed ? 1 : 0);
}
main();

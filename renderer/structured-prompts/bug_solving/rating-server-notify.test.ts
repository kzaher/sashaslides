/**
 * rating-server-notify.test.ts — the rating server's boot-time notification path
 * (rating-server.ts: fireNotify + the describeRatingIo I/O-contract print).
 *
 * fireNotify is NOT exported, so we exercise it by BOOTING the real server as a
 * subprocess on a free high port with a temp results dir, capturing stdout for a
 * few seconds, then killing the process group. Asserts:
 *   - the "🔔 NOTIFY USER" baseline line with the URL,
 *   - a configured --notify-cmd runs with token substitution ({url}),
 *   - the describeRatingIo contract is printed (e.g. "OUT    verdicts").
 *
 * Guarded so a spawn failure / hang reports a FAIL, not an infinite wait.
 */
import { spawn } from "child_process";
import { createServer } from "net";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
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

/** Ask the OS for a free ephemeral port (bind to :0, read the assigned port). */
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

/** Boot the server, collect stdout until `readyMatch` appears (or timeout), then
 *  kill the whole process group. Returns the captured stdout. */
function bootAndCapture(port: number, resultsDir: string, extraArgs: string[], env: Record<string, string>, captureMs: number): Promise<string> {
  return new Promise((resolveP) => {
    let out = "";
    let done = false;
    const child = spawn("npx", ["tsx", SERVER, resultsDir, "--port", String(port), ...extraArgs], {
      cwd: dirname(SERVER),
      env: { ...process.env, ...env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      try { child.kill("SIGKILL"); } catch { /* */ }
      resolveP(out);
    };
    child.stdout.on("data", (d) => {
      out += String(d);
      // once the notify line is printed the boot log is complete — stop early.
      if (out.includes("🔔 NOTIFY USER")) setTimeout(finish, 300);
    });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("error", (e) => { out += `SPAWN_ERROR: ${(e as Error).message}`; finish(); });
    const timer = setTimeout(finish, captureMs);
  });
}

/** Seed a minimal results dir so the server boots without erroring on missing IO. */
function seedResults(): string {
  const dir = mkdtempSync(join(tmpdir(), "rsn-"));
  writeFileSync(join(dir, "ratings.json"), JSON.stringify({}));
  return dir;
}

async function main() {
  console.log("\nrating-server notify tests (subprocess boot; fireNotify + describeRatingIo)\n");

  // (1) baseline notify line + describeRatingIo contract print.
  {
    const dir = seedResults();
    try {
      const port = await freePort();
      const out = await bootAndCapture(port, dir, ["--filter-slides", "slide_01"], {}, 25_000);
      ok("(1) stdout has '🔔 NOTIFY USER' with the URL", out.includes("🔔 NOTIFY USER") && out.includes(`http://localhost:${port}`), out.slice(0, 400));
      ok("(1a) stdout prints the describeRatingIo contract (OUT verdicts line)", out.includes("OUT    verdicts"), out.slice(0, 400));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // (2) configured --notify-cmd runs with {url} token substitution.
  {
    const dir = seedResults();
    try {
      const port = await freePort();
      const out = await bootAndCapture(
        port, dir, ["--filter-slides", "slide_01"],
        { BUG_SOLVING_NOTIFY_CMD: "echo NOTIFYCMD_FIRED {title} {url}" }, 25_000,
      );
      ok("(2) notify-cmd ran (NOTIFYCMD_FIRED present)", out.includes("NOTIFYCMD_FIRED"), out.slice(0, 500));
      ok("(2a) {url} substituted to the real URL", out.includes(`NOTIFYCMD_FIRED`) && out.includes(`http://localhost:${port}`), out.slice(0, 500));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exit(1);
}
main();

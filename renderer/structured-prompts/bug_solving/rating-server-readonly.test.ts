/**
 * rating-server-readonly.test.ts — proves the SxS rating UI is READ-ONLY except
 * for the Good/Bad rating buttons (rating-server.ts).
 *
 * Boots the real server as a subprocess on a free high port over a temp results
 * dir, then asserts against the served HTML + live endpoints:
 *   - the Good/Bad rating controls are present (the only mutating controls),
 *   - the comment <textarea> and the Pen/Rect/Clear drawing controls + the draw
 *     canvas / handlers are GONE,
 *   - /api/clear-annotation is disabled (410 Gone),
 *   - /api/rate records ONLY the status and IGNORES any comment/annotation in
 *     the body (the pre-existing ledger comment is preserved untouched),
 *   - /api/rate rejects a bad status (400).
 *
 * Guarded so a spawn failure / hang reports a FAIL, not an infinite wait.
 */
import { spawn, ChildProcess } from "child_process";
import { createServer } from "net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
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

/** Seed a minimal results dir with an EXISTING rating that carries a comment and
 *  annotation reference, so we can prove a later rating leaves them untouched. */
function seedResults(): string {
  const dir = mkdtempSync(join(tmpdir(), "rsr-"));
  // A real annotation file on disk: saveRating only preserves an annotation
  // reference whose file still exists.
  mkdirSync(join(dir, "annotations"), { recursive: true });
  const annotPath = join(dir, "annotations", "slide_01.png");
  writeFileSync(annotPath, Buffer.from("not-a-real-png-but-exists"));
  writeFileSync(
    join(dir, "ratings.json"),
    JSON.stringify({
      slide_01: { status: "bad", comment: "ORIGINAL_COMMENT", annotation: annotPath, ratedAt: "2020-01-01T00:00:00.000Z" },
    }, null, 2),
  );
  return dir;
}

/** Poll GET / until the server answers or the deadline passes. */
async function waitReady(port: number, deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://localhost:${port}/`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function kill(child: ChildProcess) {
  try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
  try { child.kill("SIGKILL"); } catch { /* */ }
}

async function main() {
  console.log("\nrating-server READ-ONLY tests (subprocess boot; served HTML + endpoints)\n");

  const dir = seedResults();
  const port = await freePort();
  const child = spawn("npx", ["tsx", SERVER, dir, "--port", String(port)], {
    cwd: dirname(SERVER),
    env: { ...process.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (d) => { log += String(d); });
  child.stderr?.on("data", (d) => { log += String(d); });

  try {
    const up = await waitReady(port, 25_000);
    ok("server booted", up, log.slice(0, 500));
    if (!up) { console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`); process.exit(1); }

    // (a) served HTML keeps the Good/Bad rating controls.
    const html = await (await fetch(`http://localhost:${port}/`)).text();
    ok("(a) Good rating control present", html.includes("rate('good')") && html.includes("Good"), "");
    ok("(a) Bad rating control present", html.includes("rate('bad')"), "");

    // (b) comment input + drawing controls are GONE.
    ok("(b) no comment textarea (id=\"comment\")", !html.includes('id="comment"'), "found comment input");
    ok("(b) no Pen tool (toolPen)", !html.includes("toolPen") && !html.includes("setTool("), "found pen tool");
    ok("(b) no Rect tool (toolRect)", !html.includes("toolRect"), "found rect tool");
    ok("(b) no Clear button (clearDraw)", !html.includes("clearDraw"), "found clear button");
    ok("(b) no draw canvas / handlers (drawCanvas, setupDrawCanvas)", !html.includes("drawCanvas") && !html.includes("setupDrawCanvas"), "found draw canvas");
    ok("(b) no draw colour/size pickers (drawColor)", !html.includes("drawColor"), "found colour picker");

    // (c) /api/clear-annotation is disabled (410 Gone).
    const clearResp = await fetch(`http://localhost:${port}/api/clear-annotation`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "slide_01" }),
    });
    ok("(c) /api/clear-annotation returns 410 (disabled)", clearResp.status === 410, `got ${clearResp.status}`);

    // (d) /api/rate records ONLY status; injected comment/annotation are ignored,
    //     and the pre-existing comment is preserved untouched.
    const rateResp = await fetch(`http://localhost:${port}/api/rate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "slide_01", status: "good", comment: "INJECTED_COMMENT", annotation: "data:image/png;base64,AAAA", shapes: [{ kind: "rect", x: 0, y: 0, w: 5, h: 5 }] }),
    });
    ok("(d) /api/rate accepts { id, status } (200)", rateResp.status === 200, `got ${rateResp.status}`);
    const ratings = JSON.parse(readFileSync(join(dir, "ratings.json"), "utf-8"));
    ok("(d) status updated to good", ratings.slide_01?.status === "good", JSON.stringify(ratings.slide_01));
    ok("(d) injected comment IGNORED — original comment preserved", ratings.slide_01?.comment === "ORIGINAL_COMMENT", JSON.stringify(ratings.slide_01));
    ok("(d) annotation reference preserved (not overwritten)", ratings.slide_01?.annotation === join(dir, "annotations", "slide_01.png"), JSON.stringify(ratings.slide_01));

    // (e) /api/rate rejects an invalid status (400).
    const badResp = await fetch(`http://localhost:${port}/api/rate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "slide_01", status: "maybe" }),
    });
    ok("(e) /api/rate rejects invalid status (400)", badResp.status === 400, `got ${badResp.status}`);
  } finally {
    kill(child);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exit(1);
}
main();

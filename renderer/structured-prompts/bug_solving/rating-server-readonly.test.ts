/**
 * rating-server-readonly.test.ts — proves the SxS rating server serves TWO modes
 * from ONE codebase, gated on the boot `--read-only` flag (rating-server.ts):
 *
 *   READ-ONLY  (--read-only, the merge/verdict gate): comment input + every
 *              annotation drawing tool (pen/rect/clear/colour/size + draw canvas
 *              & handlers) are STRIPPED from the served HTML; /api/clear-annotation
 *              returns 410; /api/rate records ONLY { id, status } and IGNORES any
 *              injected comment/annotation (the pre-existing ledger comment is
 *              preserved untouched); an invalid status is 400.
 *
 *   DEFAULT    (no flag, the normal defect-identification rating): comment
 *              <textarea> + Pen/Rect/Clear drawing tools + draw canvas ARE
 *              present; /api/rate with a comment PERSISTS it; /api/clear-annotation
 *              works (200).
 *
 * Plus two cross-mode invariants:
 *   - the end-of-deck completion popup (#donePopup + showDone end-of-deck guard)
 *     ships in BOTH modes' HTML;
 *   - a "Good" /api/rate returns FAST over a many-slide dir and archives ONLY the
 *     rated slide — proving saveRating no longer triggers the full-deck
 *     findComparisons() rescan (the source of the multi-second "Good" stall).
 *
 * Boots the real server as subprocesses on free high ports over temp results
 * dirs. Guarded so a spawn failure / hang reports a FAIL, not an infinite wait.
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

/** Seed N flat-layout slide pairs (slide_NN_original.png + slide_NN_slides.png)
 *  so a "Good" rating has real files to archive and a full-deck scan would have
 *  many files to churn through. */
function seedManySlides(dir: string, n: number): void {
  for (let i = 1; i <= n; i++) {
    const id = "slide_" + String(i).padStart(2, "0");
    writeFileSync(join(dir, `${id}_original.png`), Buffer.from(`orig-${id}`));
    writeFileSync(join(dir, `${id}_slides.png`), Buffer.from(`slides-${id}`));
  }
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

/** Boot the real server as a subprocess and wait until it answers. */
async function boot(dir: string, extraArgs: string[]): Promise<{ child: ChildProcess; port: number; up: boolean; log: () => string }> {
  const port = await freePort();
  const child = spawn("npx", ["tsx", SERVER, dir, "--port", String(port), ...extraArgs], {
    cwd: dirname(SERVER),
    env: { ...process.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (d) => { log += String(d); });
  child.stderr?.on("data", (d) => { log += String(d); });
  const up = await waitReady(port, 25_000);
  return { child, port, up, log: () => log };
}

async function main() {
  console.log("\nrating-server MODE tests (subprocess boot; served HTML + endpoints)\n");

  // ===================== READ-ONLY mode (--read-only) =====================
  console.log("--- READ-ONLY (--read-only) ---");
  const roDir = seedResults();
  const ro = await boot(roDir, ["--read-only"]);
  ok("[RO] server booted", ro.up, ro.log().slice(0, 500));
  if (ro.up) {
    const html = await (await fetch(`http://localhost:${ro.port}/`)).text();
    // (a) Good/Bad verdict controls present (the only mutating controls).
    ok("[RO] Good rating control present", html.includes("rate('good')") && html.includes("Good"));
    ok("[RO] Bad rating control present", html.includes("rate('bad')"));
    // (b) comment input + drawing controls are GONE.
    ok("[RO] no comment textarea (id=\"comment\")", !html.includes('id="comment"'), "found comment input");
    ok("[RO] no Pen tool (toolPen/setTool)", !html.includes("toolPen") && !html.includes("setTool("), "found pen tool");
    ok("[RO] no Rect tool (toolRect)", !html.includes("toolRect"), "found rect tool");
    ok("[RO] no Clear button (clearDraw)", !html.includes("clearDraw"), "found clear button");
    ok("[RO] no draw canvas / handlers (drawCanvas/setupDrawCanvas)", !html.includes("drawCanvas") && !html.includes("setupDrawCanvas"), "found draw canvas");
    ok("[RO] no draw colour picker (drawColor)", !html.includes("drawColor"), "found colour picker");
    // (b2) completion popup ships in read-only too.
    ok("[RO] completion popup present (#donePopup + showDone)", html.includes('id="donePopup"') && html.includes("showDone()"));
    // (c) /api/clear-annotation is disabled (410 Gone).
    const clearResp = await fetch(`http://localhost:${ro.port}/api/clear-annotation`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "slide_01" }),
    });
    ok("[RO] /api/clear-annotation returns 410", clearResp.status === 410, `got ${clearResp.status}`);
    // (d) /api/rate records ONLY status; injected comment/annotation ignored.
    const rateResp = await fetch(`http://localhost:${ro.port}/api/rate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "slide_01", status: "good", comment: "INJECTED_COMMENT", annotation: "data:image/png;base64,AAAA", shapes: [{ kind: "rect", x: 0, y: 0, w: 5, h: 5 }] }),
    });
    ok("[RO] /api/rate accepts { id, status } (200)", rateResp.status === 200, `got ${rateResp.status}`);
    const ratings = JSON.parse(readFileSync(join(roDir, "ratings.json"), "utf-8"));
    ok("[RO] status updated to good", ratings.slide_01?.status === "good", JSON.stringify(ratings.slide_01));
    ok("[RO] injected comment IGNORED — original preserved", ratings.slide_01?.comment === "ORIGINAL_COMMENT", JSON.stringify(ratings.slide_01));
    ok("[RO] annotation reference preserved", ratings.slide_01?.annotation === join(roDir, "annotations", "slide_01.png"), JSON.stringify(ratings.slide_01));
    // (e) /api/rate rejects an invalid status (400).
    const badResp = await fetch(`http://localhost:${ro.port}/api/rate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "slide_01", status: "maybe" }),
    });
    ok("[RO] /api/rate rejects invalid status (400)", badResp.status === 400, `got ${badResp.status}`);
  }
  kill(ro.child);
  rmSync(roDir, { recursive: true, force: true });

  // ===================== DEFAULT (editable) mode ==========================
  console.log("\n--- DEFAULT (editable, no flag) ---");
  const edDir = seedResults();
  seedManySlides(edDir, 80); // many files → a full-deck scan would be expensive
  const ed = await boot(edDir, []);
  ok("[ED] server booted", ed.up, ed.log().slice(0, 500));
  if (ed.up) {
    const html = await (await fetch(`http://localhost:${ed.port}/`)).text();
    // Editable controls present.
    ok("[ED] comment textarea present (id=\"comment\")", html.includes('id="comment"'), "no comment input");
    ok("[ED] Pen tool present (toolPen)", html.includes("toolPen") && html.includes("setTool("), "no pen tool");
    ok("[ED] Rect tool present (toolRect)", html.includes("toolRect"), "no rect tool");
    ok("[ED] Clear button present (clearDraw)", html.includes("clearDraw"), "no clear button");
    ok("[ED] draw canvas present (drawCanvas/setupDrawCanvas)", html.includes("drawCanvas") && html.includes("setupDrawCanvas"), "no draw canvas");
    // Completion popup ships in editable too.
    ok("[ED] completion popup present (#donePopup + showDone)", html.includes('id="donePopup"') && html.includes("showDone()"));

    // /api/rate WITH a comment persists it (editable semantics).
    const rateResp = await fetch(`http://localhost:${ed.port}/api/rate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "slide_01", status: "bad", comment: "NEW_EDITABLE_COMMENT" }),
    });
    ok("[ED] /api/rate accepts a comment (200)", rateResp.status === 200, `got ${rateResp.status}`);
    const ratings = JSON.parse(readFileSync(join(edDir, "ratings.json"), "utf-8"));
    ok("[ED] comment persisted", ratings.slide_01?.comment === "NEW_EDITABLE_COMMENT", JSON.stringify(ratings.slide_01));

    // /api/clear-annotation works (200) in editable mode.
    const clearResp = await fetch(`http://localhost:${ed.port}/api/clear-annotation`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "slide_01" }),
    });
    ok("[ED] /api/clear-annotation works (200)", clearResp.status === 200, `got ${clearResp.status}`);

    // PERF / scoping: a "Good" rating over an 80-slide dir returns fast and
    // archives ONLY the rated slide — proving saveRating resolves the single
    // slide's paths directly instead of the full-deck findComparisons() rescan.
    const t0 = Date.now();
    const goodResp = await fetch(`http://localhost:${ed.port}/api/rate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "slide_50", status: "good" }),
    });
    const elapsed = Date.now() - t0;
    ok("[ED] /api/rate good (200)", goodResp.status === 200, `got ${goodResp.status}`);
    ok("[ED] /api/rate good returns fast (<2000ms over 80 slides)", elapsed < 2000, `took ${elapsed}ms`);
    const snapDir = join(edDir, "regression-snapshots");
    ok("[ED] rated slide archived", existsSync(join(snapDir, "slide_50_original.png")) && existsSync(join(snapDir, "slide_50_slides.png")), "snapshot missing");
    ok("[ED] non-rated slides NOT archived (no full-deck scan)", !existsSync(join(snapDir, "slide_01_original.png")) && !existsSync(join(snapDir, "slide_02_original.png")), "unexpected extra snapshot");
  }
  kill(ed.child);
  rmSync(edDir, { recursive: true, force: true });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exit(1);
}
main();

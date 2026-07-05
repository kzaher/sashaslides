/**
 * rating-gate.test.ts — the per-thread rating gate blocks until every slide is
 * rated good/bad, then reports the split. No real timers/fs/browser: the ledger
 * reader and the sleep are injected.
 */
import { readRatings, waitForRatings, waitForRatingsIo, type RatingSplit } from "./rating-gate.js";
import { resolveRatingIo } from "./sxs-io.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}
async function main() {
  console.log("\nrating-gate tests (blocking gate, injected read/sleep)\n");

  // (1) readRatings splits good/bad/unrated from a real ledger file.
  {
    const dir = mkdtempSync(join(tmpdir(), "rg-"));
    const f = join(dir, "ratings.json");
    writeFileSync(f, JSON.stringify({ slide_01: { status: "good" }, slide_02: { status: "bad" }, slide_03: { status: "pending" } }));
    const s = readRatings(f, ["slide_01", "slide_02", "slide_03", "slide_04"]);
    ok("(1) readRatings splits good/bad/unrated (absent + non-good/bad = unrated)",
      JSON.stringify(s.good) === '["slide_01"]' && JSON.stringify(s.bad) === '["slide_02"]' &&
      JSON.stringify(s.unrated) === '["slide_03","slide_04"]' && s.allRated === false,
      JSON.stringify(s));
    rmSync(dir, { recursive: true, force: true });
  }

  // (2) unparseable / missing file → all slides unrated (never a false accept).
  {
    const s = readRatings("/no/such/ratings.json", ["slide_01"]);
    ok("(2) missing ledger → all unrated, not allRated", !s.allRated && s.unrated.length === 1 && s.good.length === 0);
  }

  // (3) waitForRatings BLOCKS through unrated ticks, resolves only when all rated.
  {
    const seq: RatingSplit[] = [
      { allRated: false, good: [], bad: [], unrated: ["slide_01", "slide_02"] },
      { allRated: false, good: ["slide_01"], bad: [], unrated: ["slide_02"] },
      { allRated: true, good: ["slide_01"], bad: ["slide_02"], unrated: [] },
    ];
    let i = 0, sleeps = 0;
    const final = await waitForRatings("x", ["slide_01", "slide_02"], {
      pollMs: 1,
      deps: {
        read: () => seq[Math.min(i++, seq.length - 1)],
        sleep: async () => { sleeps++; },
      },
    });
    ok("(3) waits through unrated ticks, resolves on all-rated", final.allRated && final.good.length === 1 && final.bad.length === 1);
    ok("(3b) slept exactly for each not-yet-complete tick (2 sleeps before the 3rd read)", sleeps === 2, `sleeps=${sleeps}`);
  }

  // (4) empty slide list returns immediately (nothing to gate on).
  {
    let read = 0;
    const final = await waitForRatings("x", [], { deps: { read: () => { read++; return { allRated: false, good: [], bad: [], unrated: [] }; } } });
    ok("(4) empty slide set → immediate allRated, no ledger read", final.allRated && read === 0);
  }

  // (5) abort mid-wait rejects.
  {
    let threw = false;
    try {
      await waitForRatings("x", ["slide_01"], {
        pollMs: 1,
        deps: { read: () => ({ allRated: false, good: [], bad: [], unrated: ["slide_01"] }), sleep: async () => {}, aborted: () => true },
      });
    } catch (e) { threw = (e as Error).message.includes("aborted"); }
    ok("(5) aborted() → wait rejects", threw);
  }

  // (6) waitForRatingsIo blocks on cfg.ratingsFile (the documented I/O contract),
  //     resolving off the config path — same blocking semantics as waitForRatings.
  {
    const cfg = resolveRatingIo({ resultsDir: "/tmp/rg-io-x" });
    let seenFile = "";
    let i = 0, sleeps = 0;
    const seq: RatingSplit[] = [
      { allRated: false, good: [], bad: [], unrated: ["slide_01"] },
      { allRated: true, good: ["slide_01"], bad: [], unrated: [] },
    ];
    const final = await waitForRatingsIo(cfg, ["slide_01"], {
      pollMs: 1,
      deps: {
        read: (file) => { seenFile = file; return seq[Math.min(i++, seq.length - 1)]; },
        sleep: async () => { sleeps++; },
      },
    });
    ok("(6) waitForRatingsIo reads cfg.ratingsFile", seenFile === cfg.ratingsFile, `read ${seenFile}, want ${cfg.ratingsFile}`);
    ok("(6b) waitForRatingsIo blocks then resolves on all-rated", final.allRated && final.good.length === 1 && sleeps === 1, `sleeps=${sleeps}`);
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exit(1);
}
main();

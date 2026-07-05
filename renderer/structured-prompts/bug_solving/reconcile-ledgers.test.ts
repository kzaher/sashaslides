/**
 * reconcile-ledgers.test.ts — the deterministic ledger reconciler + pre-solve
 * validation + auto cluster generation.
 *
 * Covers:
 *   - reconcileLedgers precedence (candidates > baseline > history; live never
 *     sets status), issue-text preference (baseline richest > terse candidates),
 *     demote-conflict recorded+resolved, stale-live cross-check, unrated fallbacks.
 *   - checkReconciled C1–C6 (missing fixture, empty issue, unresolved conflict,
 *     invalid/dup id, happy path, empty badSet warn, C4 image warn).
 *   - generateClusters: one cluster per bad slide, exports CLUSTERS, and the
 *     emitted source re-parses (imported via a temp file under this dir).
 *   - REAL-LEDGER integration: badSet === [slide_11, slide_13, slide_14] (skips
 *     gracefully if a ledger file is absent so the test stays portable).
 *
 * Run: cd /workspaces/sashaslides && npx tsx renderer/structured-prompts/bug_solving/reconcile-ledgers.test.ts
 */
import {
  reconcileLedgers,
  checkReconciled,
  loadLedger,
  type LedgerSources,
  type ReconciledLedger,
} from "./reconcile-ledgers.js";
import { generateClusters } from "./generate-clusters.js";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** A reconciled ledger whose only bad slide is `id`, with a fixture + issue, for
 *  the check tests. */
function reconciledWith(sources: LedgerSources): ReconciledLedger {
  return reconcileLedgers(sources);
}

function main() {
  console.log("\nreconcile-ledgers tests (precedence + checks + generate-clusters)\n");

  // =========================================================================
  // reconcileLedgers — precedence
  // =========================================================================

  // (1) candidates wins over baseline/history for STATUS; live never sets it.
  {
    const r = reconcileLedgers({
      candidates: { slide_11: { status: "bad", comment: "No" } },
      baseline: { slide_11: { status: "good", comment: "user words" } },
      history: { slide_11: { status: "good" } },
      live: { slide_11: { status: "good" } },
    });
    ok("(1) candidates(bad) wins over baseline/history(good)", r.slides.slide_11.status === "bad");
    ok("(1a) needsSolve true when bad", r.slides.slide_11.needsSolve === true);
    ok("(1b) badSet contains the bad slide", JSON.stringify(r.badSet) === '["slide_11"]', JSON.stringify(r.badSet));
  }

  // (2) stale live is ignored for status: candidates=good beats live=bad.
  {
    const r = reconcileLedgers({
      candidates: { slide_04: { status: "good" } },
      baseline: { slide_04: { status: "bad", comment: "Bad tick positioning." } },
      live: { slide_04: { status: "bad", comment: "Bad tick positioning." } },
    });
    ok("(2) candidates(good) wins over baseline(bad) + live(bad)", r.slides.slide_04.status === "good");
    ok("(2a) not in badSet", r.badSet.length === 0, JSON.stringify(r.badSet));
    ok("(2b) live-stale conflict recorded (resolved)",
      r.slides.slide_04.conflicts.some((c) => /live=bad/.test(c) && /candidates/.test(c)) &&
      r.conflicts.some((c) => c.slide === "slide_04" && c.resolved && /live/.test(c.detail)));
  }

  // (3) baseline wins over history when candidates abstains.
  {
    const r = reconcileLedgers({
      candidates: {},
      baseline: { slide_20: { status: "good" } },
      history: { slide_20: { status: "bad" } },
    });
    ok("(3) baseline wins over history (no candidates verdict)", r.slides.slide_20.status === "good");
    ok("(3a) baseline-vs-history conflict recorded resolved",
      r.conflicts.some((c) => c.slide === "slide_20" && c.resolved && /baseline wins/.test(c.detail)));
  }

  // (4) unrated fallbacks: pending / absent → unrated, not in badSet.
  {
    const r = reconcileLedgers({
      candidates: { slide_50: { status: "pending" } },
      baseline: {},
      history: {},
      live: { slide_50: { status: "bad" } }, // live alone can't make it bad
    });
    ok("(4) pending candidates + only live → unrated", r.slides.slide_50.status === "unrated");
    ok("(4a) unrated → not needsSolve", r.slides.slide_50.needsSolve === false);
    ok("(4b) unrated → not in badSet", !r.badSet.includes("slide_50"));
  }

  // =========================================================================
  // reconcileLedgers — issue-text preference
  // =========================================================================

  // (5) baseline's rich comment beats candidates' terse "No".
  {
    const rich = "Not a list in output, is it possible to color bullets in a list element?";
    const r = reconcileLedgers({
      candidates: { slide_11: { status: "bad", comment: "No" } },
      baseline: { slide_11: { status: "good", comment: rich } },
      history: { slide_11: { status: "good", comment: "history words" } },
    });
    ok("(5) issue prefers baseline rich comment over candidates 'No'", r.slides.slide_11.issue === rich, r.slides.slide_11.issue);
  }

  // (6) history fills in when baseline has no comment; candidates last resort.
  {
    const r1 = reconcileLedgers({
      candidates: { slide_60: { status: "bad", comment: "cand" } },
      baseline: { slide_60: { status: "bad" } }, // no comment
      history: { slide_60: { status: "good", comment: "history words" } },
    });
    ok("(6) history comment used when baseline empty", r1.slides.slide_60.issue === "history words", r1.slides.slide_60.issue);
    const r2 = reconcileLedgers({
      candidates: { slide_61: { status: "bad", comment: "only candidates" } },
    });
    ok("(6a) candidates comment as last resort", r2.slides.slide_61.issue === "only candidates");
    // issue also reads the `issue` field when comment is absent.
    const r3 = reconcileLedgers({ baseline: { slide_62: { status: "bad", issue: "issue-field text" } } });
    ok("(6b) reads `issue` field when no comment", r3.slides.slide_62.issue === "issue-field text");
  }

  // (7) demote conflict: baseline=good but candidates=bad → recorded + resolved.
  {
    const r = reconcileLedgers({
      candidates: { slide_14: { status: "bad" } },
      baseline: { slide_14: { status: "good", comment: "border style" } },
    });
    ok("(7) demote conflict recorded on slide",
      r.slides.slide_14.conflicts.some((c) => /baseline=good but candidates=bad/.test(c) && /demoted after merge failure/.test(c)));
    ok("(7a) demote conflict is RESOLVED (candidates wins)",
      r.conflicts.some((c) => c.slide === "slide_14" && c.resolved === true));
    ok("(7b) no UNRESOLVED conflicts under strict precedence", r.conflicts.every((c) => c.resolved));
  }

  // =========================================================================
  // checkReconciled — C1..C6
  // =========================================================================

  // Build a temp fixtures dir + images dir for the happy-path check.
  const scratch = mkdtempSync(join(tmpdir(), "reconcile-"));
  const fixturesDir = join(scratch, "fixtures");
  const imagesDir = join(scratch, "images");
  mkdirSync(fixturesDir, { recursive: true });
  mkdirSync(join(imagesDir, "originals"), { recursive: true });
  mkdirSync(join(imagesDir, "slides"), { recursive: true });

  // (8) happy path: one bad slide with fixture + issue + images → ok true.
  {
    writeFileSync(join(fixturesDir, "slide_11.html"), "<html></html>");
    writeFileSync(join(imagesDir, "originals", "slide_11.png"), "x");
    writeFileSync(join(imagesDir, "slides", "slide_11.png"), "x");
    const r = reconciledWith({ candidates: { slide_11: { status: "bad", comment: "an issue" } } });
    const rep = checkReconciled(r, { fixturesDir, imagesDir });
    ok("(8) happy path → ok true", rep.ok === true, JSON.stringify(rep.failures));
    ok("(8a) badSet echoed", JSON.stringify(rep.badSet) === '["slide_11"]');
    ok("(8b) no failures", rep.failures.length === 0);
  }

  // (9) C2 missing fixture → FAILURE.
  {
    const r = reconciledWith({ candidates: { slide_99: { status: "bad", comment: "x" } } });
    const rep = checkReconciled(r, { fixturesDir });
    ok("(9) missing fixture → ok false", rep.ok === false);
    ok("(9a) C2 failure listed", rep.failures.some((f) => /^C2:/.test(f) && /slide_99/.test(f)));
  }

  // (10) C3 empty issue → FAILURE (fixture present, no comment anywhere).
  {
    writeFileSync(join(fixturesDir, "slide_77.html"), "<html></html>");
    const r = reconciledWith({ candidates: { slide_77: { status: "bad" } } });
    const rep = checkReconciled(r, { fixturesDir });
    ok("(10) empty issue → ok false", rep.ok === false);
    ok("(10a) C3 failure listed", rep.failures.some((f) => /^C3:/.test(f) && /slide_77/.test(f)));
  }

  // (11) C1 empty badSet → WARNING, ok stays true.
  {
    const r = reconciledWith({ candidates: { slide_01: { status: "good" } } });
    const rep = checkReconciled(r, { fixturesDir });
    ok("(11) empty badSet → ok true (warn only)", rep.ok === true);
    ok("(11a) C1 warning present", rep.warnings.some((w) => /^C1:/.test(w)));
  }

  // (12) C4 missing image → WARNING (fixture + issue present so no failure).
  {
    writeFileSync(join(fixturesDir, "slide_88.html"), "<html></html>");
    const r = reconciledWith({ candidates: { slide_88: { status: "bad", comment: "issue" } } });
    const rep = checkReconciled(r, { fixturesDir, imagesDir }); // no slide_88 pngs
    ok("(12) missing image → still ok true", rep.ok === true, JSON.stringify(rep.failures));
    ok("(12a) C4 warning present", rep.warnings.some((w) => /^C4:/.test(w) && /slide_88/.test(w)));
  }

  // (13) C5 unresolved conflict → FAILURE. We synthesize an unresolved conflict
  //      directly (reconcileLedgers never emits one, so this guards the check).
  {
    const r: ReconciledLedger = {
      slides: {
        slide_11: { status: "bad", needsSolve: true, issue: "x", sources: {}, conflicts: [] },
      },
      badSet: ["slide_11"],
      conflicts: [{ slide: "slide_11", detail: "two equal sources disagree", resolved: false }],
    };
    writeFileSync(join(fixturesDir, "slide_11.html"), "<html></html>");
    const rep = checkReconciled(r, { fixturesDir });
    ok("(13) unresolved conflict → ok false", rep.ok === false);
    ok("(13a) C5 failure listed", rep.failures.some((f) => /^C5:/.test(f) && /UNRESOLVED/.test(f)));
  }

  // (13b) resolved conflict → WARNING only.
  {
    const r: ReconciledLedger = {
      slides: { slide_11: { status: "bad", needsSolve: true, issue: "x", sources: {}, conflicts: [] } },
      badSet: ["slide_11"],
      conflicts: [{ slide: "slide_11", detail: "demote", resolved: true }],
    };
    writeFileSync(join(fixturesDir, "slide_11.html"), "<html></html>");
    const rep = checkReconciled(r, { fixturesDir });
    ok("(13b) resolved conflict → ok true, warned", rep.ok === true && rep.warnings.some((w) => /^C5:/.test(w)));
  }

  // (14) C6 invalid / duplicate ids → FAILURE.
  {
    const r: ReconciledLedger = {
      slides: {
        "not-a-slide": { status: "bad", needsSolve: true, issue: "x", sources: {}, conflicts: [] },
      },
      badSet: ["not-a-slide", "not-a-slide"], // invalid + duplicate
      conflicts: [],
    };
    const rep = checkReconciled(r, { fixturesDir });
    ok("(14) invalid id → ok false", rep.ok === false);
    ok("(14a) C6 invalid-form failure", rep.failures.some((f) => /^C6:/.test(f) && /not of the form/.test(f)));
    ok("(14b) C6 duplicate failure", rep.failures.some((f) => /^C6:/.test(f) && /duplicate/.test(f)));
  }

  // =========================================================================
  // generateClusters
  // =========================================================================

  // (15) one Cluster per bad slide + exports CLUSTERS; emitted source re-parses.
  {
    const r = reconcileLedgers({
      candidates: {
        slide_11: { status: "bad", comment: "No" },
        slide_13: { status: "bad" },
        slide_14: { status: "bad" },
      },
      baseline: {
        slide_11: { status: "good", comment: "color bullets in a list element" },
        slide_13: { status: "bad", comment: "many rendered regions on the right" },
        slide_14: { status: "good", comment: "top border style transferred wrong" },
      },
    });
    const src = generateClusters(r, { retryBudget: 5 });
    ok("(15) exports CLUSTERS", /export const CLUSTERS: Cluster\[\] =/.test(src));
    ok("(15a) imports Cluster type", /import type \{ Cluster \} from ".\/workspace-setup.js"/.test(src));
    const clusterCount = (src.match(/: Cluster = \{/g) || []).length;
    ok("(15b) one Cluster per bad slide (3)", clusterCount === 3, `count=${clusterCount}`);
    for (const id of ["slide_11", "slide_13", "slide_14"]) {
      ok(`(15c) slide_ids for ${id} present`, src.includes(`slide_ids: ["${id}"]`), id);
    }
    ok("(15d) retry_budget applied", /retry_budget: 5/.test(src));

    // Re-parse: write the emitted source into THIS directory so its relative
    // `./workspace-setup.js` import resolves, then import it via tsx.
    const tmpFile = join(HERE, ".__emitted_clusters_test.ts");
    let importedCount = -1;
    let importedIds: string[] = [];
    try {
      writeFileSync(tmpFile, src);
      const out = execFileSync(
        "npx",
        ["tsx", "-e",
          `import(${JSON.stringify(tmpFile)}).then(m => { process.stdout.write(JSON.stringify({ n: m.CLUSTERS.length, ids: m.CLUSTERS.flatMap(c => c.slide_ids) })); });`,
        ],
        { cwd: HERE, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      const parsed = JSON.parse(out.trim());
      importedCount = parsed.n;
      importedIds = parsed.ids;
    } catch (e) {
      console.log(`      (import failed: ${(e as Error).message.slice(0, 200)})`);
    } finally {
      rmSync(tmpFile, { force: true });
    }
    ok("(15e) emitted source imports as valid TS (CLUSTERS.length===3)", importedCount === 3, `n=${importedCount}`);
    ok("(15f) imported clusters carry the right slide ids",
      JSON.stringify(importedIds.sort()) === JSON.stringify(["slide_11", "slide_13", "slide_14"]), JSON.stringify(importedIds));
  }

  // (16) empty bad set → valid source with empty CLUSTERS.
  {
    const r = reconcileLedgers({ candidates: { slide_01: { status: "good" } } });
    const src = generateClusters(r, { retryBudget: 3 });
    ok("(16) empty bad set → CLUSTERS: Cluster[] = []", /export const CLUSTERS: Cluster\[\] = \[\];/.test(src), src.split("\n").slice(-3).join(" "));
  }

  // =========================================================================
  // REAL-LEDGER integration (portable: skips if a ledger is absent)
  // =========================================================================
  {
    const REPO = "/workspaces/sashaslides";
    const paths = {
      candidates: `${REPO}/.bug-solving-history/candidates.json`,
      baseline: `${REPO}/renderer/html2slides/e2e/.ratings-complex.json`,
      history: `${REPO}/.bug-solving-history/ratings.json`,
      live: "/tmp/sxs-complex/ratings.json",
    };
    // candidates + baseline are the load-bearing ones for the badSet assertion.
    if (existsSync(paths.candidates) && existsSync(paths.baseline)) {
      const r = reconcileLedgers({
        candidates: loadLedger(paths.candidates),
        baseline: loadLedger(paths.baseline),
        history: loadLedger(paths.history),
        live: loadLedger(paths.live),
      });
      ok("(17) real ledgers → badSet === [slide_11, slide_13, slide_14]",
        JSON.stringify(r.badSet) === '["slide_11","slide_13","slide_14"]', JSON.stringify(r.badSet));
      ok("(17a) slide_11 flagged baseline-good-but-candidates-bad demote",
        r.slides.slide_11?.conflicts.some((c) => /baseline=good but candidates=bad/.test(c)) === true);
      ok("(17b) slide_14 flagged baseline-good-but-candidates-bad demote",
        r.slides.slide_14?.conflicts.some((c) => /baseline=good but candidates=bad/.test(c)) === true);
    } else {
      console.log("  ⊘ (17) real-ledger badSet case skipped (ledger file absent — portable)");
    }
  }

  rmSync(scratch, { recursive: true, force: true });
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exit(1);
}
main();

/**
 * sxs-io.test.ts — the documented I/O contract resolvers + describers.
 *
 * resolveRatingIo / resolveRecordIo turn a partial input into fully-defaulted,
 * absolute paths; describeRatingIo / describeRecordIo print the IN/OUT/LEDGER
 * groups. Pure functions, no fs/network — just assertions on the returned paths.
 */
import { resolveRatingIo, resolveRecordIo, describeRatingIo, describeRecordIo } from "./sxs-io.js";
import { join, resolve, isAbsolute } from "path";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}

function main() {
  console.log("\nsxs-io tests (I/O contract resolvers + describers)\n");

  // -------------------------------------------------------------------------
  // resolveRatingIo
  // -------------------------------------------------------------------------
  {
    const R = resolve("/tmp/results-x");
    const cfg = resolveRatingIo({ resultsDir: "/tmp/results-x" });
    ok("(1) resultsDir resolved absolute", cfg.resultsDir === R);
    ok("(1a) slidesDir default = <results>/slides", cfg.slidesDir === join(R, "slides"), cfg.slidesDir);
    ok("(1b) originalsDir default = <results>/originals", cfg.originalsDir === join(R, "originals"), cfg.originalsDir);
    ok("(1c) ratingsFile = <results>/ratings.json", cfg.ratingsFile === join(R, "ratings.json"), cfg.ratingsFile);
    ok("(1d) manifestFile = <results>/thumbs/manifest.json", cfg.manifestFile === join(R, "thumbs", "manifest.json"), cfg.manifestFile);
    ok("(1e) metaFile = <results>/sxs-meta.json", cfg.metaFile === join(R, "sxs-meta.json"), cfg.metaFile);
    ok("(1f) renderParamsFile = <results>/meta.json", cfg.renderParamsFile === join(R, "meta.json"), cfg.renderParamsFile);
    ok("(1g) annotationsDir = <results>/annotations", cfg.annotationsDir === join(R, "annotations"), cfg.annotationsDir);
    ok("(1h) zoomCropsDir = <results>/zoom-crops", cfg.zoomCropsDir === join(R, "zoom-crops"), cfg.zoomCropsDir);
    ok("(1i) sourceDir = <results>/source", cfg.sourceDir === join(R, "source"), cfg.sourceDir);
    ok("(1j) origAnnotationsDir = <results>/orig-annotations", cfg.origAnnotationsDir === join(R, "orig-annotations"), cfg.origAnnotationsDir);
    ok("(1k) no historyDir → candidatesFile null", cfg.candidatesFile === null);
    ok("(1l) no historyDir → ledgerRatingsFile null", cfg.ledgerRatingsFile === null);
    ok("(1m) historyDir null", cfg.historyDir === null);
    ok("(1n) filterSlides default null", cfg.filterSlides === null);
    ok("(1o) candidateMode default false", cfg.candidateMode === false);
    // every resolved path must be absolute
    const paths = [cfg.resultsDir, cfg.slidesDir, cfg.originalsDir, cfg.ratingsFile, cfg.manifestFile,
      cfg.metaFile, cfg.renderParamsFile, cfg.annotationsDir, cfg.zoomCropsDir, cfg.sourceDir, cfg.origAnnotationsDir];
    ok("(1p) all resolved rating paths are absolute", paths.every((p) => isAbsolute(p)));
  }

  // historyDir set → ledger paths populated
  {
    const H = resolve("/tmp/hist-x");
    const cfg = resolveRatingIo({ resultsDir: "/tmp/results-y", historyDir: "/tmp/hist-x" });
    ok("(2a) historyDir resolved absolute", cfg.historyDir === H);
    ok("(2b) candidatesFile = <hist>/candidates.json", cfg.candidatesFile === join(H, "candidates.json"), String(cfg.candidatesFile));
    ok("(2c) ledgerRatingsFile = <hist>/ratings.json", cfg.ledgerRatingsFile === join(H, "ratings.json"), String(cfg.ledgerRatingsFile));
  }

  // explicit null historyDir → both null
  {
    const cfg = resolveRatingIo({ resultsDir: "/tmp/results-z", historyDir: null });
    ok("(3) historyDir null → both ledger files null", cfg.historyDir === null && cfg.candidatesFile === null && cfg.ledgerRatingsFile === null);
  }

  // slidesDir / originalsDir overrides honored (resolved absolute)
  {
    const cfg = resolveRatingIo({ resultsDir: "/tmp/results-q", slidesDir: "/custom/slides", originalsDir: "/custom/orig" });
    ok("(4a) slidesDir override honored (absolute)", cfg.slidesDir === resolve("/custom/slides"), cfg.slidesDir);
    ok("(4b) originalsDir override honored (absolute)", cfg.originalsDir === resolve("/custom/orig"), cfg.originalsDir);
  }

  // filterSlides + candidateMode passthrough
  {
    const cfg = resolveRatingIo({ resultsDir: "/tmp/results-f", filterSlides: ["slide_01", "slide_02"], candidateMode: true });
    ok("(5a) filterSlides passthrough", JSON.stringify(cfg.filterSlides) === '["slide_01","slide_02"]');
    ok("(5b) candidateMode passthrough", cfg.candidateMode === true);
  }

  // -------------------------------------------------------------------------
  // resolveRecordIo
  // -------------------------------------------------------------------------
  {
    const O = resolve("/tmp/out-x");
    const cfg = resolveRecordIo({ fixturesDir: "/fx", slides: ["slide_01"], outDir: "/tmp/out-x" });
    ok("(6a) outDir resolved absolute", cfg.outDir === O);
    ok("(6b) pptxDir = <out>/pptx", cfg.pptxDir === join(O, "pptx"), cfg.pptxDir);
    ok("(6c) screenshotsDir = <out>/screenshots", cfg.screenshotsDir === join(O, "screenshots"), cfg.screenshotsDir);
    ok("(6d) thumbsDir = <out>/thumbs", cfg.thumbsDir === join(O, "thumbs"), cfg.thumbsDir);
    ok("(6e) manifestFile = <out>/thumbs/manifest.json", cfg.manifestFile === join(O, "thumbs", "manifest.json"), cfg.manifestFile);
    ok("(6f) fixturesDir resolved absolute", cfg.fixturesDir === resolve("/fx"));
    ok("(6g) slides passthrough", JSON.stringify(cfg.slides) === '["slide_01"]');
    ok("(6h) mode default 'full'", cfg.mode === "full");
    ok("(6i) title default present", typeof cfg.title === "string" && cfg.title.length > 0, cfg.title);
    ok("(6j) all record paths absolute", [cfg.outDir, cfg.pptxDir, cfg.screenshotsDir, cfg.thumbsDir, cfg.manifestFile, cfg.fixturesDir].every(isAbsolute));
  }

  // mode + title passthrough
  {
    const cfg = resolveRecordIo({ fixturesDir: "/fx", slides: ["a", "b"], outDir: "/tmp/o", mode: "pptx", title: "my-title" });
    ok("(7a) mode passthrough", cfg.mode === "pptx");
    ok("(7b) title passthrough", cfg.title === "my-title");
  }

  // -------------------------------------------------------------------------
  // describeRatingIo
  // -------------------------------------------------------------------------
  {
    const cfg = resolveRatingIo({ resultsDir: "/tmp/desc-x" });
    const s = describeRatingIo(cfg);
    ok("(8a) describeRatingIo has IN group", s.includes("IN "));
    ok("(8b) describeRatingIo has OUT group", s.includes("OUT "));
    ok("(8c) describeRatingIo has LEDGER group", s.includes("LEDGER"));
    ok("(8d) ratingsFile path appears under OUT", s.includes(`OUT    verdicts`) && s.includes(cfg.ratingsFile), cfg.ratingsFile);
    ok("(8e) candidates '(none …)' when no historyDir", s.includes("LEDGER candidates") && s.includes("(none"));
  }

  // describeRatingIo with historyDir → real candidate path printed
  {
    const cfg = resolveRatingIo({ resultsDir: "/tmp/desc-h", historyDir: "/tmp/hist-h" });
    const s = describeRatingIo(cfg);
    ok("(9) describeRatingIo prints resolved candidatesFile with historyDir", s.includes(cfg.candidatesFile as string) && !s.includes("LEDGER candidates              (none"), s);
  }

  // -------------------------------------------------------------------------
  // describeRecordIo
  // -------------------------------------------------------------------------
  {
    const cfg = resolveRecordIo({ fixturesDir: "/fx", slides: ["slide_01"], outDir: "/tmp/rdesc" });
    const s = describeRecordIo(cfg);
    ok("(10a) describeRecordIo has IN group", s.includes("IN "));
    ok("(10b) describeRecordIo has OUT group", s.includes("OUT "));
    ok("(10c) describeRecordIo prints pptxDir under OUT", s.includes("OUT  pptx") && s.includes(cfg.pptxDir), cfg.pptxDir);
    ok("(10d) describeRecordIo prints manifestFile", s.includes(cfg.manifestFile));
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exit(1);
}
main();

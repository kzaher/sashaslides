/**
 * sxs-io.test.ts — the documented I/O contract resolvers + describers.
 *
 * resolveRatingIo turns a partial input into fully-defaulted, absolute paths;
 * describeRatingIo prints the IN/OUT/LEDGER
 * groups. Pure functions, no fs/network — just assertions on the returned paths.
 */
import { resolveRatingIo, describeRatingIo } from "./sxs-io.js";
import { join, resolve, isAbsolute } from "path";
import { ok, summary } from "./test-harness.js";


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

  // --ratings-file override reaches the contract (and the describer)
  {
    const cfg = resolveRatingIo({ resultsDir: "/tmp/desc-r", ratingsFile: "/tmp/elsewhere/ratings.json" });
    ok("(10) ratingsFile override resolved + printed", cfg.ratingsFile === resolve("/tmp/elsewhere/ratings.json") && describeRatingIo(cfg).includes(cfg.ratingsFile), cfg.ratingsFile);
  }

  summary();
}
main();

/**
 * sxs-io.ts — THE authoritative, documented I/O contract for the SxS render +
 * rating pipeline.
 *
 * Motivation: the scripts used to take "just an --out dir" and then implicitly
 * read/write a dozen files inside it by convention. Nobody could tell, from a
 * call site, which files were INPUTS (the script expects them to already exist),
 * which were OUTPUTS (the script produces them), and where each one lives. This
 * module makes every path explicit and typed, with defaults derived from a
 * single root, and a `describe*()` helper so a script can print its own
 * interface on boot.
 *
 * RatingIoConfig: `rating-server.ts` shows original-vs-test and records good/bad
 * verdicts; `rating-gate.ts` blocks on its output. (record-rendering-lib.ts lays
 * out its own output directory and logs it.)
 *
 * Path roles are annotated inline as [IN] (read), [OUT] (written), or
 * [LEDGER] (persistent, shared across runs).
 */
import { join, resolve } from "path";

// ===========================================================================
// rating-server.ts  —  original-vs-test review  →  good/bad verdicts
// ===========================================================================

/** Fully-resolved I/O contract for `rating-server.ts` + `rating-gate.ts`. Build
 *  with {@link resolveRatingIo}. The server READS the [IN] paths (produced by
 *  record-rendering + the harness), WRITES the [OUT] paths as you rate, and
 *  mirrors verdicts into the [LEDGER] paths that survive across runs. */
export interface RatingIoConfig {
  /** root results dir (the old bare positional arg). Typically
   *  a fork's `<shared>/forward/thumbnails`. Defaults for every path below hang off it. */
  resultsDir: string;

  // ---- INPUTS (the server expects these to already exist) ----
  /** [IN] rendered "test"/attempt PNGs → `<slidesDir>/<slide_id>.png`.
   *  Default `<resultsDir>/slides`. This is `record-rendering`'s thumbs output. */
  slidesDir: string;
  /** [IN] target "original" PNGs → `<originalsDir>/<slide_id>.png`.
   *  Default `<resultsDir>/originals`. */
  originalsDir: string;
  /** [IN] Slides upload provenance `{ presentation_id }` →
   *  `<resultsDir>/thumbs/manifest.json` (same file record-rendering wrote). */
  manifestFile: string;
  /** [IN] per-slide round-1 provenance (source html, presentation url, original
   *  comment + annotation) → `<resultsDir>/sxs-meta.json`. See writeSxsMeta. */
  metaFile: string;
  /** [IN] render-parameter badge `{ tablesFormat, renderParams }` →
   *  `<resultsDir>/meta.json`. Optional. */
  renderParamsFile: string;
  /** [IN] copied source fixtures → `<resultsDir>/source/<slide_id>.html`
   *  (served via /html). */
  sourceDir: string;
  /** [IN] copied original annotation PNGs →
   *  `<resultsDir>/orig-annotations/<slide_id>.png`. */
  origAnnotationsDir: string;
  /** [IN] optional filter: only review these slide ids. */
  filterSlides: string[] | null;

  // ---- OUTPUTS (the server writes these as you rate) ----
  /** [OUT] per-slide verdicts → `<resultsDir>/ratings.json`
   *  = `{ <slide_id>: { status: "good"|"bad"|"pending", comment?, annotation? } }`.
   *  THIS is the file `rating-gate.ts` blocks on. */
  ratingsFile: string;
  /** [OUT] user-drawn annotation PNGs (this run) →
   *  `<resultsDir>/annotations/<slide_id>.png`. */
  annotationsDir: string;
  /** [OUT] per-annotation original/test zoom crops →
   *  `<resultsDir>/zoom-crops/<slide_id>-*.png`. */
  zoomCropsDir: string;

  // ---- LEDGER (persistent, shared across runs) ----
  /** [LEDGER] persistent ledger root (`--history-dir`). null = ephemeral run
   *  with no cross-run mirroring. When set, verdicts mirror to
   *  `<historyDir>/candidates.json` (green/red for bug_solving) and
   *  `<historyDir>/ratings.json` (canonical per-slide issue), and annotations to
   *  `<historyDir>/annotations/<slide_id>.png`. */
  historyDir: string | null;
  /** [LEDGER] candidate green/red ledger → `<historyDir>/candidates.json`
   *  (null when historyDir is null). */
  candidatesFile: string | null;
  /** [LEDGER] canonical per-slide issue ledger → `<historyDir>/ratings.json`. */
  ledgerRatingsFile: string | null;

  /** candidate mode: this server rates an UNMERGED fix attempt, so it writes
   *  candidates.json but leaves the canonical issue in ratings.json untouched. */
  candidateMode: boolean;
}

export interface RatingIoInput {
  resultsDir: string;
  slidesDir?: string;
  originalsDir?: string;
  filterSlides?: string[] | null;
  historyDir?: string | null;
  candidateMode?: boolean;
  /** the verdicts file, when not `<resultsDir>/ratings.json` (rating-server --ratings-file). */
  ratingsFile?: string;
}

/** Resolve a partial rating config to absolute, fully-defaulted paths. */
export function resolveRatingIo(inp: RatingIoInput): RatingIoConfig {
  const resultsDir = resolve(inp.resultsDir);
  const historyDir = inp.historyDir ? resolve(inp.historyDir) : null;
  return {
    resultsDir,
    slidesDir: inp.slidesDir ? resolve(inp.slidesDir) : join(resultsDir, "slides"),
    originalsDir: inp.originalsDir ? resolve(inp.originalsDir) : join(resultsDir, "originals"),
    manifestFile: join(resultsDir, "thumbs", "manifest.json"),
    metaFile: join(resultsDir, "sxs-meta.json"),
    renderParamsFile: join(resultsDir, "meta.json"),
    sourceDir: join(resultsDir, "source"),
    origAnnotationsDir: join(resultsDir, "orig-annotations"),
    filterSlides: inp.filterSlides ?? null,
    ratingsFile: inp.ratingsFile ? resolve(inp.ratingsFile) : join(resultsDir, "ratings.json"),
    annotationsDir: join(resultsDir, "annotations"),
    zoomCropsDir: join(resultsDir, "zoom-crops"),
    historyDir,
    candidatesFile: historyDir ? join(historyDir, "candidates.json") : null,
    ledgerRatingsFile: historyDir ? join(historyDir, "ratings.json") : null,
    candidateMode: inp.candidateMode ?? false,
  };
}

// ===========================================================================
// Human-readable interface summaries (printed by each script on boot)
// ===========================================================================

/** One line per path, grouped IN / OUT / LEDGER, so a script can print exactly
 *  what it reads and writes and where. */
export function describeRatingIo(cfg: RatingIoConfig): string {
  const lines = [
    `SxS rating I/O contract (resultsDir = ${cfg.resultsDir})`,
    `  IN     slides (test PNGs)      ${cfg.slidesDir}/<id>.png`,
    `  IN     originals (target PNGs) ${cfg.originalsDir}/<id>.png`,
    `  IN     upload manifest         ${cfg.manifestFile}`,
    `  IN     round-1 provenance      ${cfg.metaFile}`,
    `  IN     render-param badge      ${cfg.renderParamsFile}`,
    `  IN     source fixtures         ${cfg.sourceDir}/<id>.html`,
    `  IN     original annotations    ${cfg.origAnnotationsDir}/<id>.png`,
    `  IN     filter                  ${cfg.filterSlides ? cfg.filterSlides.join(",") : "(all slides)"}`,
    `  OUT    verdicts                ${cfg.ratingsFile}`,
    `  OUT    drawn annotations       ${cfg.annotationsDir}/<id>.png`,
    `  OUT    zoom crops              ${cfg.zoomCropsDir}/<id>-*.png`,
    `  LEDGER candidates              ${cfg.candidatesFile ?? "(none — no --history-dir)"}`,
    `  LEDGER canonical ratings       ${cfg.ledgerRatingsFile ?? "(none — no --history-dir)"}`,
    `  mode   ${cfg.candidateMode ? "candidate (unmerged attempt; canonical issue untouched)" : "canonical (updates the issue ledger)"}`,
  ];
  return lines.join("\n");
}

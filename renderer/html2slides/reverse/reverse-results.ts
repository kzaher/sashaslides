/**
 * Where a reverse run puts every file, and the shapes of the JSON it writes: one directory per set,
 * laid out like the forward SxS results the rating server already reads (originals/, slides/,
 * diffs/, ratings.json, meta.json), so the same UI rates the reverse direction.
 *
 * IN REVERSE MODE THE ROLES SWAP: `originals/` holds GOOGLE'S THUMBNAIL (what the importer was
 * given to reproduce) and `slides/` holds the SASHA EXPORT'S SCREENSHOT (what it produced).
 * `round-trip/` is a second, complete results directory for the whole trip: `originals/` there is
 * the fixture HTML's screenshot and `slides/` the same Sasha screenshot.
 *
 * GOLDENS: `meta.json` names a goldens directory of its own (`e2e/goldens-reverse-<set>`,
 * `e2e/goldens-roundtrip-<set>`). The rating server falls back to the sibling of `htmlDir`
 * (`e2e/goldens`, the FORWARD goldens) when `goldensDir` is absent, so it must always be present:
 * otherwise one "Good" click would overwrite a forward golden with a Sasha screenshot. Only that
 * click ever writes there; this pipeline never does.
 */
import { join } from "node:path";

export type ReverseSet = "basic" | "complex" | "deck";

export const ALL_SETS: readonly ReverseSet[] = ["basic", "complex", "deck"];

export type SetLayout = Readonly<{
  root: string;
  /** Google's thumbnails (the reverse step's expected side). */
  originals: string;
  /** Screenshots of the Sasha export (the actual side of both comparisons). */
  slides: string;
  diffs: string;
  /** The exported Sasha pages, one self-contained HTML document per slide. */
  html: string;
  /** The imported document and the import's losses, for debugging a slide. */
  importDirectory: string;
  roundTrip: SetRoundTripLayout;
  metaPath: string;
  metricsPath: string;
  ratingsPath: string;
  statePath: string;
}>;

export type SetRoundTripLayout = Readonly<{
  root: string;
  /** Screenshots of the original fixture HTML. */
  originals: string;
  /** Copies of the Sasha screenshots, so this directory is complete on its own. */
  slides: string;
  diffs: string;
  metaPath: string;
  ratingsPath: string;
  /** The fixture pages' `innerText`, cached with their screenshots. */
  fixtureTextPath: string;
}>;

/** One row of metrics.json (the shared interface): one slide of one set. */
export type SlideMetrics = Readonly<{
  caseId: string;
  set: ReverseSet;
  /** 1-based, the slide's position in the presentation and its `slide_NN` file name. */
  slideNumber: number;
  /** Sasha screenshot against Google's thumbnail, percent of pixels (reverse-metrics.ts). */
  reverseMismatchPercent: number | null;
  /** Sasha screenshot against the fixture's screenshot; null for the deck, which has no fixture. */
  roundTripMismatchPercent: number | null;
  /** Word match of the Sasha page's text against Google's text runs, 0 to 1. */
  textMatch: number | null;
  notes: string;
  /** Context, not part of the shared interface: Google's thumbnail against the fixture (the forward step alone). */
  forwardMismatchPercent: number | null;
  /** Word match of the Sasha page's text against the fixture page's text. */
  roundTripTextMatch: number | null;
  googleSlideObjectId: string;
  /**
   * The screenshot file id (`slide_NN`) this row describes. The rating server matches a row to its
   * screenshot by this alone when present; without it, a case id such as complex's `slide_17` also
   * fits basic's `slide_17.png`, and the server once showed complex's 95 % row on basic's slide.
   */
  slideId: string;
  /** With `slideObjectId`, lets the rating UI deep-link the Google pane to the slide it shows. */
  presentationId: string;
  slideObjectId: string;
}>;

/** What makes a run resumable: the presentation a set was measured on and what is already fetched. */
export type SetState = Readonly<{
  presentationId: string;
  /** How the presentation was obtained: this pipeline's own forward upload, a forward run's record, or given. */
  source: "forwardUpload" | "recordedForwardRun" | "given" | "testDeck";
  /** Thumbnail files already downloaded for `presentationId`. */
  thumbnails: readonly string[];
}>;

export function setLayoutOf(options: Readonly<{ outputRoot: string; set: ReverseSet }>): SetLayout {
  const root = join(options.outputRoot, options.set);
  const roundTripRoot = join(root, "round-trip");
  return {
    root,
    originals: join(root, "originals"),
    slides: join(root, "slides"),
    diffs: join(root, "diffs"),
    html: join(root, "html"),
    importDirectory: join(root, "import"),
    roundTrip: {
      root: roundTripRoot,
      originals: join(roundTripRoot, "originals"),
      slides: join(roundTripRoot, "slides"),
      diffs: join(roundTripRoot, "diffs"),
      metaPath: join(roundTripRoot, "meta.json"),
      ratingsPath: join(roundTripRoot, "ratings.json"),
      fixtureTextPath: join(roundTripRoot, "fixture-text.json"),
    },
    metaPath: join(root, "meta.json"),
    metricsPath: join(root, "metrics.json"),
    ratingsPath: join(root, "ratings.json"),
    statePath: join(root, "state.json"),
  };
}

/** `slide_07` for slide 7: the id the rating server and both results directories share. */
export function slideFileId(slideNumber: number): string {
  return `slide_${String(slideNumber).padStart(2, "0")}`;
}

export function reverseGoldensDirectory(options: Readonly<{ converterDirectory: string; set: ReverseSet }>): string {
  return join(options.converterDirectory, "e2e", `goldens-reverse-${options.set}`);
}

export function roundTripGoldensDirectory(options: Readonly<{ converterDirectory: string; set: ReverseSet }>): string {
  return join(options.converterDirectory, "e2e", `goldens-roundtrip-${options.set}`);
}

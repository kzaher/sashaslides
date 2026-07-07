/**
 * regression-gate.ts — the dual-class regression gate for the bug_solving merge.
 *
 * After the LLM folds every GREEN cluster into one accepted working tree
 * (llm-merge.ts), THIS gate decides whether the fold is acceptable by rendering
 * the deck in the merge workspace and comparing each slide against the right
 * reference, using the 3× stability classification (stability.ts) to pick the
 * strictness:
 *
 *   GREEN slides (the targeted, user-approved fixes) — compared vs their LGTM'd
 *   (user-approved) render:
 *     · pixelPerfect class → `pixelIdentical`      (identical pixels required)
 *     · everything else    → `xmlPlusRenderedParts`(xml identical + rendered
 *                             parts pixel-perfect; free raster wobble allowed)
 *
 *   NON-TARGETED slides (everything else in the deck) — compared vs the ACCEPTED
 *   base (the versions OUTSIDE the newly-green set). Any change is a ripple.
 *
 * SERIAL TARGET-MUTATION: during the sequential fold each accepted fork MUTATES
 * the target it touched — that slide becomes the new accepted (green) state. The
 * gate never bakes in "base = pristine": the caller supplies the accepted base,
 * and `makeRegressionRetest` advances that base after every clean fork so a later
 * fork is compared against the POST-previous-fork state (an earlier fork's
 * accepted change is NOT re-flagged as this fork's ripple).
 *
 * `regressionGate` is a PURE, SYNCHRONOUS function over injected record seams
 * (only the rendering is mocked in tests). `makeRegressionRetest` wraps it as the
 * `MergeOps.retest(ws, intendedSlides) → {changed}` seam llm-merge drives.
 */
import type { CowWorkspace } from "../../../cow-workspace/cow-workspace.js";
import {
  type RenderRecord,
  type StabilityClassification,
  pixelKey,
  xmlKey,
  renderedPartsKey,
  classifiedSlides,
} from "./stability.js";

// ---------------------------------------------------------------------------
// The two GREEN comparison functions + the NON-TARGETED comparison
// ---------------------------------------------------------------------------

/** pixel-perfect class: the rendered PIXELS must be byte-identical. */
export function pixelIdentical(a: RenderRecord, b: RenderRecord): boolean {
  const ka = pixelKey(a), kb = pixelKey(b);
  return ka != null && kb != null && ka === kb;
}

/**
 * xml-stable class: the slide XML must be identical AND the rendered parts (the
 * rough.js overlay images) must be pixel-perfect. A whole-slide pixel diff
 * OUTSIDE the rendered parts (Google raster wobble) is allowed. When neither
 * side carries a rendered-parts key we fall back to XML-only equality (still
 * honouring "a non-rendered pixel may differ").
 */
export function xmlPlusRenderedParts(a: RenderRecord, b: RenderRecord): boolean {
  const xa = xmlKey(a), xb = xmlKey(b);
  if (xa == null || xb == null || xa !== xb) return false;
  const ra = renderedPartsKey(a), rb = renderedPartsKey(b);
  if (ra != null && rb != null) return ra === rb;
  return true; // xml identical, no rendered-parts to check → accept
}

/**
 * NON-TARGETED "must not change": compare on the STRONGEST representation both
 * records share (pixels beat xml). Missing-on-both or incomparable → treated as
 * CHANGED (conservative: a gate can't prove "unchanged" without evidence).
 */
export function unchanged(a: RenderRecord, b: RenderRecord): boolean {
  const pa = pixelKey(a), pb = pixelKey(b);
  if (pa != null && pb != null) return pa === pb;
  const xa = xmlKey(a), xb = xmlKey(b);
  if (xa != null && xb != null) return xa === xb;
  return false;
}

// ---------------------------------------------------------------------------
// regressionGate — pure, synchronous
// ---------------------------------------------------------------------------

export interface GateViolation {
  slide: string;
  kind: "green-pixel" | "green-xml-parts" | "ripple";
  detail: string;
}

export interface GateResult {
  ok: boolean;
  /** the ripple set fed to llm-merge's fallback trigger (non-targeted changes +
   *  the GREEN_REGRESSION sentinel when any green slide violated its class). */
  changed: string[];
  violations: GateViolation[];
}

/**
 * A GREEN-class violation is on an INTENDED slide, so it can't express itself as
 * a ripple via llm-merge's `changed - intended` filter. We surface it with this
 * reserved, never-intended id in `changed` so a green regression still forces the
 * all-at-once → sequential fallback (and, in the sequential fold, a rollback +
 * demote). The real offending slide ids ride alongside it for logging.
 */
export const GREEN_REGRESSION_SENTINEL = "__green_regression__";

export interface RegressionGateArgs {
  /** reference render for a NON-TARGETED slide (the accepted / base state). */
  base: (slideId: string) => RenderRecord;
  /** the slides this fold targets (their changes are intended). */
  greenSlides: string[];
  /** the 3× stability classification (picks pixel vs xml+parts per green slide).
   *  Its union also defines the NON-TARGETED universe. */
  stability: StabilityClassification;
  /** reference render for a GREEN slide (the user-approved / LGTM'd version). */
  lgtm: (slideId: string) => RenderRecord;
  /** CURRENT render of a slide in the merge workspace. */
  record: (slideId: string) => RenderRecord;
  /** the merge workspace (documentary — the real `record` renders from it). */
  mergeWs?: CowWorkspace;
}

export function regressionGate(args: RegressionGateArgs): GateResult {
  const pixelPerfect = new Set(args.stability.pixelPerfect);
  const green = new Set(args.greenSlides);
  const violations: GateViolation[] = [];
  const changed: string[] = [];

  // GREEN slides: compare CURRENT vs LGTM, strictness by stability class.
  for (const sid of args.greenSlides) {
    const cur = args.record(sid);
    const ref = args.lgtm(sid);
    if (pixelPerfect.has(sid)) {
      if (!pixelIdentical(cur, ref)) {
        violations.push({ slide: sid, kind: "green-pixel", detail: `pixel-perfect green slide differs from LGTM render (pixels not identical)` });
      }
    } else {
      if (!xmlPlusRenderedParts(cur, ref)) {
        violations.push({ slide: sid, kind: "green-xml-parts", detail: `xml-stable green slide differs from LGTM (xml or rendered-parts changed)` });
      }
    }
  }

  // NON-TARGETED slides: must be UNCHANGED vs the accepted base. The universe is
  // the whole classified deck minus the green set. CLASS-AWARE (mirrors the green
  // comparison): a pixel-perfect slide must be pixel-identical vs the accepted
  // base; an xml-stable (or unstable) slide need only match on xml + rendered-
  // parts — its raw pixels wobble run-to-run, so a blind pixel compare would
  // FALSELY ripple it (this is the xml serial-mutation case).
  for (const sid of classifiedSlides(args.stability)) {
    if (green.has(sid)) continue;
    const cur = args.record(sid);
    const ref = args.base(sid);
    // Identical pixels ALWAYS prove "unchanged". A pixel-perfect slide requires
    // that. An xml-stable slide, whose pixels wobble run-to-run, is ALSO unchanged
    // if its xml + rendered-parts match (so wobble alone doesn't ripple it).
    const same = pixelPerfect.has(sid)
      ? pixelIdentical(cur, ref)
      : (pixelIdentical(cur, ref) || xmlPlusRenderedParts(cur, ref));
    if (!same) {
      violations.push({ slide: sid, kind: "ripple", detail: `non-targeted ${pixelPerfect.has(sid) ? "pixel-perfect" : "xml-stable"} slide changed vs accepted base (ripple)` });
      changed.push(sid);
    }
  }

  if (violations.some((v) => v.kind !== "ripple")) changed.push(GREEN_REGRESSION_SENTINEL);

  return {
    ok: violations.length === 0,
    changed: [...new Set(changed)].sort(),
    violations,
  };
}

// ---------------------------------------------------------------------------
// makeRegressionRetest — the stateful MergeOps.retest adapter
// ---------------------------------------------------------------------------

export interface RegressionRetestDeps {
  /** load the stability classification for THIS retest (re-read per call so a
   *  freshly-written stability.json is picked up). */
  loadStability: () => StabilityClassification;
  /** render the merge workspace's CURRENT deck once and return a per-slide
   *  lookup (avoids re-rendering per slide inside the gate). */
  renderMergeDeck: (ws: CowWorkspace) => (slideId: string) => RenderRecord;
  /** reference render for a NON-TARGETED slide (pre-merge base). Memoized here. */
  baseRecord: (slideId: string) => RenderRecord;
  /** reference render for a GREEN slide (LGTM / pre-merge fallback). */
  lgtmRecord: (slideId: string) => RenderRecord;
  log?: (msg: string) => void;
}

/**
 * Wrap `regressionGate` as the synchronous `retest(ws, intendedSlides) →
 * {changed}` seam. Holds the ACCEPTED-BASE across calls: after any CLEAN fork
 * (ok, no violation) it advances the base for that fork's intended slides to
 * their current render — so the NEXT fork in the sequential fold is compared
 * against the post-previous-fork state (serial target-mutation). A rippling
 * fork's writes are rolled back by llm-merge before the next retest, so its base
 * is deliberately NOT advanced.
 */
export function makeRegressionRetest(deps: RegressionRetestDeps): (ws: CowWorkspace, intendedSlides: string[]) => { changed: string[] } {
  const acceptedBase = new Map<string, RenderRecord>();
  const base = (sid: string): RenderRecord => {
    if (!acceptedBase.has(sid)) acceptedBase.set(sid, deps.baseRecord(sid));
    return acceptedBase.get(sid)!;
  };

  return (ws, intendedSlides) => {
    const stability = deps.loadStability();
    const lookup = deps.renderMergeDeck(ws);
    const res = regressionGate({
      base,
      greenSlides: intendedSlides,
      stability,
      lgtm: deps.lgtmRecord,
      record: lookup,
      mergeWs: ws,
    });
    if (deps.log) {
      deps.log(
        `[regression-gate] intended=[${intendedSlides.join(",")}] ok=${res.ok} ` +
          `changed=[${res.changed.join(",")}] violations=${res.violations.length}` +
          (res.violations.length ? ` (${res.violations.map((v) => `${v.slide}:${v.kind}`).join("; ")})` : ""),
      );
    }
    // Advance the accepted base only for a CLEAN fold — this fork's targets are
    // now the green state subsequent forks must preserve.
    if (res.ok) for (const sid of intendedSlides) acceptedBase.set(sid, lookup(sid));
    return { changed: res.changed };
  };
}

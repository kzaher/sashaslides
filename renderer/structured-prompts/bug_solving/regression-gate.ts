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
 * (only the rendering is mocked in tests). `makeChangeGate` wraps it into the
 * `detect` / `commitAccepted` pair llm-merge drives: the gate no longer
 * auto-accepts/rejects — it reports the CHANGED slides, a HUMAN rates them
 * (llm-merge's `rateChanged`), and an accepted-green slide's render becomes its
 * new reference. See docs/merge-flow.drawio for the full state machine.
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

/**
 * Something the gate flagged about a slide's fold. There are no "violations" —
 * either a green slide KEEPS its stability or it doesn't, and a non-targeted slide
 * may ripple:
 *   · "binary-unstable"       — a pixel-perfect green slide did not keep BINARY
 *                               stability (pixels not identical to its LGTM).
 *   · "xml-rendered-unstable" — an xml-stable green slide did not keep XML+RENDERED
 *                               stability (xml or rendered-parts changed vs LGTM).
 *   · "ripple"                — a NON-TARGETED slide changed vs the accepted base.
 */
export interface GateFinding {
  slide: string;
  kind: "binary-unstable" | "xml-rendered-unstable" | "ripple";
  detail: string;
}

export interface GateResult {
  ok: boolean;
  /** the ripple set fed to llm-merge's fallback trigger (non-targeted changes +
   *  the GREEN_INSTABILITY sentinel when any green slide didn't keep its class'
   *  stability). */
  changed: string[];
  findings: GateFinding[];
}

/**
 * A green slide that didn't keep its stability is on an INTENDED slide, so it
 * can't express itself as a ripple via llm-merge's `changed - intended` filter.
 * We surface it with this reserved, never-intended id in `changed` so a green
 * instability still forces the all-at-once → sequential fallback (and, in the
 * sequential fold, a rollback + demote). The real slide ids ride alongside it for
 * logging.
 */
export const GREEN_INSTABILITY_SENTINEL = "__green_unstable__";

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
  const findings: GateFinding[] = [];
  const changed: string[] = [];

  // GREEN slides: did each KEEP its stability vs LGTM? strictness by class.
  for (const sid of args.greenSlides) {
    const cur = args.record(sid);
    const ref = args.lgtm(sid);
    if (pixelPerfect.has(sid)) {
      if (!pixelIdentical(cur, ref)) {
        findings.push({ slide: sid, kind: "binary-unstable", detail: `pixel-perfect green slide did not keep binary stability (pixels not identical to LGTM)` });
      }
    } else {
      if (!xmlPlusRenderedParts(cur, ref)) {
        findings.push({ slide: sid, kind: "xml-rendered-unstable", detail: `xml-stable green slide did not keep xml+rendered stability (xml or rendered-parts changed vs LGTM)` });
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
      findings.push({ slide: sid, kind: "ripple", detail: `non-targeted ${pixelPerfect.has(sid) ? "pixel-perfect" : "xml-stable"} slide changed vs accepted base (ripple)` });
      changed.push(sid);
    }
  }

  // Any green slide that didn't keep its stability → raise the sentinel.
  if (findings.some((f) => f.kind !== "ripple")) changed.push(GREEN_INSTABILITY_SENTINEL);

  return {
    ok: findings.length === 0,
    changed: [...new Set(changed)].sort(),
    findings,
  };
}

// ---------------------------------------------------------------------------
// makeChangeGate — stateful adapter: DETECT changed slides + COMMIT accepted ones
// ---------------------------------------------------------------------------

export interface ChangeGateDeps {
  /** load the stability classification for THIS detect (re-read per call so a
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

/** Which slides a merge changes relative to their approved reference, and the
 *  per-slide findings behind it (for logging / the rating UI). */
export interface ChangeDetection {
  /** the real slide ids that DIFFER from their approved reference (green slides
   *  vs their LGTM, non-targeted vs base) — the set to show the human. */
  changedSlides: string[];
  findings: GateFinding[];
}

/**
 * The merge no longer AUTO-passes/fails on the gate: it surfaces the changed
 * slides to a HUMAN (llm-merge's `rateChanged`). `makeChangeGate` wraps
 * `regressionGate` with the mutable reference the flow needs:
 *   · `detect(ws, intendedSlides)` renders the workspace deck and returns the
 *     slides that differ from their current reference (approved-LGTM for a green
 *     slide, base for a non-targeted one) — exactly the slides to rate.
 *   · `commitAccepted(slides)` advances BOTH references for the human-GREENED
 *     slides to their render in the last `detect` — the "new green". So a later
 *     fold that doesn't touch them sees them as unchanged (not re-rated), and a
 *     later fold that REGRESSES a newly-green slide re-surfaces it for rating.
 * A rejected fork's writes are rolled back by llm-merge before the next detect,
 * and `commitAccepted` is NOT called for it, so its reference is unchanged.
 */
export interface ChangeGate {
  detect(ws: CowWorkspace, intendedSlides: string[]): ChangeDetection;
  commitAccepted(slides: string[]): void;
}

export function makeChangeGate(deps: ChangeGateDeps): ChangeGate {
  const acceptedBase = new Map<string, RenderRecord>();
  const acceptedLgtm = new Map<string, RenderRecord>();
  const base = (sid: string): RenderRecord => {
    if (!acceptedBase.has(sid)) acceptedBase.set(sid, deps.baseRecord(sid));
    return acceptedBase.get(sid)!;
  };
  const lgtm = (sid: string): RenderRecord => {
    if (!acceptedLgtm.has(sid)) acceptedLgtm.set(sid, deps.lgtmRecord(sid));
    return acceptedLgtm.get(sid)!;
  };
  let lastRender: ((sid: string) => RenderRecord) | null = null;

  return {
    detect(ws, intendedSlides) {
      const stability = deps.loadStability();
      const lookup = deps.renderMergeDeck(ws);
      lastRender = lookup;
      const res = regressionGate({ base, greenSlides: intendedSlides, stability, lgtm, record: lookup, mergeWs: ws });
      const changedSlides = [...new Set(res.findings.map((f) => f.slide))].sort();
      deps.log?.(
        `[change-gate] intended=[${intendedSlides.join(",")}] changed=[${changedSlides.join(",")}] ` +
          `findings=${res.findings.length}` +
          (res.findings.length ? ` (${res.findings.map((f) => `${f.slide}:${f.kind}`).join("; ")})` : ""),
      );
      return { changedSlides, findings: res.findings };
    },
    commitAccepted(slides) {
      if (!lastRender) return;
      for (const sid of slides) {
        const rec = lastRender(sid);
        acceptedBase.set(sid, rec);
        acceptedLgtm.set(sid, rec);
      }
    },
  };
}

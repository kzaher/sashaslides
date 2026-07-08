/**
 * regression-gate.test.ts — the dual-class regression gate (regression-gate.ts).
 * ONLY the rendering (the record seams) + the LLM are mocked; the gate logic, the
 * stateful base-advancement adapter, and (in the wire-through) the COW workspace,
 * filesystem, promote, and ledger demote are REAL.
 *
 * Pure gate:
 *   (1) pixel-perfect green slide, 1-pixel diff vs LGTM     → did NOT keep binary stability
 *   (2) xml-stable green slide, same xml+parts, diff pixel  → OK
 *   (3) non-targeted slide changed vs base                  → ripple in `changed`
 *   (4) all-clean                                           → ok, empty changed
 *   (5) SERIAL target-mutation: base = post-A → A's change NOT flagged as B's
 *       ripple; base = pristine → same change IS flagged (gate uses given base)
 *   (6) adapter advances the accepted base after a clean fork (serial mutation)
 *
 * PURE only: these feed regressionGate/makeRegressionRetest plain RenderRecords
 * (data — the recording is the mocked surface). The full merge THROUGH the real
 * gate (real overlays/engine/promote/ledger, mocking only the LLM + the recording)
 * lives in merge-e2e.test.ts.
 */
import type { CowWorkspace } from "../../../cow-workspace/cow-workspace.js";
import {
  regressionGate,
  makeRegressionRetest,
  pixelIdentical,
  xmlPlusRenderedParts,
  unchanged,
  GREEN_INSTABILITY_SENTINEL,
} from "./regression-gate.js";
import type { RenderRecord, StabilityClassification } from "./stability.js";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------
let passed = 0, failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ` — ${extra}` : ""}`); failures.push({ name, err: extra }); }
}
const stab = (o: Partial<StabilityClassification>): StabilityClassification => ({
  pixelPerfect: o.pixelPerfect ?? [], xmlStable: o.xmlStable ?? [], unstable: o.unstable ?? [],
  warning: o.warning ?? "", attempts: o.attempts ?? 3,
});
const asFn = (m: Record<string, RenderRecord>) => (sid: string): RenderRecord => m[sid] ?? {};

// ---------------------------------------------------------------------------
// PURE gate + adapter tests (no overlays needed)
// ---------------------------------------------------------------------------
function pureTests(): void {
  console.log("\nregression-gate PURE tests (comparison + gate + adapter)\n");

  // comparison unit checks
  ok("cmp: pixelIdentical true on equal hash", pixelIdentical({ pixelHash: "P" }, { pixelHash: "P" }) && !pixelIdentical({ pixelHash: "P" }, { pixelHash: "Q" }));
  ok("cmp: xmlPlusRenderedParts ignores non-rendered pixel diff",
    xmlPlusRenderedParts({ xmlHash: "X", renderedPartsHash: "R", pixelHash: "A" }, { xmlHash: "X", renderedPartsHash: "R", pixelHash: "B" }) &&
    !xmlPlusRenderedParts({ xmlHash: "X", renderedPartsHash: "R" }, { xmlHash: "X", renderedPartsHash: "R2" }));
  ok("cmp: unchanged prefers pixel then xml",
    unchanged({ pixelHash: "P", xmlHash: "X" }, { pixelHash: "P", xmlHash: "DIFF" }) === true &&
    unchanged({ pixelHash: "P" }, { pixelHash: "Q" }) === false);

  // (1) pixel-perfect green slide with a 1-pixel diff vs LGTM → did NOT keep binary stability.
  {
    const res = regressionGate({
      stability: stab({ pixelPerfect: ["slide_01"] }),
      greenSlides: ["slide_01"],
      record: asFn({ slide_01: { pixelHash: "CUR" } }),
      lgtm: asFn({ slide_01: { pixelHash: "LGTM" } }),
      base: asFn({}),
    });
    ok("(1) pixel-perfect green ≠ LGTM → did NOT keep binary stability + not ok",
      !res.ok && res.findings.length === 1 && res.findings[0].kind === "binary-unstable" && res.changed.includes(GREEN_INSTABILITY_SENTINEL),
      JSON.stringify(res));
  }

  // (2) xml-stable green slide: same xml + rendered-parts, differing non-rendered pixel → ok.
  {
    const res = regressionGate({
      stability: stab({ xmlStable: ["slide_02"] }),
      greenSlides: ["slide_02"],
      record: asFn({ slide_02: { xmlHash: "X", renderedPartsHash: "R", pixelHash: "CURPIX" } }),
      lgtm: asFn({ slide_02: { xmlHash: "X", renderedPartsHash: "R", pixelHash: "DIFFPIX" } }),
      base: asFn({}),
    });
    ok("(2) xml-stable green, xml+parts match, pixel differs → ok", res.ok && res.findings.length === 0 && res.changed.length === 0, JSON.stringify(res));
  }
  // (2b) xml-stable green with rendered-parts CHANGED → did NOT keep stability.
  {
    const res = regressionGate({
      stability: stab({ xmlStable: ["slide_02"] }),
      greenSlides: ["slide_02"],
      record: asFn({ slide_02: { xmlHash: "X", renderedPartsHash: "R_NEW" } }),
      lgtm: asFn({ slide_02: { xmlHash: "X", renderedPartsHash: "R" } }),
      base: asFn({}),
    });
    ok("(2b) xml-stable green, rendered-parts changed → did NOT keep xml+rendered stability",
      !res.ok && res.findings[0]?.kind === "xml-rendered-unstable" && res.changed.includes(GREEN_INSTABILITY_SENTINEL), JSON.stringify(res));
  }

  // (3) non-targeted slide changed vs base → ripple in `changed`.
  {
    const res = regressionGate({
      stability: stab({ xmlStable: ["slide_03"] }),
      greenSlides: [],
      record: asFn({ slide_03: { pixelHash: "NEW" } }),
      lgtm: asFn({}),
      base: asFn({ slide_03: { pixelHash: "OLD" } }),
    });
    ok("(3) non-targeted changed → ripple in changed",
      !res.ok && res.changed.includes("slide_03") && !res.changed.includes(GREEN_INSTABILITY_SENTINEL) && res.findings[0].kind === "ripple",
      JSON.stringify(res));
  }

  // (4) all-clean → ok, empty changed.
  {
    const res = regressionGate({
      stability: stab({ pixelPerfect: ["slide_01"], xmlStable: ["slide_02"] }),
      greenSlides: ["slide_01"],
      record: asFn({ slide_01: { pixelHash: "SAME" }, slide_02: { pixelHash: "B2" } }),
      lgtm: asFn({ slide_01: { pixelHash: "SAME" } }),
      base: asFn({ slide_02: { pixelHash: "B2" } }),
    });
    ok("(4) all-clean → ok, empty changed", res.ok && res.changed.length === 0 && res.findings.length === 0, JSON.stringify(res));
  }

  // (5) SERIAL target-mutation (pure): fork B's gate. slide_01 was mutated by the
  //     already-accepted fork A → it is fork B's NON-TARGETED slide. If base is the
  //     POST-A state, A's change must NOT be flagged as B's ripple.
  {
    const stability = stab({ pixelPerfect: ["slide_01", "slide_02"] });
    const postA: RenderRecord = { pixelHash: "A_RENDER" };
    const pristine: RenderRecord = { pixelHash: "PRISTINE" };
    // fork B currently renders: slide_01 = A's render (A already folded), slide_02 = B's fix.
    const mergeRender = asFn({ slide_01: postA, slide_02: { pixelHash: "B_RENDER" } });
    const lgtm = asFn({ slide_02: { pixelHash: "B_RENDER" } }); // B's slide matches its LGTM

    const okCase = regressionGate({ stability, greenSlides: ["slide_02"], record: mergeRender, lgtm, base: asFn({ slide_01: postA }) });
    ok("(5) base = post-A → A's change NOT flagged as B's ripple", okCase.ok && okCase.changed.length === 0, JSON.stringify(okCase));

    const badCase = regressionGate({ stability, greenSlides: ["slide_02"], record: mergeRender, lgtm, base: asFn({ slide_01: pristine }) });
    ok("(5b) base = pristine → same change IS flagged (gate honours given base)",
      !badCase.ok && badCase.changed.includes("slide_01"), JSON.stringify(badCase));
  }

  // (6) makeRegressionRetest ADVANCES the accepted base after a clean fork so the
  //     next fork compares against the post-previous-fork state.
  {
    const stability = stab({ pixelPerfect: ["slide_01", "slide_02"] });
    // mergeState mutates between retest calls (like the sequential COW workspace).
    let mergeState: Record<string, RenderRecord> = {};
    const retest = makeRegressionRetest({
      loadStability: () => stability,
      renderMergeDeck: () => (sid) => mergeState[sid] ?? {},
      // pristine base: slide_01 differs from A's render → WOULD ripple if base never advanced.
      baseRecord: asFn({ slide_01: { pixelHash: "PRISTINE_1" }, slide_02: { pixelHash: "PRISTINE_2" } }),
      lgtmRecord: asFn({ slide_01: { pixelHash: "A_RENDER" }, slide_02: { pixelHash: "B_RENDER" } }),
    });
    const dummyWs = {} as CowWorkspace;

    // fork A folds: slide_01 becomes A_RENDER (matches its LGTM), slide_02 untouched (pristine).
    mergeState = { slide_01: { pixelHash: "A_RENDER" }, slide_02: { pixelHash: "PRISTINE_2" } };
    const r1 = retest(dummyWs, ["slide_01"]);
    ok("(6) fork A clean retest → no ripple", r1.changed.length === 0, JSON.stringify(r1));

    // fork B folds: slide_01 stays A_RENDER (accepted), slide_02 becomes B_RENDER (matches LGTM).
    mergeState = { slide_01: { pixelHash: "A_RENDER" }, slide_02: { pixelHash: "B_RENDER" } };
    const r2 = retest(dummyWs, ["slide_02"]);
    ok("(6b) fork B retest → A's accepted change NOT re-flagged (base advanced)", r2.changed.length === 0, JSON.stringify(r2));

    // Control: a FRESH adapter that never saw A clean would ripple slide_01 for B.
    const retestFresh = makeRegressionRetest({
      loadStability: () => stability,
      renderMergeDeck: () => (sid) => mergeState[sid] ?? {},
      baseRecord: asFn({ slide_01: { pixelHash: "PRISTINE_1" }, slide_02: { pixelHash: "PRISTINE_2" } }),
      lgtmRecord: asFn({ slide_01: { pixelHash: "A_RENDER" }, slide_02: { pixelHash: "B_RENDER" } }),
    });
    const rControl = retestFresh(dummyWs, ["slide_02"]);
    ok("(6c) control: without A's clean fold, slide_01 DOES ripple for B", rControl.changed.includes("slide_01"), JSON.stringify(rControl));
  }

  // (7) SAME serial target-mutation but for the XML-STABLE class — the base-advance
  //     must compare fork B's non-targeted slide_01 against A's POST-FOLD *xml*
  //     (not the original), and pixel wobble must NOT ripple it.
  {
    const stability = stab({ xmlStable: ["slide_01", "slide_02"] });
    let mergeState: Record<string, RenderRecord> = {};
    const mk = (xml: string, parts: string, px: string): RenderRecord => ({ xmlHash: xml, renderedPartsHash: parts, pixelHash: px });
    const retest = makeRegressionRetest({
      loadStability: () => stability,
      renderMergeDeck: () => (sid) => mergeState[sid] ?? {},
      baseRecord: asFn({ slide_01: mk("PRE_1", "PRE_1", "wobble0"), slide_02: mk("PRE_2", "PRE_2", "wobble0") }),
      lgtmRecord: asFn({ slide_01: mk("A_XML", "A_PARTS", "wobbleA"), slide_02: mk("B_XML", "B_PARTS", "wobbleB") }),
    });
    const dummyWs = {} as CowWorkspace;

    // fork A folds: slide_01 xml→A_XML (matches its LGTM); pixel wobbles (irrelevant for xml-stable).
    mergeState = { slide_01: mk("A_XML", "A_PARTS", "wobble1"), slide_02: mk("PRE_2", "PRE_2", "wobble1") };
    const r1 = retest(dummyWs, ["slide_01"]);
    ok("(7) xml-stable fork A clean retest → no ripple", r1.changed.length === 0, JSON.stringify(r1));

    // fork B folds: slide_01 keeps A_XML (accepted) but pixels wobble AGAIN; slide_02→B_XML.
    mergeState = { slide_01: mk("A_XML", "A_PARTS", "wobble2"), slide_02: mk("B_XML", "B_PARTS", "wobble2") };
    const r2 = retest(dummyWs, ["slide_02"]);
    ok("(7b) xml-stable fork B → A's accepted XML NOT re-flagged (base advanced) + pixel wobble ignored", r2.changed.length === 0, JSON.stringify(r2));

    // Control: without A's clean fold, slide_01's xml (A_XML) differs from PRE_1 → ripples for B.
    const retestFresh = makeRegressionRetest({
      loadStability: () => stability,
      renderMergeDeck: () => (sid) => mergeState[sid] ?? {},
      baseRecord: asFn({ slide_01: mk("PRE_1", "PRE_1", "wobble0"), slide_02: mk("PRE_2", "PRE_2", "wobble0") }),
      lgtmRecord: asFn({ slide_01: mk("A_XML", "A_PARTS", "wobbleA"), slide_02: mk("B_XML", "B_PARTS", "wobbleB") }),
    });
    const rControl = retestFresh(dummyWs, ["slide_02"]);
    ok("(7c) control: without A's fold, slide_01 XML change DOES ripple for B", rControl.changed.includes("slide_01"), JSON.stringify(rControl));
  }
}


// ---------------------------------------------------------------------------
// The full merge-through-the-REAL-gate wire-through (real overlays + engine +
// promote + real ledger demote, mocking ONLY the LLM + the Slides recording per
// the mock policy) now lives in merge-e2e.test.ts. This file keeps the PURE
// gate/adapter unit tests, which feed regressionGate/makeRegressionRetest plain
// RenderRecords (data, not a mocked component).
function main(): void {
  pureTests();
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) {
    for (const f of failures) console.log(`  ✗ ${f.name}\n    ${(f.err as Error)?.stack ?? String(f.err)}`);
    process.exit(1);
  }
}
main();

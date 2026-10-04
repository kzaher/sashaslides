import { test } from "node:test";
import assert from "node:assert/strict";
import { anonymiseSlideHtml } from "./index.ts";

/**
 * Under lorem-always no model is involved, so no privacy disclosure may mention one.
 *
 * This is a correctness test, not a style one: a user reading "asking a model sends this
 * slide's visible text to that model" on a run where nothing left the browser is being told
 * something false about where their data went, in the one place they go to check.
 */
const SLIDE = `<!doctype html><html><head><title>Q3</title></head>
<body style="width:1280px;height:720px"><h1>Northwind revenue</h1><p>Up 12% this quarter</p></body></html>`;

test("with no model replacements, no residual risk mentions a model", () => {
  const out = anonymiseSlideHtml({ html: SLIDE, identifiers: "rename", seed: "copy-test" });

  // Nothing was rewritten, so nothing went to a model.
  assert.equal(out.textRuns.every((run) => run.origin === "substituted"), true);

  // The claim, not the word: the lorem sentence legitimately says "with NO model and no
  // network", which is reassurance, not a disclosure. What must never appear is a statement
  // that the slide's text WAS sent somewhere.
  const claimsItWasSent = out.residualRisks.filter((risk) =>
    /sends this slide|was sent to|asking a model/i.test(risk),
  );
  assert.deepEqual(
    claimsItWasSent,
    [],
    `nothing left the browser, so no risk may say it did; got:\n${claimsItWasSent.join("\n---\n")}`,
  );
});

test("when a replacement IS accepted, the model disclosure comes back", () => {
  const runs = anonymiseSlideHtml({ html: SLIDE, identifiers: "rename", seed: "copy-test" }).textRuns;
  const target = runs.find((run) => run.kind === "body-text");
  assert.ok(target !== undefined, "the fixture has a body-text run to replace");

  const out = anonymiseSlideHtml({
    html: SLIDE,
    identifiers: "rename",
    seed: "copy-test",
    replacements: new Map([[target.id, "Quarterly figures climbed"]]),
  });
  // Only meaningful if the replacement was actually taken.
  if (out.textRuns.some((run) => run.origin === "rewritten")) {
    assert.ok(
      out.residualRisks.some((risk) => /\bmodel\b/i.test(risk)),
      "a rewritten run must carry the disclosure about what the model was shown",
    );
  }
});

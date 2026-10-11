import { test } from "node:test";
import assert from "node:assert/strict";
import { anonymiseSlideHtml } from "./index.ts";

/**
 * The identifier policy is a privacy decision with a measurable consequence, so it is pinned by
 * a test rather than described in prose. Both halves matter: that `"preserve"` really does leak,
 * and that `"rename"` really does keep the stylesheet matching — the latter was the stated reason
 * for preferring `"preserve"`, and it does not survive contact with the renamer.
 */
const SENSITIVE = "Northwind";

const SLIDE = `<!doctype html><html><head><title>t</title><style>
.northwind-total{color:#c00}
#summary .northwind-total::after{content:"x"}
</style></head><body style="width:1280px;height:720px">
<div id="summary"><h1 class="northwind-total">Revenue</h1></div></body></html>`;

test('identifiers: "preserve" leaks a name the rest of the pipeline substituted', () => {
  const out = anonymiseSlideHtml({ html: SLIDE, identifiers: "preserve", seed: "test-seed" });
  // Every word of prose is gone...
  assert.ok(!out.html.includes("Revenue"));
  // ...but the class name carries the company straight through.
  assert.ok(
    out.html.toLowerCase().includes(SENSITIVE.toLowerCase()),
    "this is the documented cost of preserve, not an accident",
  );
  assert.ok(
    out.retainedIdentifiers.some((entry) => entry.name.includes("northwind")),
    "and it must be declared so a human can see it before sending",
  );
});

test('identifiers: "rename" leaks nothing and still styles the same elements', () => {
  const out = anonymiseSlideHtml({ html: SLIDE, identifiers: "rename", seed: "test-seed" });
  for (const form of [SENSITIVE, SENSITIVE.toLowerCase(), SENSITIVE.toUpperCase()]) {
    assert.ok(!out.html.includes(form), `"${form}" must not survive`);
  }
  assert.deepEqual(
    out.retainedIdentifiers.filter((entry) => entry.namespace === "class"),
    [],
    "no class name is retained",
  );

  // The cascade must still reach the same element, or the defect stops reproducing -- which is
  // the only argument that was ever made for preserve.
  const className = /class="([^"]+)"/.exec(out.html)?.[1];
  const idName = /id="([^"]+)"/.exec(out.html)?.[1];
  assert.ok(className !== undefined && idName !== undefined, "both names survive in renamed form");
  assert.ok(out.html.includes(`.${className}{`), "the class rule follows the class");
  assert.ok(
    out.html.includes(`#${idName} .${className}::after`),
    "and so does the descendant selector, pseudo-element and all",
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenizeHtml } from "./html-tokens.ts";
import { hasSubstitutableCharacter } from "./substitute-text.ts";
import { collectTextRunSites, extractTextRuns, textRunIdOf, type TextRun } from "./text-runs.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../e2e/fixtures");

function slide({ head = "", css = "", body = "" }: { head?: string; css?: string; body?: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Quarterly review</title>${head}
<style>body { width: 1280px; height: 720px; margin: 0 }
${css}</style></head>
<body>${body}</body></html>`;
}

const textsOf = (runs: readonly TextRun[]): readonly string[] => runs.map((run) => run.text);

test("the runs are the text a human sees, in document order, each with its kind", () => {
  const runs = extractTextRuns({
    html: slide({
      body: `<h1>Infrastructure spend</h1><p>Total was <em>£1,284,300</em> this quarter</p>
<img src="x.png" alt="A photo of the office"><button aria-label="Close the panel">x</button>
<svg width="100" height="20"><title>not on the slide</title><text x="0" y="10">Q3 actuals</text></svg>`,
    }),
  });
  assert.deepEqual(
    runs.map((run) => ({ kind: run.kind, text: run.text })),
    [
      { kind: "document-title", text: "Quarterly review" },
      { kind: "body-text", text: "Infrastructure spend" },
      { kind: "body-text", text: "Total was" },
      { kind: "body-text", text: "£1,284,300" },
      { kind: "body-text", text: "this quarter" },
      { kind: "image-alternative", text: "A photo of the office" },
      { kind: "accessible-label", text: "Close the panel" },
      { kind: "body-text", text: "x" },
      { kind: "svg-text", text: "Q3 actuals" },
    ],
  );
});

test("the structural carriers the deterministic engine owns are NOT offered to the model", () => {
  // Each of these is a carrier with its own case in anonymise-leak.test.ts. A model that never
  // sees one cannot be the thing that was supposed to neutralise it.
  const runs = extractTextRuns({
    html: slide({
      head: `<meta name="description" content="Northwind quarterly review">`,
      css: `.northwind-total::before { content: "Northwind"; } [data-tone="warn"] { color: red }`,
      body: `<!-- Northwind internal --><p class="northwind-total" id="northwind-row" data-owner="Northwind"
 title="Northwind tooltip" style='--label:"Northwind"'><a href="https://northwind.example.com">link</a></p>
<svg width="10" height="10"><desc>Northwind desc</desc><rect width="10" height="10"/></svg>
<textarea>Northwind draft</textarea><script>const owner = "Northwind";</script>`,
    }),
  });
  assert.deepEqual(textsOf(runs), ["Quarterly review", "link"]);
  for (const run of runs) assert.doesNotMatch(run.text, /Northwind/);
});

test("an id is a position, so the same document always yields the same ids", () => {
  const html = slide({ body: `<h1>Alpha</h1><p>Beta</p>` });
  assert.deepEqual(
    extractTextRuns({ html }).map((run) => run.id),
    extractTextRuns({ html }).map((run) => run.id),
  );
  const ids = new Set(extractTextRuns({ html }).map((run) => run.id));
  assert.equal(ids.size, 3, "ids must be unique per run");
});

test("the id of a site is derivable from its position, which is how the anonymiser finds it again", () => {
  const html = slide({ body: `<p>Alpha</p><img src="x.png" alt="Beta">` });
  for (const site of collectTextRunSites({ tokens: tokenizeHtml(html) })) {
    assert.equal(site.id, textRunIdOf({ tokenIndex: site.tokenIndex, attributeIndex: site.attributeIndex }));
  }
});

test("surrounding whitespace is not part of the run: it is kept aside to be re-emitted verbatim", () => {
  const sites = collectTextRunSites({ tokens: tokenizeHtml(slide({ body: `<p>\n      Infrastructure spend\n    </p>` })) });
  const paragraph = sites.find((site) => site.text.includes("Infrastructure"));
  assert.ok(paragraph !== undefined);
  assert.equal(paragraph.prefix, "\n      ");
  assert.equal(paragraph.suffix, "\n    ");
  assert.equal(`${paragraph.prefix}${paragraph.text}${paragraph.suffix}`, "\n      Infrastructure spend\n    ");
});

test("whitespace-only and punctuation-only text is not a run, because there is nothing to replace", () => {
  assert.deepEqual(textsOf(extractTextRuns({ html: slide({ body: `<p> </p><p>  —  </p><span></span>` }) })), [
    "Quarterly review",
  ]);
});

test("entity references are decoded, so the model is shown the text and not the encoding", () => {
  const runs = extractTextRuns({ html: slide({ body: `<p>&#65;&#67;&#77;&#69; &mdash; &pound;52</p>` }) });
  assert.deepEqual(textsOf(runs).slice(1), ["ACME — £52"]);
});

test("every real fixture yields runs, and a run is trimmed text with something to substitute", () => {
  for (const name of ["01-text.html", "02-table.html", "03-image.html", "04-gradient-shadow.html"]) {
    const html = readFileSync(join(FIXTURES, name), "utf-8");
    const runs = extractTextRuns({ html });
    assert.ok(runs.length > 0, `${name} yielded no runs`);
    for (const run of runs) {
      assert.equal(run.text, run.text.trim(), `${name}: run ${run.id} carries whitespace`);
      assert.ok(hasSubstitutableCharacter(run.text), `${name}: run ${run.id} has nothing to substitute`);
    }
  }
  // The one fixture whose exact text is worth pinning: an entity (`&middot;`) is decoded, and the
  // inline `<em>` splits the heading into the two runs the engine will substitute separately.
  const first = extractTextRuns({ html: readFileSync(join(FIXTURES, "01-text.html"), "utf-8") });
  assert.deepEqual(textsOf(first).slice(0, 4), ["Fixture 1 — text only", "Paths in,", "ids out", "Why the model never reads the slide back"]);
  assert.ok(textsOf(first).some((runText) => runText.includes("·")), "the &middot; was not decoded");
});

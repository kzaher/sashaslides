import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anonymiseSlideHtml, type TextStrategy } from "./anonymise-slide-html.ts";
import { tokenizeHtml } from "./html-tokens.ts";
import { intrinsicImageSize } from "./placeholder-image.ts";
import { extractTextRuns } from "./text-runs.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../e2e/fixtures");
const NAMES: readonly string[] = ["01-text.html", "02-table.html", "03-image.html", "04-gradient-shadow.html"];
const SEED = "anonymise-test-seed";

const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf-8");
/** The default strategy, which is `{ kind: "lorem" }` — see `DEFAULT_TEXT_STRATEGY`. */
const anonymise = (html: string) => anonymiseSlideHtml({ html, seed: SEED, identifiers: "preserve" });
/** For the assertions that are about character-by-character substitution and only about it. */
const substituted = (html: string) =>
  anonymiseSlideHtml({ html, seed: SEED, identifiers: "preserve", textStrategy: { kind: "substitute" } });
const STRATEGIES = [{ kind: "substitute" }, { kind: "lorem" }] satisfies readonly TextStrategy[];

test("the element and attribute skeleton of every real fixture is unchanged", () => {
  for (const name of NAMES) {
    const original = fixture(name);
    assert.deepEqual(skeletonOf(anonymise(original).html), skeletonOf(original), name);
  }
});

test('textStrategy "substitute" keeps every text run\'s exact length, so wrapping cannot move', () => {
  for (const name of NAMES) {
    const original = fixture(name);
    assert.deepEqual(textLengthsOf(substituted(original).html), textLengthsOf(original), name);
  }
});

test("the default lorem strategy keeps every text node's WHITESPACE at every position", () => {
  // Lorem cannot keep the character count — it keeps the rendered WIDTH instead — so what has to
  // hold instead is that every space, newline and indent is still exactly where it was and the
  // number of words between them is unchanged. That is what the wrap opportunities are made of.
  for (const name of NAMES) {
    const original = fixture(name);
    assert.deepEqual(whitespaceSkeletonOf(anonymise(original).html), whitespaceSkeletonOf(original), name);
  }
});

test("the stylesheet comes out byte-identical apart from its comments", () => {
  for (const name of NAMES) {
    const original = fixture(name);
    const before = stylesheetsOf(original).map((css) => css.replace(/\/\*[\s\S]*?\*\//g, ""));
    assert.deepEqual(stylesheetsOf(anonymise(original).html), before, name);
  }
});

test("geometry, colours and font declarations survive verbatim in the output text", () => {
  const anonymised = anonymise(fixture("01-text.html")).html;
  for (const declaration of [
    "width: 1280px; height: 720px;",
    'font-family: Georgia, "Times New Roman", serif;',
    "background: #fdfbf7; color: #241f1a;",
    "font-size: 58px; line-height: 1.08; letter-spacing: -0.02em; font-weight: 700;",
    "position: absolute; left: 96px; bottom: 44px;",
  ]) {
    assert.ok(anonymised.includes(declaration), `lost: ${declaration}`);
  }
});

test("nothing in the real fixtures trips the default-deny rule, so the allowlist covers real slides", () => {
  for (const name of NAMES) assert.deepEqual(anonymise(fixture(name)).unrecognisedAttributes, [], name);
});

test("the fixture's embedded photograph is replaced by a placeholder of exactly its size", () => {
  const original = fixture("03-image.html");
  const result = anonymise(original);
  const before = /<img[^>]*\ssrc="([^"]+)"/.exec(original)?.[1] ?? "";
  const after = /<img[^>]*\ssrc="([^"]+)"/.exec(result.html)?.[1] ?? "";
  assert.ok(before.startsWith("data:image/png;base64,"));
  assert.ok(after.startsWith("data:image/svg+xml,"));
  assert.deepEqual(intrinsicImageSize(after), intrinsicImageSize(before));
  // Not one byte of the original image survives.
  assert.ok(!result.html.includes(before.slice(40, 200)));
  assert.ok(
    result.carriers.some((tally) => tally.carrier === "embedded image" && tally.treatment === "replaced-with-placeholder"),
  );
});

test("the same seed gives the same output; a different seed does not", () => {
  const original = fixture("02-table.html");
  assert.equal(anonymise(original).html, anonymise(original).html);
  assert.notEqual(anonymiseSlideHtml({ html: original, seed: "other", identifiers: "preserve" }).html, anonymise(original).html);
});

test("the seed is nowhere in the result, because with it the substitution is reversible", () => {
  const result = anonymise(fixture("01-text.html"));
  assert.ok(!JSON.stringify(result).includes(SEED));
});

test("a comment, a script body and a srcdoc are removed; the elements around them are not", () => {
  const result = anonymise(
    `<!doctype html><html><head><title>t</title></head><body><!-- note --><script>x=1</script><iframe srcdoc="<p>a</p>" src="https://e.example.com"></iframe><p>a</p></body></html>`,
  );
  assert.ok(!result.html.includes("<!--"));
  assert.match(result.html, /<script><\/script>/);
  assert.match(result.html, /<iframe><\/iframe>/);
  assert.deepEqual(
    result.carriers.filter((tally) => tally.treatment === "removed").map((tally) => tally.carrier).sort(),
    ["HTML comment", "inline script body", "src attribute", "srcdoc attribute"],
  );
});

test("a <meta> that the browser acts on is preserved; one that is prose is not", () => {
  const result = anonymise(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="description" content="Q3 infrastructure spend"></head><body><p>a</p></body></html>`,
  );
  assert.match(result.html, /<meta charset="utf-8">/);
  assert.match(result.html, /content="width=device-width, initial-scale=1"/);
  assert.match(result.html, /content="IE=edge"/);
  assert.doesNotMatch(result.html, /infrastructure/);
});

test("an SVG presentation attribute is preserved inside <svg> and substituted outside it", () => {
  const inside = anonymise(`<!doctype html><body><svg width="10" height="10"><rect fill="#f00" d="M0 0L10 10" in="SourceGraphic"/></svg></body>`);
  assert.match(inside.html, /fill="#f00"/);
  assert.match(inside.html, /d="M0 0L10 10"/);
  assert.match(inside.html, /in="SourceGraphic"/);
  // The same words on an ordinary element are not stylesheet, so default-deny applies.
  const outside = anonymise(`<!doctype html><body><div in="SourceGraphic">a</div></body>`);
  assert.doesNotMatch(outside.html, /SourceGraphic/);
  assert.deepEqual(outside.unrecognisedAttributes, ["in"]);
});

test("id references keep pointing at the thing they referenced, under either policy", () => {
  const html = `<!doctype html><body><label for="amount">a</label><input id="amount"><svg width="4" height="4"><lineargradient id="g"/><rect fill="url(#g)" width="4" height="4"/></svg></body>`;
  for (const identifiers of ["preserve", "rename"] as const) {
    const result = anonymiseSlideHtml({ html, seed: SEED, identifiers });
    const labelFor = /for="([^"]+)"/.exec(result.html)?.[1];
    const inputId = /<input id="([^"]+)"/.exec(result.html)?.[1];
    assert.equal(labelFor, inputId, identifiers);
    const gradientId = /lineargradient id="([^"]+)"/.exec(result.html)?.[1];
    assert.ok(gradientId !== undefined && result.html.includes(`url(#${gradientId})`), identifiers);
  }
});

test('under "rename", a class is renamed in the markup and in the stylesheet together', () => {
  const result = anonymiseSlideHtml({
    html: `<!doctype html><html><head><style>.card .num { color: red } #hero { top: 0 }</style></head><body><div class="card"><span class="num">1</span></div><div id="hero">a</div></body></html>`,
    seed: SEED,
    identifiers: "rename",
  });
  const classes = [...result.html.matchAll(/class="([^"]+)"/g)].map((found) => found[1] ?? "");
  assert.deepEqual(result.retainedIdentifiers, []);
  for (const name of classes) assert.ok(result.html.includes(`.${name}`), `.${name} missing from the stylesheet`);
  assert.doesNotMatch(result.html, /card|num|hero/);
});

test("the residual-risk list is always present and always says what shape discloses", () => {
  const result = anonymise(fixture("04-gradient-shadow.html"));
  assert.ok(result.residualRisks.length >= 10);
  assert.ok(result.residualRisks.some((risk) => /ORDER OF MAGNITUDE/.test(risk)));
  assert.ok(result.residualRisks.some((risk) => /Class names and ids are emitted verbatim/.test(risk)));
});

/**
 * The model-assisted half. The rule under every test below: a replacement can only ever make a run
 * READABLE, never original. See replacement-policy.ts and the hostile replies in
 * anonymise-leak.test.ts.
 */
const SLIDE_WITH_RUNS = `<!doctype html><html><head><title>Quarterly review</title></head>
<body><h1>
      Northwind infrastructure spend
    </h1><p>Total was £1,284,300</p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="The Northwind office"></body></html>`;

/** The runs of `SLIDE_WITH_RUNS`, by a word of their text. Throws rather than silently skipping. */
function runIdFor(startsWith: string): string {
  const run = extractTextRuns({ html: SLIDE_WITH_RUNS }).find((candidate) => candidate.text.startsWith(startsWith));
  if (run === undefined) throw new Error(`no run starting with ${startsWith}`);
  return run.id;
}

const withReplacements = (replacements: ReadonlyMap<string, string>) =>
  anonymiseSlideHtml({ html: SLIDE_WITH_RUNS, seed: SEED, identifiers: "rename", replacements });

test("an accepted replacement lands in the HTML with the run's own whitespace kept around it", () => {
  const result = withReplacements(new Map([[runIdFor("Northwind infrastructure"), "Fabrikam datacentre outlays"]]));
  assert.ok(
    result.html.includes("<h1>\n      Fabrikam datacentre outlays\n    </h1>"),
    `the replacement did not land with its whitespace: ${result.html}`,
  );
  assert.deepEqual(skeletonOf(result.html), skeletonOf(SLIDE_WITH_RUNS));
  assert.ok(result.carriers.some((tally) => tally.carrier === "text" && tally.treatment === "rewritten"));
});

test("EVERY run without an accepted replacement is still substituted — never left as the original", () => {
  const result = withReplacements(new Map([[runIdFor("Northwind infrastructure"), "Fabrikam datacentre outlays"]]));
  assert.doesNotMatch(result.html, /Quarterly|review|Total|office/i);
  assert.deepEqual(
    result.textRuns.map((run) => run.origin),
    ["substituted", "rewritten", "substituted", "substituted"],
  );
});

test("textRuns is the after column: every run, in document order, and never the original text", () => {
  const before = extractTextRuns({ html: SLIDE_WITH_RUNS });
  const accepted = new Map([[runIdFor("Total was"), "Receipts hit £4,861,200"]]);
  for (const textStrategy of STRATEGIES) {
    const result = anonymiseSlideHtml({
      html: SLIDE_WITH_RUNS,
      seed: SEED,
      identifiers: "rename",
      replacements: accepted,
      textStrategy,
    });
    assert.deepEqual(result.textRuns.map((run) => run.id), before.map((run) => run.id));
    assert.deepEqual(result.textRuns.map((run) => run.kind), before.map((run) => run.kind));
    for (const [index, after] of result.textRuns.entries()) {
      const original = before[index];
      assert.ok(original !== undefined);
      assert.notEqual(after.text, original.text, `run ${after.id} came out as its original`);
      if (after.origin === "rewritten") continue;
      // Both deterministic strategies keep the word count, which is what keeps the wrap
      // opportunities; only `"substitute"` also keeps the character count (asserted above).
      assert.deepEqual(after.text.split(/\s+/).length, original.text.split(/\s+/).length, `run ${after.id}`);
    }
    assert.equal(result.textRuns.find((run) => run.origin === "rewritten")?.text, "Receipts hit £4,861,200");
  }
});

test("a rejected replacement becomes gibberish and is reported with its run id and reason", () => {
  const headingId = runIdFor("Northwind infrastructure");
  const result = withReplacements(new Map([[headingId, "Northwind infrastructure spend"]]));
  assert.doesNotMatch(result.html, /Northwind|infrastructure/i);
  assert.deepEqual(
    result.rejectedReplacements.map((rejection) => ({ runId: rejection.runId, reason: rejection.reason })),
    [{ runId: headingId, reason: "unchanged" }],
  );
  assert.equal(result.textRuns.find((run) => run.id === headingId)?.origin, "substituted");
});

test("an id for a run this slide does not have changes nothing and is reported", () => {
  const result = withReplacements(new Map([["t4096", "Acme Corporation"]]));
  assert.deepEqual(result.html, anonymiseSlideHtml({ html: SLIDE_WITH_RUNS, seed: SEED, identifiers: "rename" }).html);
  assert.deepEqual(result.rejectedReplacements.map((rejection) => rejection.reason), ["unknown-run"]);
});

test("a replacement is TEXT, so markup inside it is escaped rather than parsed", () => {
  const result = withReplacements(new Map([[runIdFor("Total was"), '</p><script>alert("x")</script><p>'] ]));
  assert.deepEqual(skeletonOf(result.html), skeletonOf(SLIDE_WITH_RUNS));
  assert.ok(result.html.includes("&lt;/p&gt;&lt;script&gt;"), result.html);
});

test("`alt` and `<title>` are runs too, and a replacement in them is escaped for its context", () => {
  const result = withReplacements(
    new Map([
      [runIdFor("The Northwind office"), 'A photo of the "Fabrikam" lobby'],
      [runIdFor("Quarterly review"), "Half-year summary"],
    ]),
  );
  assert.ok(result.html.includes('alt="A photo of the &quot;Fabrikam&quot; lobby"'), result.html);
  assert.ok(result.html.includes("<title>Half-year summary</title>"), result.html);
  assert.deepEqual(skeletonOf(result.html), skeletonOf(SLIDE_WITH_RUNS));
});

test("an accepted replacement whose shape differs is reported as a fidelity risk, not waved through", () => {
  const totalId = runIdFor("Total was");
  const result = withReplacements(new Map([[totalId, "Receipts"]]));
  assert.deepEqual(
    result.shapeRisks.map((risk) => ({ runId: risk.runId, risk: risk.risk })),
    [{ runId: totalId, risk: "length" }],
  );
  assert.equal(result.shapeRisks[0]?.originalLength, "Total was £1,284,300".length);
});

test("the model disclosure appears only when a model actually wrote something", () => {
  // This test used to assert the opposite — that the disclosure was unconditional. That was
  // correct while the model-assisted path existed: a user needed to know BEFORE asking that
  // asking would send their text. Anonymisation is lorem-only now, nothing leaves the browser,
  // and an unconditional disclosure became a false statement in the one place a user checks.
  const out = anonymiseSlideHtml({
    html: '<!doctype html><html><head><title>t</title></head><body style="width:1280px;height:720px"><p>Northwind revenue</p></body></html>',
    identifiers: "rename",
    seed: "disclosure-test",
  });
  assert.equal(out.textRuns.every((run) => run.origin === "substituted"), true, "no run was model-written");
  assert.equal(
    out.residualRisks.some((risk) => /asking a model|sends this slide/i.test(risk)),
    false,
    "no model was involved, so the disclosure must be absent",
  );
});

/** Tag names and attribute names in document order: the part that must not move. */
function skeletonOf(html: string): readonly string[] {
  return tokenizeHtml(html).flatMap((token) => {
    switch (token.kind) {
      case "start-tag":
        return [`<${token.name}>`, ...token.attributes.map((attribute) => `@${attribute.name.toLowerCase()}`)];
      case "end-tag":
        return [`</${token.name}>`];
      case "doctype":
        return ["!doctype"];
      case "raw-text":
      case "text":
      case "comment":
      case "cdata":
      case "bogus":
        return [];
      default:
        return assertNever(token);
    }
  });
}

function textLengthsOf(html: string): readonly number[] {
  return tokenizeHtml(html)
    .filter((token) => token.kind === "text")
    .map((token) => (token.kind === "text" ? token.source.length : 0));
}

/**
 * Every text token's whitespace, as a shape: each run of whitespace verbatim, with the words
 * between them reduced to their count. Two documents with the same skeleton break lines at the
 * same opportunities.
 */
function whitespaceSkeletonOf(html: string): readonly string[] {
  return tokenizeHtml(html)
    .filter((token) => token.kind === "text")
    .map((token) => (token.kind === "text" ? token.source.replace(/\S+/g, "w") : ""));
}

function stylesheetsOf(html: string): readonly string[] {
  return tokenizeHtml(html)
    .filter((token) => token.kind === "raw-text" && token.owner === "style")
    .map((token) => (token.kind === "raw-text" ? token.text : ""));
}

function assertNever(value: never): never {
  throw new Error(`Unhandled token: ${JSON.stringify(value)}`);
}

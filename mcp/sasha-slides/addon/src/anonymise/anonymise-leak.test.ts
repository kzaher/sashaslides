/**
 * anonymise-leak.test.ts — THE test. Everything else in this directory checks that the anonymiser
 * is faithful; this one checks that it is safe, and if it ever goes red nothing else matters.
 *
 * It takes a distinctive canary string, hides it in every carrier anyone here could think of,
 * anonymises the result and asserts the canary is nowhere in the output — searching not just for
 * the string but for its base64, percent-encoded, decimal-entity and hex-entity forms, and for its
 * two distinctive fragments, so "it technically re-encoded it" does not pass.
 *
 * TO ADD A CANARY: add one entry to `SITES`. Nothing else. A site is `{ site, html, expect }` where
 * `html(canary)` returns a whole slide document with the canary planted, and `expect` is either
 * `"gone"` (the output must not contain it) or `"declared-identifier"` (it is a name rather than a
 * value, so it survives by design and must appear in `retainedIdentifiers` for the user to read).
 * If you are adding a carrier and are not sure which, use `"gone"`: a red test is the correct way
 * to find out that the anonymiser does not handle it yet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anonymiseSlideHtml, type IdentifierPolicy, type TextStrategy } from "./anonymise-slide-html.ts";
import { extractTextRuns, type TextRun, type TextRunId } from "./text-runs.ts";

const CANARY = "Zqxvcanary7731";
/** Fragments that must not survive either, so a partial substitution cannot pass. */
const FRAGMENTS: readonly string[] = ["Zqxvcanary", "canary", "7731", "Zqxv"];
const SEED = "leak-test-seed-not-a-real-one";
/**
 * EVERY CASE RUNS UNDER EVERY STRATEGY. `{ kind: "lorem" }` is the default and the only one a real
 * report uses now, and it is a SECOND writer of the visible runs, so a canary that the substituter
 * neutralises proves nothing about it. Running the whole table twice is the cheap way to keep that
 * true as the table grows: a new carrier added below is automatically tested under both.
 */
const STRATEGIES = [{ kind: "substitute" }, { kind: "lorem" }] satisfies readonly TextStrategy[];
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../e2e/fixtures");

type Expectation =
  /** The output must not contain the canary in any encoding. */
  | "gone"
  /** A NAME rather than a value: it survives by design and must be listed in `retainedIdentifiers`. */
  | "declared-identifier"
  /** Preserved for a stated reason: it survives and there must be a sentence in `residualRisks`. */
  | "documented-residual";

type CanarySite = Readonly<{
  site: string;
  html: (canary: string) => string;
  expect: Expectation;
}>;

/** A self-contained 1280x720 document, as PROTOCOL.md requires, with room to plant things. */
function slide({ head = "", css = "", body = "" }: { head?: string; css?: string; body?: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture</title>${head}
<style>body { width: 1280px; height: 720px; margin: 0; font: 16px Arial; }
${css}</style></head>
<body>${body}</body></html>`;
}

const SITES: readonly CanarySite[] = [
  { site: "heading text", expect: "gone", html: (canary) => slide({ body: `<h1>${canary}</h1>` }) },
  { site: "table cell text", expect: "gone", html: (canary) => slide({ body: `<table><tr><td>${canary}</td></tr></table>` }) },
  { site: "<title> element", expect: "gone", html: (canary) => slide({}).replace("<title>Fixture</title>", `<title>${canary}</title>`) },
  { site: "HTML comment", expect: "gone", html: (canary) => slide({ body: `<!-- ${canary} --><p>x</p>` }) },
  { site: "comment inside <style>", expect: "gone", html: (canary) => slide({ css: `/* ${canary} */ p { color: red }` }) },
  { site: "alt attribute", expect: "gone", html: (canary) => slide({ body: `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="${canary}">` }) },
  { site: "title attribute", expect: "gone", html: (canary) => slide({ body: `<p title="${canary}">x</p>` }) },
  { site: "aria-label", expect: "gone", html: (canary) => slide({ body: `<p aria-label="${canary}">x</p>` }) },
  { site: "aria-roledescription", expect: "gone", html: (canary) => slide({ body: `<p aria-roledescription="${canary}">x</p>` }) },
  { site: "data-* value", expect: "gone", html: (canary) => slide({ body: `<p data-owner="${canary}">x</p>` }) },
  { site: "an attribute nobody listed", expect: "gone", html: (canary) => slide({ body: `<p x-tooltip="${canary}">x</p>` }) },
  { site: "placeholder attribute", expect: "gone", html: (canary) => slide({ body: `<input placeholder="${canary}">` }) },
  { site: "input value", expect: "gone", html: (canary) => slide({ body: `<input value="${canary}">` }) },
  { site: "table summary and th abbr", expect: "gone", html: (canary) => slide({ body: `<table summary="${canary}"><tr><th abbr="${canary}">x</th></tr></table>` }) },
  { site: "option label", expect: "gone", html: (canary) => slide({ body: `<select><option label="${canary}">x</option></select>` }) },
  { site: "meta description", expect: "gone", html: (canary) => slide({ head: `<meta name="description" content="${canary}">` }) },
  { site: "CSS content string", expect: "gone", html: (canary) => slide({ css: `p::before { content: "${canary}"; }`, body: "<p>x</p>" }) },
  { site: "CSS custom property string", expect: "gone", html: (canary) => slide({ css: `:root { --label: "${canary}"; } p::after { content: var(--label) }`, body: "<p>x</p>" }) },
  { site: "CSS attribute-selector string", expect: "gone", html: (canary) => slide({ css: `[data-tone="${canary}"] { color: red }`, body: `<p data-tone="${canary}">x</p>` }) },
  { site: "inline style content", expect: "gone", html: (canary) => slide({ body: `<p style='--l:"${canary}"'>x</p>` }) },
  { site: "inline style, entity-encoded", expect: "gone", html: (canary) => slide({ body: `<p style="content:&quot;${canary}&quot;">x</p>` }) },
  { site: "inline SVG <text>", expect: "gone", html: (canary) => slide({ body: `<svg width="100" height="20"><text x="0" y="10">${canary}</text></svg>` }) },
  { site: "SVG <title> and <desc>", expect: "gone", html: (canary) => slide({ body: `<svg width="10" height="10"><title>${canary}</title><desc>${canary}</desc><rect width="10" height="10"/></svg>` }) },
  { site: "CDATA inside SVG", expect: "gone", html: (canary) => slide({ body: `<svg width="10" height="10"><desc><![CDATA[${canary}]]></desc></svg>` }) },
  { site: "textarea content", expect: "gone", html: (canary) => slide({ body: `<textarea>${canary}</textarea>` }) },
  { site: "inline script body", expect: "gone", html: (canary) => slide({ body: `<script>const owner = "${canary}";</script><p>x</p>` }) },
  { site: "event handler attribute", expect: "gone", html: (canary) => slide({ body: `<p onclick="alert('${canary}')">x</p>` }) },
  { site: "href URL", expect: "gone", html: (canary) => slide({ body: `<a href="https://${canary}.example.com/${canary}">x</a>` }) },
  { site: "email address in text", expect: "gone", html: (canary) => slide({ body: `<p>${canary}@${canary}.com</p>` }) },
  { site: "iframe srcdoc", expect: "gone", html: (canary) => slide({ body: `<iframe srcdoc="<p>${canary}</p>"></iframe>` }) },
  { site: "iframe src", expect: "gone", html: (canary) => slide({ body: `<iframe src="https://${canary}.example.com"></iframe>` }) },
  { site: "img srcset", expect: "gone", html: (canary) => slide({ body: `<img srcset="https://x.example.com/${canary}.png 2x" src="https://x.example.com/${canary}.png">` }) },
  { site: "CSS url()", expect: "gone", html: (canary) => slide({ css: `p { background: url(https://x.example.com/${canary}.png) }`, body: "<p>x</p>" }) },
  { site: "an SVG data: image carrying text", expect: "gone", html: (canary) => slide({ body: `<img width="100" height="50" src="data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='100' height='50'><text y='20'>${canary}</text></svg>`)}">` }) },
  { site: "a base64 raster whose bytes spell it", expect: "gone", html: (canary) => slide({ body: `<img width="8" height="8" src="data:image/png;base64,${Buffer.from(`\x89PNG\r\n\x1a\n${canary}`).toString("base64")}">` }) },
  { site: "numeric entity references", expect: "gone", html: (canary) => slide({ body: `<p>${[...canary].map((character) => `&#${character.codePointAt(0) ?? 0};`).join("")}</p>` }) },
  { site: "hex entity references", expect: "gone", html: (canary) => slide({ body: `<p>${[...canary].map((character) => `&#x${(character.codePointAt(0) ?? 0).toString(16)};`).join("")}</p>` }) },
  { site: "processing instruction", expect: "gone", html: (canary) => slide({ body: `<?${canary}?><p>x</p>` }) },
  { site: "base href", expect: "gone", html: (canary) => slide({ head: `<base href="https://${canary}.example.com/">` }) },
  { site: "a figure in the text", expect: "gone", html: (canary) => slide({ body: `<p>Total spend was £1,284,300 (${canary})</p>` }) },

  // Names, not values. These survive by design — see residualRisks — and must be DECLARED.
  { site: "class name", expect: "declared-identifier", html: (canary) => slide({ css: `.${canary} { color: red }`, body: `<p class="${canary}">x</p>` }) },
  { site: "element id", expect: "declared-identifier", html: (canary) => slide({ css: `#${canary} { color: red }`, body: `<p id="${canary}">x</p>` }) },
  { site: "data-* attribute NAME", expect: "declared-identifier", html: (canary) => slide({ body: `<p data-${canary.toLowerCase()}="1">x</p>` }) },
  { site: "custom element NAME", expect: "declared-identifier", html: (canary) => slide({ body: `<${canary.toLowerCase()}-box>x</${canary.toLowerCase()}-box>` }) },

  // A bare CSS token. It cannot render as text, substituting it would change the rendering, and it
  // is written down in residualRisks rather than quietly ignored.
  { site: "an unquoted CSS token", expect: "documented-residual", html: (canary) => slide({ css: `:root { --owner: ${canary}; }`, body: "<p>x</p>" }) },
  { site: "an unquoted font-family name", expect: "documented-residual", html: (canary) => slide({ css: `p { font-family: ${canary}, Arial }`, body: "<p>x</p>" }) },
];

for (const site of SITES) {
  test(`no canary survives in: ${site.site}`, () => {
    const input = site.html(CANARY);
    assert.ok(containsCanary(input), `the ${site.site} case does not actually plant the canary`);
    for (const textStrategy of STRATEGIES) assertSite({ site, input, textStrategy });
  });
}

function assertSite({
  site,
  input,
  textStrategy,
}: {
  site: CanarySite;
  input: string;
  textStrategy: TextStrategy;
}): void {
  const result = anonymiseSlideHtml({ html: input, seed: SEED, identifiers: "preserve", textStrategy });
  const where = `${site.site} (${textStrategy.kind})`;
  for (const run of result.textRuns) assertNoCanary({ output: run.text, site: `the after column of ${run.id} in ${where}` });

  switch (site.expect) {
      case "gone":
        assertNoCanary({ output: result.html, site: where });
        return;
      case "declared-identifier": {
        // A name: it is in the output on purpose, so the contract is that the user is TOLD.
        const declared = result.retainedIdentifiers.some((identifier) => identifier.name.toLowerCase().includes("zqxvcanary"));
        assert.ok(declared, `${where} survived without being listed in retainedIdentifiers`);
        assert.ok(
          result.residualRisks.some((risk) => /verbatim/i.test(risk)),
          `${where} survived without a residual-risk sentence explaining it`,
        );
        return;
      }
      case "documented-residual":
        assert.ok(
          result.residualRisks.some((risk) => /bare CSS TOKEN|Font family names/.test(risk)),
          `${where} survived without a residual-risk sentence explaining it`,
        );
        return;
      default:
        return assertNever(site.expect);
    }
}

test('identifiers: "rename" removes the class and id canaries that "preserve" keeps', () => {
  for (const site of SITES.filter((candidate) => candidate.site === "class name" || candidate.site === "element id")) {
    const result = anonymiseSlideHtml({ html: site.html(CANARY), seed: SEED, identifiers: "rename" });
    assertNoCanary({ output: result.html, site: `${site.site} under rename` });
    assert.deepEqual(result.retainedIdentifiers.filter((identifier) => identifier.namespace === "class"), []);
  }
});

test("the four real fixtures, seeded with the canary in every text node, leak nothing", () => {
  for (const name of ["01-text.html", "02-table.html", "03-image.html", "04-gradient-shadow.html"]) {
    const original = readFileSync(join(FIXTURES, name), "utf-8");
    // Plant the canary in every text node by appending it to the end of every closing-tag-adjacent
    // run, plus in the title and in an alt attribute, so the whole document is hostile.
    // Only inside <body>: appending to a <style> body would plant a bare CSS token, which is a
    // different (documented) carrier with its own case above.
    const seeded = original
      .replace(/(<body[^>]*>)([\s\S]*?)(<\/body>)/, (_whole, open: string, body: string, close: string) =>
        `${open}${body.replace(/>([^<>]*[A-Za-z][^<>]*)</g, (_match, text: string) => `>${text} ${CANARY}<`)}${close}`,
      )
      .replace(/alt="([^"]*)"/g, `alt="${CANARY}"`)
      .replace("<title>", `<title>${CANARY} `);
    assert.ok(containsCanary(seeded), name);
    for (const identifiers of ["preserve", "rename"] satisfies readonly IdentifierPolicy[]) {
      for (const textStrategy of STRATEGIES) {
        const result = anonymiseSlideHtml({ html: seeded, seed: SEED, identifiers, textStrategy });
        assertNoCanary({ output: result.html, site: `${name} (${identifiers}, ${textStrategy.kind})` });
        for (const run of result.textRuns) {
          assertNoCanary({ output: run.text, site: `${name} run ${run.id} (${identifiers}, ${textStrategy.kind})` });
        }
      }
    }
  }
});

test("a thousand distinct canaries in a thousand text nodes all disappear", () => {
  // One canary could get lucky. The point of this one is that the substitution is not a lookup of
  // strings it happens to recognise.
  const rows = Array.from({ length: 1000 }, (_unused, index) => `<p>Zqxvcanary${index} value</p>`).join("");
  for (const textStrategy of STRATEGIES) {
    const result = anonymiseSlideHtml({ html: slide({ body: rows }), seed: SEED, identifiers: "preserve", textStrategy });
    assert.doesNotMatch(result.html, /Zqxvcanary|zqxvcanary/i);
    for (const run of result.textRuns) assert.doesNotMatch(run.text, /Zqxvcanary|zqxvcanary/i);
  }
});

/**
 * ============================================================================================
 *  THE HOSTILE-REPLY SUITE. A model writes the visible text now, so the question is no longer
 *  only "does the substituter miss a carrier" but "what can a model's answer do". The answer has
 *  to be: nothing. Useless, empty, truncated, mis-addressed, obfuscated or actively adversarial —
 *  every one of these costs READABILITY and none of them puts a byte of the original in the
 *  output, because every run the gate does not accept is substituted exactly as before.
 *
 *  TO ADD A CASE: one entry in `HOSTILE_REPLIES`. The assertions are the same as for a carrier —
 *  the canary must be gone from `html` AND from `textRuns`, which is what the review surface
 *  renders as the after column.
 *
 *  WHAT THESE CANNOT PROVE, written down so nobody mistakes a green suite for a proof: a reply
 *  that ENCODES the original rather than echoing it (base64, reversal, an acrostic) shares no
 *  token with its input, so no rule in replacement-policy.ts sees it. The defences there are that
 *  the model is shown only the visible runs and that the user reads the after column before
 *  sending. The same goes for an echo shorter than the four-character threshold the contract sets.
 * ============================================================================================
 */
type HostileReply = Readonly<{
  name: string;
  slide: (canary: string) => string;
  /** As wrong, as empty or as malicious as it likes. It is given the runs it was asked about. */
  replacements: (runs: readonly TextRun[]) => ReadonlyMap<TextRunId, string>;
}>;

/** The canary in every run: a reply that touches anything at all is touching the canary. */
const CANARY_IN_EVERY_RUN = (canary: string): string =>
  slide({
    body: `<h1>${canary} infrastructure spend</h1><p>Total was £1,284,300 for ${canary}</p>` +
      `<img width="8" height="8" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Photo of the ${canary} office">`,
  }).replace("<title>Fixture</title>", `<title>${canary} quarterly review</title>`);

/** The canary in ONE run, so a reply can try to move it into a different one. */
const CANARY_IN_ONE_RUN = (canary: string): string =>
  slide({ body: `<h1>${canary} Holdings</h1><p>Total was £1,284,300</p>` });

const echoOf = (runs: readonly TextRun[], change: (text: string) => string): ReadonlyMap<TextRunId, string> =>
  new Map(runs.map((run) => [run.id, change(run.text)]));

const HOSTILE_REPLIES: readonly HostileReply[] = [
  { name: "echoes every run back verbatim", slide: CANARY_IN_EVERY_RUN, replacements: (runs) => echoOf(runs, (text) => text) },
  { name: "echoes every run back in another case", slide: CANARY_IN_EVERY_RUN, replacements: (runs) => echoOf(runs, (text) => text.toUpperCase()) },
  { name: "echoes every run with one character changed", slide: CANARY_IN_EVERY_RUN, replacements: (runs) => echoOf(runs, (text) => `${text.slice(0, -1)}X`) },
  { name: "echoes every run with a zero-width space inside the canary", slide: CANARY_IN_EVERY_RUN, replacements: (runs) => echoOf(runs, (text) => text.replace("Zqxv", "Zqxv\u200B")) },
  { name: "echoes every run in fullwidth characters", slide: CANARY_IN_EVERY_RUN, replacements: (runs) => echoOf(runs, toFullwidth) },
  { name: "echoes every run with the first letter as an entity reference", slide: CANARY_IN_EVERY_RUN, replacements: (runs) => echoOf(runs, (text) => `&#${text.codePointAt(0) ?? 0};${text.slice(1)}`) },
  { name: "wraps every run in markup", slide: CANARY_IN_EVERY_RUN, replacements: (runs) => echoOf(runs, (text) => `<b title="${text}">${text}</b>`) },
  { name: "pads every run with punctuation", slide: CANARY_IN_EVERY_RUN, replacements: (runs) => echoOf(runs, (text) => `— ${text}! —`) },
  { name: "is empty for every run", slide: CANARY_IN_EVERY_RUN, replacements: (runs) => echoOf(runs, () => "") },
  { name: "is whitespace for every run", slide: CANARY_IN_EVERY_RUN, replacements: (runs) => echoOf(runs, () => "  \n\t ") },
  { name: "names ids that belong to no run", slide: CANARY_IN_EVERY_RUN, replacements: (runs) => new Map(runs.map((run) => [`${run.id}x`, run.text])) },
  { name: "answers for only half the runs, echoing those", slide: CANARY_IN_EVERY_RUN, replacements: (runs) => new Map(runs.filter((_run, index) => index % 2 === 0).map((run) => [run.id, run.text])) },
  { name: "concatenates the whole slide into the first run", slide: CANARY_IN_EVERY_RUN, replacements: (runs) => new Map(runs.slice(0, 1).map((run) => [run.id, runs.map((other) => other.text).join(" ")])) },
  {
    // The one the per-run reading of the rejection rules would let through: the canary is not in
    // this run's own original at all, only in another run of the same slide.
    name: "moves one run's text into a different run",
    slide: CANARY_IN_ONE_RUN,
    replacements: (runs) => {
      const carrying = runs.find((run) => run.text.includes(CANARY));
      const other = runs.find((run) => !run.text.includes(CANARY));
      if (carrying === undefined || other === undefined) throw new Error("the one-run slide lost a run");
      return new Map([[other.id, carrying.text]]);
    },
  },
];

for (const hostile of HOSTILE_REPLIES) {
  test(`a hostile model reply leaks nothing: it ${hostile.name}`, () => {
    const input = hostile.slide(CANARY);
    assert.ok(containsCanary(input), `the "${hostile.name}" case does not actually plant the canary`);
    const runs = extractTextRuns({ html: input });
    const replacements = hostile.replacements(runs);
    for (const identifiers of ["preserve", "rename"] satisfies readonly IdentifierPolicy[]) {
      for (const textStrategy of STRATEGIES) {
        const result = anonymiseSlideHtml({ html: input, seed: SEED, identifiers, replacements, textStrategy });
        const where = `${hostile.name}, ${identifiers}, ${textStrategy.kind}`;
        assertNoCanary({ output: result.html, site: `hostile reply (${where})` });
        for (const run of result.textRuns) {
          assertNoCanary({ output: run.text, site: `the after column of ${run.id} (${where})` });
        }
      }
    }
  });
}

test("a hostile reply is REPORTED, so the user is told the run was gibberished rather than rewritten", () => {
  const input = CANARY_IN_EVERY_RUN(CANARY);
  const runs = extractTextRuns({ html: input });
  const result = anonymiseSlideHtml({
    html: input,
    seed: SEED,
    identifiers: "rename",
    replacements: echoOf(runs, (text) => text),
  });
  assert.deepEqual(result.rejectedReplacements.map((rejection) => rejection.runId).sort(), runs.map((run) => run.id).sort());
  for (const rejection of result.rejectedReplacements) assert.equal(rejection.reason, "unchanged");
  assert.deepEqual(result.textRuns.filter((run) => run.origin === "rewritten"), []);
  assert.equal(result.textRuns.length, runs.length);
});

test("a USEFUL reply still only moves the readable text: the canary is not in it to begin with", () => {
  // The positive control for the suite above. If this one failed, the hostile cases would be
  // passing because nothing is ever accepted, which would prove nothing at all.
  const input = CANARY_IN_ONE_RUN(CANARY);
  const runs = extractTextRuns({ html: input });
  const other = runs.find((run) => !run.text.includes(CANARY));
  assert.ok(other !== undefined);
  const result = anonymiseSlideHtml({
    html: input,
    seed: SEED,
    identifiers: "rename",
    replacements: new Map([[other.id, "Receipts hit £4,861,200"]]),
  });
  assert.deepEqual(result.rejectedReplacements, []);
  assert.ok(result.html.includes("Receipts hit £4,861,200"));
  assertNoCanary({ output: result.html, site: "a useful reply" });
});

/**
 * ============================================================================================
 *  THE AWKWARD RUNS. The lorem strategy is the DEFAULT now, so the inputs it has least room to
 *  work with are the ones worth pinning: a run that is only a figure, one that is only
 *  punctuation, one character, nothing but whitespace, a paragraph of a thousand words and a run
 *  held together by hard line breaks. Each asserts the canary is gone, the run is not its own
 *  original, and the one shape property that run's layout depends on.
 * ============================================================================================
 */
type AwkwardRun = Readonly<{
  name: string;
  body: string;
  /** The run's own original text, used to find it among the slide's runs. */
  original: string;
  /** Checked on the after text of every run of the slide, under every strategy. */
  shape: (options: Readonly<{ after: string; before: string }>) => void;
}>;

const LONG_PARAGRAPH = Array.from({ length: 1000 }, (_unused, index) => `word${index}`).join(" ");

const AWKWARD_RUNS: readonly AwkwardRun[] = [
  {
    name: "a run that is only a figure",
    body: "<td>£1,284,300</td>",
    original: "£1,284,300",
    shape: ({ after }) => {
      // The carve-out that matters most: a figure stays a figure, with its symbol, its separators
      // and its digit count — so its magnitude and its column width are unchanged.
      assert.match(after, /^£[1-9],\d{3},\d{3}$/, `a figure came out as ${JSON.stringify(after)}`);
    },
  },
  {
    name: "a run that is only a percentage",
    body: "<td>52%</td>",
    original: "52%",
    shape: ({ after }) => assert.match(after, /^[1-9]\d%$/),
  },
  {
    name: "a single character",
    body: "<span>A</span>",
    original: "A",
    shape: ({ after }) => assert.match(after, /^[A-Z]$/, `a single letter came out as ${JSON.stringify(after)}`),
  },
  {
    name: "a single digit",
    body: "<td>7</td>",
    original: "7",
    shape: ({ after }) => assert.match(after, /^[1-9]$/),
  },
  {
    name: "a very long paragraph",
    body: `<p>${LONG_PARAGRAPH}</p>`,
    original: LONG_PARAGRAPH,
    shape: ({ after, before }) =>
      assert.equal(after.split(/\s+/).length, before.split(/\s+/).length, "the word count moved"),
  },
  {
    name: "a run held together by hard line breaks",
    body: "<pre>Total spend\nby region\nand quarter</pre>",
    original: "Total spend\nby region\nand quarter",
    shape: ({ after, before }) =>
      assert.equal((after.match(/\n/g) ?? []).length, (before.match(/\n/g) ?? []).length, "a hard break moved"),
  },
  {
    name: "a sentence, which must still read as one",
    body: "<p>Total spend rose sharply this quarter.</p>",
    original: "Total spend rose sharply this quarter.",
    shape: ({ after }) => {
      assert.match(after, /^[A-Z]/, `the leading capital was lost: ${JSON.stringify(after)}`);
      assert.match(after, /\.$/, `the terminal full stop was lost: ${JSON.stringify(after)}`);
    },
  },
];

for (const awkward of AWKWARD_RUNS) {
  test(`an awkward run leaks nothing and keeps its shape: ${awkward.name}`, () => {
    const input = slide({ body: `${awkward.body}<p>${CANARY} elsewhere on the slide</p>` });
    const site = extractTextRuns({ html: input }).find((run) => run.text === awkward.original);
    assert.ok(site !== undefined, `the ${awkward.name} case has no run reading ${JSON.stringify(awkward.original)}`);
    for (const textStrategy of STRATEGIES) {
      const result = anonymiseSlideHtml({ html: input, seed: SEED, identifiers: "rename", textStrategy });
      assertNoCanary({ output: result.html, site: `${awkward.name} (${textStrategy.kind})` });
      const after = result.textRuns.find((run) => run.id === site.id);
      assert.ok(after !== undefined, `${awkward.name} lost its run under ${textStrategy.kind}`);
      assert.notEqual(after.text, site.text, `${awkward.name} came out as its original`);
      awkward.shape({ after: after.text, before: site.text });
      for (const run of result.textRuns) {
        assertNoCanary({ output: run.text, site: `${awkward.name} run ${run.id} (${textStrategy.kind})` });
      }
    }
  });
}

test("a run with nothing in it to replace is not a run at all, and comes out byte-identical", () => {
  // Only punctuation, only whitespace, an `&nbsp;`, a zero-width space: `hasSubstitutableCharacter`
  // is false for each, so `extractTextRuns` does not list it and nothing rewrites it. The
  // assertion is that it is still THERE — a dropped text node would move the layout.
  for (const body of ["<p>— · …</p>", "<p>   </p>", "<p>&nbsp;</p>", "<p>​</p>", "<p>{}[]()</p>", "<p>---</p>"]) {
    const input = slide({ body });
    const inner = body.replace(/^<p>|<\/p>$/g, "");
    assert.ok(
      !extractTextRuns({ html: input }).some((run) => run.text === inner),
      `${body} was listed as a run, so there is something in it to replace after all`,
    );
    for (const textStrategy of STRATEGIES) {
      const result = anonymiseSlideHtml({ html: input, seed: SEED, identifiers: "rename", textStrategy });
      assert.ok(result.html.includes(body), `${body} did not survive under ${textStrategy.kind}: ${result.html}`);
    }
  }
});

/** `Zqxvcanary` as `Ｚｑｘｖｃａｎａｒｙ`: the same word to a reader, different code points. */
function toFullwidth(text: string): string {
  return [...text]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x21 && code <= 0x7e ? String.fromCodePoint(code + 0xfee0) : character;
    })
    .join("");
}

/** Every encoding of the canary a recipient could decode, plus its distinctive fragments. */
function encodingsOf(canary: string): readonly string[] {
  return [
    canary,
    canary.toLowerCase(),
    canary.toUpperCase(),
    ...FRAGMENTS,
    Buffer.from(canary).toString("base64"),
    Buffer.from(canary).toString("base64url"),
    encodeURIComponent(canary),
    [...canary].map((character) => `&#${character.codePointAt(0) ?? 0};`).join(""),
    [...canary].map((character) => `&#x${(character.codePointAt(0) ?? 0).toString(16)};`).join(""),
  ];
}

function containsCanary(text: string): boolean {
  const haystack = text.toLowerCase();
  return encodingsOf(CANARY).some((needle) => haystack.includes(needle.toLowerCase()));
}

function assertNoCanary({ output, site }: { output: string; site: string }): void {
  const haystack = output.toLowerCase();
  const survivors = encodingsOf(CANARY).filter((needle) => haystack.includes(needle.toLowerCase()));
  assert.deepEqual(survivors, [], `LEAK in ${site}: ${survivors.join(", ")}`);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled canary expectation: ${String(value)}`);
}

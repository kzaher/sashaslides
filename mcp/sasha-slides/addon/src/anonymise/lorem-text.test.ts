import { test } from "node:test";
import assert from "node:assert/strict";
import { textAdvanceWidth, WIDTH_MODELS } from "./glyph-advance-widths.ts";
import { documentWordsOf, loremTexter, LOREM_VOCABULARY } from "./lorem-text.ts";
import { textSubstituter } from "./substitute-text.ts";
import { collectTextRunSites } from "./text-runs.ts";
import { tokenizeHtml } from "./html-tokens.ts";

const SEED = "lorem-tests-only-seed";

const texterFor = (documentText: string = "") =>
  loremTexter({
    seed: SEED,
    documentWords: documentWordsOf({ sites: collectTextRunSites({ tokens: tokenizeHtml(`<p>${documentText}</p>`) }) }),
    substituter: textSubstituter({ seed: SEED }),
  });

const lorem = texterFor();

/**
 * How far off the original's rendered width the lorem came out, as a fraction — the WORST of the
 * font models, because the slide uses one of them and this module cannot see which.
 */
function widthErrorOf(original: string): number {
  const written = lorem.plain(original);
  let worst = 0;
  for (const model of WIDTH_MODELS) {
    const want = textAdvanceWidth({ text: original, model });
    if (want === 0) continue;
    worst = Math.max(worst, Math.abs(textAdvanceWidth({ text: written, model }) - want) / want);
  }
  return worst;
}

const advanceWidthOf = (text: string): number => textAdvanceWidth({ text, model: "sans" });

const PROSE: readonly string[] = [
  "Q3 infrastructure spend",
  "Why the model never reads the slide back",
  "A candidate slide is a file on disk, not a blob of bytes.",
  "Illinois",
  "WWWWWWWW",
  "Total spend rose sharply this quarter.",
  "Write each candidate to a temp file.",
  "READY is written last; everything above it must already exist.",
  "appProperties.sashaSlides",
  "Northwind Holdings Ltd",
  "fixture 01 · text only",
];

test("THE POINT: width is matched, not character count", () => {
  // `Illinois` and `WWWWWWWW` are the same LENGTH and nowhere near the same width, so a
  // character-count match would put the same amount of text in both. The widths are what agree.
  const narrow = lorem.plain("Illinois");
  const wide = lorem.plain("WWWWWWWW");
  assert.ok(widthErrorOf("Illinois") < 0.1, `Illinois drifted ${(widthErrorOf("Illinois") * 100).toFixed(1)}%`);
  assert.ok(widthErrorOf("WWWWWWWW") < 0.1, `WWWWWWWW drifted ${(widthErrorOf("WWWWWWWW") * 100).toFixed(1)}%`);
  assert.notEqual(narrow.length, wide.length, "the same character count came back for both");
  assert.ok(advanceWidthOf(wide) > advanceWidthOf(narrow) * 1.5, "the wide one did not come back wider");
});

test("every run of prose lands within 10% of the original's rendered width, and 4% on average", () => {
  // Measured under the WORST font model per run, so these are upper bounds rather than averages:
  // the slide renders in ONE family and the error against that one is smaller. What this cannot
  // say is what the browser does with it — fidelity.e2e.ts measures that, and reports a worst
  // content-sized drift of 0.02-10.48px and a mean under 1.1px across the four fixtures.
  const errors = PROSE.map(widthErrorOf);
  const worst = Math.max(...errors);
  const mean = errors.reduce((sum, error) => sum + error, 0) / errors.length;
  const detail = PROSE.map((text, index) => `${((errors[index] ?? 0) * 100).toFixed(1)}% ${text}`).join("\n  ");
  assert.ok(worst < 0.1, `worst width error ${(worst * 100).toFixed(1)}%:\n  ${detail}`);
  assert.ok(mean < 0.04, `mean width error ${(mean * 100).toFixed(1)}%:\n  ${detail}`);
});

test("WHITESPACE IS BYTE-IDENTICAL: every space, indent and hard line break stays where it was", () => {
  for (const original of [
    "Total spend\nby region\nand quarter",
    "  leading and trailing  ",
    "double  spaced   words",
    "\n    indented\n    lines\n  ",
    "tabs\tand\tnewlines\n",
  ]) {
    const written = lorem.plain(original);
    assert.deepEqual(whitespaceSkeletonOf(written), whitespaceSkeletonOf(original), JSON.stringify(original));
    assert.equal((written.match(/\n/g) ?? []).length, (original.match(/\n/g) ?? []).length);
  }
});

test("DIGITS STAY DIGITS, with the same magnitude, separators and symbol", () => {
  assert.match(lorem.plain("£1,284,300"), /^£[1-9],\d{3},\d{3}$/);
  assert.notEqual(lorem.plain("£1,284,300"), "£1,284,300");
  assert.match(lorem.plain("52%"), /^[1-9]\d%$/);
  assert.match(lorem.plain("1,842"), /^[1-9],\d{3}$/);
  assert.match(lorem.plain("-4.5pt"), /^-[0-9]\.[0-9][a-z]{2}$/);
  // A word with a digit in it is substituted whole rather than half-loremised, so `Q3` cannot
  // become `Quis3` and a figure cannot be split away from its unit.
  assert.match(lorem.plain("Q3"), /^[A-Z][1-9]$/);
  assert.match(lorem.plain("Rev. 7.3.1-beta"), /^[A-Z][a-z]{2}\. [0-9]\.[0-9]\.[0-9]-[a-z]{4}$/);
  // The whole point of the carve-out: a table of figures stays a table of figures.
  for (const figure of ["1,842", "2,301", "412", "118", "4,673"]) {
    assert.match(lorem.plain(figure), /^[1-9][\d,]*$/, figure);
    assert.equal(lorem.plain(figure).length, figure.length, figure);
  }
});

test("a short run gets a word, not a sentence", () => {
  for (const label of ["Bytes", "slide", "manifest", "ready", "Send", "Glass"]) {
    const written = lorem.plain(label);
    assert.equal(written.split(/\s+/).length, 1, `${label} came back as ${JSON.stringify(written)}`);
    assert.doesNotMatch(written, /[.!?]/, `${label} acquired punctuation`);
  }
});

test("sentence shape survives: leading capital, terminal punctuation, ALL-CAPS and Title Case", () => {
  const sentence = lorem.plain("Total spend rose sharply this quarter.");
  assert.match(sentence, /^[A-Z]/);
  assert.match(sentence, /\.$/);
  assert.equal(sentence.split(/\s+/).length, 6);
  assert.match(lorem.plain("READY"), /^[A-Z]+$/);
  assert.match(lorem.plain("Drive name"), /^[A-Z][a-z]+ [a-z]+$/);
  assert.match(lorem.plain("Everything Slides"), /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  // Punctuation inside a chunk is re-emitted verbatim, so the word's shape reads the same.
  assert.match(lorem.plain("cost-benefit"), /^[a-z]+-[a-z]+$/);
  assert.match(lorem.plain("(parenthesised),"), /^\([a-z]+\),$/);
});

test("it is deterministic: same text and seed in, same lorem out; a different seed, different lorem", () => {
  assert.equal(lorem.plain("Q3 infrastructure spend"), lorem.plain("Q3 infrastructure spend"));
  assert.equal(texterFor().plain("Q3 infrastructure spend"), lorem.plain("Q3 infrastructure spend"));
  const other = loremTexter({
    seed: "a-completely-different-seed",
    documentWords: new Set<string>(),
    substituter: textSubstituter({ seed: "a-completely-different-seed" }),
  });
  assert.notEqual(other.plain("Q3 infrastructure spend"), lorem.plain("Q3 infrastructure spend"));
});

test("NO LOREM WORD IS ONE OF THE SLIDE'S OWN, which is also why no run can be its original", () => {
  // A slide written IN lorem ipsum is the adversarial case: every candidate is one of its words.
  const latin = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor";
  const texter = texterFor(latin);
  const written = texter.plain(latin);
  assert.notEqual(written, latin);
  for (const word of latin.toLowerCase().split(/\s+/)) {
    assert.doesNotMatch(written.toLowerCase(), new RegExp(`\\b${word}\\b`), `${word} came back`);
  }
});

test("a slide holding the WHOLE vocabulary falls back to substitution rather than to the original", () => {
  const everything = LOREM_VOCABULARY.join(" ");
  const texter = texterFor(everything);
  const written = texter.plain("Northwind infrastructure spend");
  assert.notEqual(written, "Northwind infrastructure spend");
  assert.doesNotMatch(written, /Northwind|infrastructure|spend/i);
  // The substituter's own guarantee: same length, every letter changed.
  assert.equal(written.length, "Northwind infrastructure spend".length);
});

test("the document's vocabulary is folded, so a fullwidth or accented word still bans its candidate", () => {
  const words = documentWordsOf({
    sites: collectTextRunSites({ tokens: tokenizeHtml("<p>Ｌｏｒｅｍ</p><p>Dólor</p><p>IPSUM</p>") }),
  });
  assert.ok(words.has("lorem"));
  assert.ok(words.has("dolor"));
  assert.ok(words.has("ipsum"));
});

test("a non-Latin script is substituted inside its own block instead of becoming Latin", () => {
  for (const original of ["流量の報告", "Сбербанк", "Équipe française"]) {
    const written = lorem.plain(original);
    assert.notEqual(written, original);
    assert.equal(written.length, original.length, original);
    assert.doesNotMatch(written, /lorem|ipsum|dolor/i, original);
  }
});

test("a token wider than any single lorem word is concatenated, and stays one unbreakable token", () => {
  const long = "Unternehmensberatungsgesellschaft";
  const written = lorem.plain(long);
  assert.equal(written.split(/\s+/).length, 1, `it was broken into words: ${written}`);
  assert.ok(widthErrorOf(long) < 0.08, `${long} drifted ${(widthErrorOf(long) * 100).toFixed(1)}%`);
});

test("the vocabulary is lowercase ASCII, which is what the casing and the width table assume", () => {
  for (const word of LOREM_VOCABULARY) {
    assert.match(word, /^[a-z]{2,}$/, word);
  }
  assert.equal(new Set(LOREM_VOCABULARY).size, LOREM_VOCABULARY.length, "the vocabulary has duplicates");
});

/** Each run of whitespace verbatim, with the words between them reduced to a marker. */
function whitespaceSkeletonOf(text: string): string {
  return text.replace(/\S+/g, "w");
}

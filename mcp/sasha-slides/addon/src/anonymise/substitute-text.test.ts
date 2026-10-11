import { test } from "node:test";
import assert from "node:assert/strict";
import { hasSubstitutableCharacter, textSubstituter } from "./substitute-text.ts";

const SEED = "seed-for-the-tests-only";
const substituter = textSubstituter({ seed: SEED });

test("THE INVARIANT: no letter and no digit ever survives at its own position", () => {
  const inputs = [
    "Q3 infrastructure spend",
    "£1,284,300",
    "52%",
    "ACME Corporation Ltd",
    "a",
    "I",
    "john.doe@acme-holdings.co.uk",
    "+44 20 7946 0958",
    "Rev. 7.3.1-beta",
    "Équipe française",
    "Сбербанк",
    "四半流量",
    "スライド",
    "MMM www",
  ];
  for (const input of inputs) {
    const output = substituter.plain(input);
    assert.equal(output.length, input.length, `length changed for ${input}`);
    for (let index = 0; index < input.length; index += 1) {
      const original = input.charAt(index);
      if (!/[\p{L}\p{N}]/u.test(original)) {
        assert.equal(output.charAt(index), original, `punctuation moved in ${input} at ${index}`);
        continue;
      }
      assert.notEqual(output.charAt(index), original, `"${original}" survived in ${input} at ${index}`);
    }
  }
});

test("case, digit-ness and glyph-width class are preserved per character", () => {
  const output = substituter.plain("Infrastructure MW il 2024");
  assert.match(output, /^[A-Z][a-z]{13} [A-Z]{2} [a-z]{2} \d{4}$/);
  // "il" are the two narrowest lowercase glyphs: they can only become each other or "j".
  assert.match(output.slice(18, 20), /^[ijl]{2}$/);
  assert.match(output.slice(15, 17), /^[MW]{2}$/);
});

test("a number keeps its separators, its digit count and therefore its magnitude", () => {
  const amount = substituter.plain("£1,284,300.57");
  assert.match(amount, /^£[1-9],\d{3},\d{3}\.\d{2}$/);
  assert.notEqual(amount, "£1,284,300.57");
  assert.match(substituter.plain("52%"), /^[1-9]\d%$/);
  // A leading zero cannot be kept: a `0` that stayed `0` would be a digit surviving at its own
  // position. The digit COUNT is what the layout depends on, and that is exact.
  assert.match(substituter.plain("007"), /^[1-9]\d\d$/);
  // Interior zeros are still reachable, so a number does not come back visibly zero-free.
  const manyRuns = Array.from({ length: 40 }, (_unused, index) => substituter.plain(`1${index}00000`));
  assert.ok(manyRuns.some((value) => value.includes("0")), "no interior zero in 40 substituted numbers");
});

test("the same input always gives the same output, so CSS attribute selectors keep matching", () => {
  assert.equal(substituter.plain("warn"), substituter.plain("warn"));
  const fresh = textSubstituter({ seed: SEED });
  assert.equal(fresh.plain("warn"), substituter.plain("warn"));
});

test("a different seed gives a different substitution: the seed is the key", () => {
  const other = textSubstituter({ seed: "a-completely-different-seed" });
  assert.notEqual(other.plain("Q3 infrastructure spend"), substituter.plain("Q3 infrastructure spend"));
});

test("it is not a mono-alphabetic cipher: the same letter maps differently in different runs", () => {
  const mappings = new Set(
    ["alpha", "alpine", "altern", "almost", "alcove", "albumen", "alright", "already"].map(
      (word) => substituter.plain(word).charAt(0),
    ),
  );
  assert.ok(mappings.size > 1, `"a" mapped to one single letter across eight runs: ${[...mappings].join("")}`);
});

test("text with nothing to replace comes back as the same bytes, so whitespace never moves", () => {
  for (const input of ["", "\n    ", " \t\n", "— · …", "---", "{}[]()"]) {
    assert.equal(substituter.plain(input), input);
    assert.equal(hasSubstitutableCharacter(input), false);
  }
});

test("entity references that denote letters are decoded first, so they are not a way past the pass", () => {
  // "ACME" written as numeric references: a naive literal pass walks straight past this.
  const hidden = substituter.htmlText("&#65;&#67;&#77;&#69;");
  assert.doesNotMatch(hidden, /ACME/);
  assert.doesNotMatch(hidden, /&#65;|&#67;|&#77;|&#69;/);
  assert.match(hidden, /^[A-Z]{4}$/);

  const accented = substituter.htmlText("caf&eacute;");
  assert.doesNotMatch(accented, /caf/);
  assert.doesNotMatch(accented, /&eacute;/);
});

test("entity references that denote punctuation are re-emitted as the same bytes", () => {
  assert.equal(substituter.htmlText("&middot;&mdash;&nbsp;"), "&middot;&mdash;&nbsp;");
  const mixed = substituter.htmlText("fixture 01 &middot; text only");
  assert.match(mixed, / &middot; /);
  assert.equal(mixed.length, "fixture 01 &middot; text only".length);
});

test("character data and attribute values are escaped for where they are going", () => {
  assert.match(substituter.htmlText("a<b>c&d"), /^.&lt;.&gt;.&amp;.$/);
  assert.equal(substituter.htmlAttributeValue({ raw: "&quot;", quote: '"' }), "&quot;");
});

test("a URL keeps its scheme and loses everything after it", () => {
  const link = substituter.url("https://acme-holdings.example.com/q3/revenue.pdf?id=99");
  assert.ok(link.startsWith("https://"));
  assert.doesNotMatch(link, /acme|holdings|revenue/i);
  assert.equal(link.length, "https://acme-holdings.example.com/q3/revenue.pdf?id=99".length);
  assert.ok(substituter.url("mailto:a.mcbride@acme.com").startsWith("mailto:"));
  // No scheme: the whole thing is just text.
  assert.doesNotMatch(substituter.url("../assets/logo.png"), /assets|logo/);
});

test("a non-Latin character is replaced within its own script, so the glyph width holds", () => {
  const japanese = substituter.plain("流量の報告");
  for (const character of japanese) {
    const code = character.codePointAt(0) ?? 0;
    assert.ok(
      (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3041 && code <= 0x3096),
      `${character} left the CJK/Hiragana blocks`,
    );
  }
  const cyrillic = substituter.plain("Сбер");
  for (const character of cyrillic) {
    const code = character.codePointAt(0) ?? 0;
    assert.ok(code >= 0x0400 && code <= 0x04ff, `${character} left the Cyrillic block`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anonymiseCss, anonymiseInlineStyle, scanCss, serializeCssPieces, type CssRewrites } from "./anonymise-css.ts";
import { textSubstituter } from "./substitute-text.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../e2e/fixtures");

const rewrites: CssRewrites = {
  substituter: textSubstituter({ seed: "css-test-seed" }),
  rewriteUrl: () => "REWRITTEN",
  renameSelectorIdentifier: ({ name }) => name,
};

/** Every piece copied through: the scanner's own round-trip, with no transform in the way. */
const identity: CssRewrites = {
  substituter: { plain: (text) => text, htmlText: (text) => text, htmlAttributeValue: ({ raw }) => raw, url: (value) => value },
  rewriteUrl: (url) => url,
  renameSelectorIdentifier: ({ name }) => name,
};

test("the scanner hands back every byte of every real fixture's stylesheet", () => {
  for (const name of readdirSync(FIXTURES).filter((file) => file.endsWith(".html"))) {
    const html = readFileSync(join(FIXTURES, name), "utf-8");
    for (const css of [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((found) => found[1] ?? "")) {
      assert.equal(serializeCssPieces(scanCss(css)), css, name);
      // With an identity substituter the whole transform is the identity, except for comments,
      // which are removed unconditionally.
      assert.equal(anonymiseCss({ css, rewrites: identity }), css.replace(/\/\*[\s\S]*?\*\//g, ""), name);
    }
  }
});

test("geometry, colours and font names come out byte-identical", () => {
  const css = `.card { width: 320px; height: 1.5em; color: #1b1b1f; font-family: "Helvetica Neue", Arial, sans-serif; box-shadow: 0 26px 60px rgba(4,8,28,.52); }`;
  assert.equal(anonymiseCss({ css, rewrites }), css);
});

test("a content string is substituted; the layout strings next to it are not", () => {
  const out = anonymiseCss({
    css: `.a::before { content: "Q3 actuals"; } .g { grid-template-areas: "head head" "side main"; quotes: "<<" ">>"; }`,
    rewrites,
  });
  assert.doesNotMatch(out, /Q3 actuals/);
  assert.match(out, /content: "[^"]{10}"/);
  assert.match(out, /grid-template-areas: "head head" "side main"/);
  assert.match(out, /quotes: "<<" ">>"/);
});

test("an attribute selector's string gets the SAME substitution the attribute value gets", () => {
  const value = rewrites.substituter.plain("warn");
  const out = anonymiseCss({ css: `[data-tone="warn"] { color: red; }`, rewrites });
  assert.equal(out, `[data-tone="${value}"] { color: red; }`);
});

test("a comment is removed, including one that hides content inside a rule", () => {
  const out = anonymiseCss({ css: `/* figures from the Q3 board pack */ .a { /* owner: a.mcbride */ color: red }`, rewrites });
  assert.doesNotMatch(out, /Q3 board pack|mcbride/);
  assert.match(out, /color: red/);
});

test("every url() goes through the caller's rewrite, quoted or not, wherever it sits", () => {
  const out = anonymiseCss({
    css: `@font-face { src: url(a.woff2); } .a { background: url("b.png") no-repeat; } .b { fill: url(#grad); }`,
    rewrites,
  });
  assert.equal((out.match(/REWRITTEN/g) ?? []).length, 3);
});

test("declaration context is tracked through at-rules, so a nested rule's strings are found", () => {
  const out = anonymiseCss({
    css: `@media (min-width: 100px) { .a::after { content: "Acme"; font-family: "Acme Sans"; } }`,
    rewrites,
  });
  assert.doesNotMatch(out, /content: "Acme"/);
  assert.match(out, /font-family: "Acme Sans"/);
});

test("a custom property's string value is substituted, and consistently, so var() still resolves", () => {
  const out = anonymiseCss({ css: `:root { --label: "Acme"; } .a::before { content: var(--label); }`, rewrites });
  assert.doesNotMatch(out, /Acme/);
  assert.match(out, /content: var\(--label\)/);
});

test("an inline style attribute is entered in declaration context", () => {
  assert.equal(anonymiseInlineStyle({ declarations: "width:320px;color:#fff", rewrites }), "width:320px;color:#fff");
  const out = anonymiseInlineStyle({ declarations: `content:"Acme";background:url(x)`, rewrites });
  assert.doesNotMatch(out, /Acme/);
  assert.match(out, /url\(REWRITTEN\)/);
});

test("selector identifiers are renamed, and a colour literal in a declaration is not", () => {
  const renaming: CssRewrites = { ...rewrites, renameSelectorIdentifier: ({ sigil, name }) => `${sigil === "." ? "c" : "i"}-${name}` };
  const out = anonymiseCss({ css: `.card #hero { color: #1b1b1f; border: 1px solid #fff }`, rewrites: renaming });
  assert.equal(out, `.c-card #i-hero { color: #1b1b1f; border: 1px solid #fff }`);
});

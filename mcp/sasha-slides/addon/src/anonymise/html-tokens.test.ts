import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attributeNamed, serializeHtmlTokens, tokenizeHtml, withAttributeValue } from "./html-tokens.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../e2e/fixtures");

test("every real fixture round-trips byte for byte", () => {
  const names = readdirSync(FIXTURES).filter((name) => name.endsWith(".html"));
  assert.ok(names.length >= 4, `expected the four candidate fixtures, found ${names.length}`);
  for (const name of names) {
    const html = readFileSync(join(FIXTURES, name), "utf-8");
    assert.equal(serializeHtmlTokens(tokenizeHtml(html)), html, name);
  }
});

test("the awkward markup round-trips too: that is the whole contract", () => {
  const cases = [
    "",
    "plain text",
    "a < b",
    "a <3 b",
    "<!doctype html>",
    "<!-- comment -->",
    "<!-- unterminated",
    "<?xml version='1.0'?>",
    "<![CDATA[ raw < > & ]]>",
    "<div>",
    "</div>",
    "</div   >",
    "<br/>",
    "<br />",
    "<img src=x>",
    "<img src=x alt>",
    "<img\n  src = 'x'\n  alt=\"y\"\n>",
    "<div class='a' data-x=\"1\" hidden>text</div>",
    "<div data-json='{\"a\":1}'>",
    "<style>body { content: '</div>'; }</style>",
    "<style>a{b:c}",
    "<script>if (1<2) { x = '</div>' }</script>",
    "<title>T &amp; T</title>",
    "<textarea> leading\n  space </textarea>",
    "<svg><text>hi</text></svg>",
    "<p>&amp;&#65;&nbsp;&unknownthing;</p>",
    "<div   >",
    "<DIV CLASS=X>",
    "<div/ >",
    "<input value=a/b>",
  ];
  for (const html of cases) assert.equal(serializeHtmlTokens(tokenizeHtml(html)), html, JSON.stringify(html));
});

test("a raw-text element's body is one token and is never parsed as markup", () => {
  const tokens = tokenizeHtml("<style>a{content:'<b>'}</style>");
  assert.deepEqual(
    tokens.map((token) => token.kind),
    ["start-tag", "raw-text", "end-tag"],
  );
  const body = tokens[1];
  assert.ok(body !== undefined && body.kind === "raw-text");
  assert.equal(body.text, "a{content:'<b>'}");
});

test("attribute names are matched case-insensitively and values keep their source quoting", () => {
  const tokens = tokenizeHtml("<img SRC='a' ALT=bare>");
  const tag = tokens[0];
  assert.ok(tag !== undefined && tag.kind === "start-tag");
  assert.equal(attributeNamed({ token: tag, name: "src" })?.value, "a");
  assert.equal(attributeNamed({ token: tag, name: "alt" })?.quote, "");
  assert.equal(attributeNamed({ token: tag, name: "missing" }), null);
});

test("a rewritten value is escaped, and an unquoted one is promoted to quotes", () => {
  const tokens = tokenizeHtml("<img alt=bare>");
  const tag = tokens[0];
  assert.ok(tag !== undefined && tag.kind === "start-tag");
  const attribute = attributeNamed({ token: tag, name: "alt" });
  assert.ok(attribute !== null);
  const rewritten = withAttributeValue({ attribute, value: 'has "quotes" & <angles>' });
  assert.equal(rewritten.quote, '"');
  assert.equal(rewritten.value, "has &quot;quotes&quot; &amp; &lt;angles&gt;");
  assert.equal(
    serializeHtmlTokens([{ ...tag, attributes: [rewritten] }]),
    '<img alt="has &quot;quotes&quot; &amp; &lt;angles&gt;">',
  );
});

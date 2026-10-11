// THE ELEMENT INSPECTOR, asserted without a browser.
//
// Two things are under test and the order follows the code's: the component (rendered with
// react-dom/server, so every state of the view union is checked as markup) and the pretty-printer,
// which is a hand-written tokenizer precisely so it can be hammered here -- no DOMParser, no
// `document`, nothing that would also mean EXECUTING the untrusted markup it formats.

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ELEMENT_INSPECTOR_CSS,
  ElementInspector,
  type ElementInspectorProps,
  draftTextFor,
  formatMarkup,
  tagNameOf,
} from "./element-inspector.tsx";

/** The props a test does not care about, so each test states only what it is about. */
function render(props: Partial<ElementInspectorProps>): string {
  return renderToStaticMarkup(
    createElement(ElementInspector, {
      html: null,
      selector: null,
      disabled: false,
      onApply: () => {},
      ...props,
    }),
  );
}

test("nothing selected is ONE quiet line -- no empty textarea and no dead buttons", () => {
  const markup = render({ html: null, selector: null });
  assert.match(markup, /Select an element on the slide/);
  assert.ok(!markup.includes("<textarea"), markup);
  assert.ok(!markup.includes("<button"), markup);
});

test("a selected element shows the tag in bold and the selector in full in its title", () => {
  const selector = "section > div:nth-of-type(2) > span.caption";
  const markup = render({ html: '<div class="box">Hello</div>', selector });
  assert.match(markup, /<strong class="sasha-ei-tag">div<\/strong>/);
  // The visible selector is clipped by CSS, so the untruncated value has to be reachable.
  assert.ok(markup.includes(`title="${escapeMarkup(selector)}"`), markup);
  assert.match(markup, /class="sasha-ei-selector"/);
  assert.match(ELEMENT_INSPECTOR_CSS, /\.sasha-ei-selector \{[\s\S]*text-overflow: ellipsis/);
});

test("the textarea is monospace and holds the PRETTY-PRINTED markup, not the raw string", () => {
  const html = "<ul><li>One</li><li>Two</li></ul>";
  const markup = render({ html, selector: "ul" });
  assert.match(markup, /<textarea[^>]*class="sasha-ei-markup"/);
  // React writes a textarea's value as its text child; both are escaped, which is the point.
  assert.ok(markup.includes(escapeMarkup(formatMarkup(html))), markup);
  assert.ok(!markup.includes(escapeMarkup(html)), "the raw one-line markup should not be what is shown");
  assert.match(ELEMENT_INSPECTOR_CSS, /\.sasha-ei-markup \{[\s\S]*ui-monospace/);
});

test("Apply and Revert are disabled while the text is unchanged", () => {
  const markup = render({ html: "<p>Hi</p>", selector: "p" });
  assert.match(markup, /class="sasha-ei-apply" disabled=""/);
  assert.match(markup, /class="sasha-ei-revert" disabled=""/);
});

test("`disabled` disables the field and both buttons, so nothing can be committed mid-flight", () => {
  const markup = render({ html: "<p>Hi</p>", selector: "p", disabled: true });
  assert.match(markup, /<textarea[^>]*disabled=""/);
  assert.equal(countOf({ haystack: markup, needle: 'disabled=""' }), 3);
});

test("the stylesheet fragment can be spliced into PICKER_CSS, which is one template literal", () => {
  assert.ok(!ELEMENT_INSPECTOR_CSS.includes("`"), "a backtick would terminate PICKER_CSS");
  assert.ok(!ELEMENT_INSPECTOR_CSS.includes("${"), "a dollar-brace would interpolate inside PICKER_CSS");
});

test("UNTRUSTED MARKUP NEVER REACHES AN EXECUTABLE POSITION", () => {
  const hostile = '<script>alert(1)</script>';
  const markup = render({ html: hostile, selector: "script" });
  // Not one `<script` survives: the string is a textarea value and text children, both escaped.
  assert.ok(!markup.includes("<script"), markup);
  assert.ok(markup.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), markup);
});

test("an event-handler attribute and a javascript: url come out as text too", () => {
  const hostile = '<img src="x" onerror="alert(1)"><a href="javascript:alert(2)">go</a>';
  const markup = render({ html: hostile, selector: "img" });
  // The substrings below would BE the live attribute; escaped, every quote is a `&quot;` entity.
  assert.ok(!markup.includes('onerror="'), markup);
  assert.ok(!markup.includes('href="javascript:'), markup);
  assert.match(markup, /onerror=&quot;alert\(1\)&quot;/);
  assert.match(markup, /href=&quot;javascript:alert\(2\)&quot;/);
});

test("formatMarkup puts one tag per line and indents nesting by two spaces", () => {
  assert.equal(
    formatMarkup('<section><div class="a"><span>Hi</span></div></section>'),
    ['<section>', '  <div class="a">', "    <span>Hi</span>", "  </div>", "</section>"].join("\n"),
  );
});

test("void and self-closed elements are leaves -- they never open an indent level", () => {
  assert.equal(
    formatMarkup('<p>Line one<br>Line two<img src="x.png" alt="An image"></p>'),
    ["<p>", "  Line one", "  <br>", "  Line two", '  <img src="x.png" alt="An image">', "</p>"].join("\n"),
  );
  // An XML-style self-close keeps its slash, so SVG markup round-trips as written.
  assert.equal(formatMarkup('<svg><circle r="1"/></svg>'), ["<svg>", '  <circle r="1" />', "</svg>"].join("\n"));
});

test("a SHORT text child stays on the tag's line; a long one breaks onto its own", () => {
  assert.equal(formatMarkup('<h1 class="title">Short title</h1>'), '<h1 class="title">Short title</h1>');
  assert.equal(formatMarkup("<p></p>"), "<p></p>");
  const long = "word ".repeat(30).trim();
  assert.equal(formatMarkup(`<p>${long}</p>`), ["<p>", `  ${long}`, "</p>"].join("\n"));
});

test("a `>` inside a quoted attribute value does not end the tag", () => {
  assert.equal(formatMarkup(`<div data-tip="a > b" title='x > y'>ok</div>`), `<div data-tip="a > b" title='x > y'>ok</div>`);
  // Same rule one level in, where a split tag would also corrupt the indent.
  assert.equal(
    formatMarkup('<div><span data-rule="x>y"><b>1</b></span></div>'),
    ["<div>", '  <span data-rule="x>y">', "    <b>1</b>", "  </span>", "</div>"].join("\n"),
  );
});

test("an attribute list spread over several lines collapses to one tag line", () => {
  assert.equal(formatMarkup('<div\n   class="a"\n   id="b"\n>x</div>'), '<div class="a" id="b">x</div>');
});

test("formatting is IDEMPOTENT -- formatting formatted markup changes nothing", () => {
  const samples: readonly string[] = [
    '<section><div class="a"><span>Hi</span></div></section>',
    '<p>Line one<br>Line two<img src="x.png" alt="An image"></p>',
    '<h1 class="title">Short title</h1>',
    `<p>${"word ".repeat(30).trim()}</p>`,
    `<div data-tip="a > b" title='x > y'>ok</div>`,
    "<ul>\n  <li>One</li>\n  <li>Two</li>\n</ul>",
    "<p>Hello <b>world</b></p>",
    "<pre>  keep\n    this</pre>",
    '<div>text<script>if (a < b) { return "x"; }</script></div>',
    "<!DOCTYPE html><div><!-- note --></div>",
    "<div></div>",
    "",
  ];
  for (const sample of samples) {
    const once = formatMarkup(sample);
    assert.equal(formatMarkup(once), once, `not idempotent for ${JSON.stringify(sample)}`);
    // And stable a third time, which is what the component relies on when it re-formats per render.
    assert.equal(formatMarkup(formatMarkup(once)), once);
  }
});

test("already-formatted markup comes back byte for byte", () => {
  const formatted = ["<ul>", "  <li>One</li>", "  <li>Two</li>", "</ul>"].join("\n");
  assert.equal(formatMarkup(formatted), formatted);
});

test("raw-text elements keep their body verbatim -- a `<` in a script is not a tag", () => {
  assert.equal(
    formatMarkup('<div>text<script>if (a < b) { return "</div>"; }</script></div>'),
    ["<div>", "  text", '  <script>if (a < b) { return "</div>"; }</script>', "</div>"].join("\n"),
  );
  // <pre> keeps its own indentation, which is why a raw body is never indented by the formatter.
  assert.equal(formatMarkup("<pre>  keep\n    this</pre>"), ["<pre>", "  keep", "    this", "</pre>"].join("\n"));
});

test("whitespace between tags is layout and is dropped; a space inside text survives", () => {
  assert.equal(formatMarkup("<div>\n\n   <span>a</span>\n\n</div>"), ["<div>", "  <span>a</span>", "</div>"].join("\n"));
  assert.equal(formatMarkup("<b>  spaced   out  </b>"), "<b> spaced out </b>");
});

test("doctypes and comments get their own line", () => {
  assert.equal(
    formatMarkup("<!DOCTYPE html><div><!-- note --></div>"),
    ["<!DOCTYPE html>", "<div>", "  <!-- note -->", "</div>"].join("\n"),
  );
});

test("broken markup still formats: unclosed tags close, stray close tags are dropped", () => {
  assert.equal(formatMarkup("<div><span>a</div>"), ["<div>", "  <span>a</span>", "</div>"].join("\n"));
  assert.equal(formatMarkup("</div><p>stray</p>"), "<p>stray</p>");
  assert.equal(formatMarkup('<div class="x"'), '<div class="x"></div>');
});

test("a prose `<` is text, not a broken tag", () => {
  assert.equal(formatMarkup("a < b"), "a < b");
  assert.equal(formatMarkup("<p>1 < 2 and 3 > 2</p>"), "<p>1 < 2 and 3 > 2</p>");
});

test("tagNameOf names the outermost element, lowercased, and says `text` when there is none", () => {
  assert.equal(tagNameOf('<DIV class="a">x</DIV>'), "div");
  assert.equal(tagNameOf("<br>"), "br");
  assert.equal(tagNameOf("<style>a{}</style>"), "style");
  assert.equal(tagNameOf("<!-- just a note --><p>x</p>"), "p");
  assert.equal(tagNameOf("plain words"), "text");
  assert.equal(tagNameOf(""), "text");
});

test("a draft typed against another selection is discarded, not carried over", () => {
  const draft = { key: "p#one\u0000<p>typed</p>", text: "<p>half-finished</p>" } as const;
  assert.equal(draftTextFor({ draft, key: draft.key, baseline: "<p>typed</p>" }), "<p>half-finished</p>");
  assert.equal(draftTextFor({ draft, key: "p#two\u0000<p>other</p>", baseline: "<p>other</p>" }), "<p>other</p>");
});

test("two siblings with identical markup are still different selections", () => {
  const first = render({ html: "<li>Same</li>", selector: "ul > li:nth-of-type(1)" });
  const second = render({ html: "<li>Same</li>", selector: "ul > li:nth-of-type(2)" });
  assert.ok(first.includes('title="ul &gt; li:nth-of-type(1)"'), first);
  assert.ok(second.includes('title="ul &gt; li:nth-of-type(2)"'), second);
});

/** What React's escaping does to a string it renders as text, so an expectation can name it. */
function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function countOf(options: Readonly<{ haystack: string; needle: string }>): number {
  return options.haystack.split(options.needle).length - 1;
}

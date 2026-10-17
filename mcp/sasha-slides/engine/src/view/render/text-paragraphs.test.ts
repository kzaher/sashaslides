// LISTS AND SOFT LINE BREAKS as the static renderer draws them. Found by the reverse round trip
// (Google Slides -> import -> engine HTML -> screenshot, renderer/html2slides/reverse-sxs.sh):
//  * test deck slide 8: a list with Slides' default indents (start 36 points, first line 18,
//    imported as 64 / -32 units) drew its marker over the "A" of "Approve" and every line 32
//    units right of Slides', because the engine added its own list gutter on top of them;
//  * complex fixture 30: Slides' blue, red, green and orange dots came out grey, because the
//    marker could only copy the text's style;
//  * complex fixture 24: "containers.\v\v Each level" drew two missing-glyph boxes on one line.
// Each row states the layout Slides draws; a control row holds the engine's own lists unchanged.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TextBody } from "../../contracts/document.ts";
import { listMarkerColour, type ListMarkerColour, type ListMembership, type ParagraphStylePatch } from "../../contracts/style.ts";
import { documentSnapshot, fixtureDeckId, createPrefixedIdMinter, paragraph, run, textBody } from "../../contracts/testing/snapshot-builders.ts";
import { colourValue } from "./inline-styles.ts";
import { LIST_INDENT_PER_LEVEL } from "./text-layout.ts";
import { listLayout, TextParagraphs } from "./text-paragraphs.tsx";

const ids = createPrefixedIdMinter("TextParagraphs");
const THEME = documentSnapshot({ deckId: fixtureDeckId("text-paragraphs"), title: "Lists", slides: [] }).theme;

describe("a list paragraph's marker and text positions", () => {
  // Columns: label, indents, level, expected [paragraph start padding, first line indent, marker start, marker width].
  // A hanging list's marker is right-aligned to end at indentStart + indentFirstLine (see text-paragraphs.tsx).
  const rows: readonly Readonly<{ label: string; style: ParagraphStylePatch; level: number; expected: readonly number[] }>[] = [
    { label: "engine list, level 0 (control: the gutter)", style: {}, level: 0, expected: [LIST_INDENT_PER_LEVEL, 0, 0, LIST_INDENT_PER_LEVEL] },
    { label: "engine list, level 2 (control: the gutter)", style: {}, level: 2, expected: [3 * LIST_INDENT_PER_LEVEL, 0, 2 * LIST_INDENT_PER_LEVEL, LIST_INDENT_PER_LEVEL] },
    { label: "deck slide 8: Slides' default 36 / 18 points, hanging: the marker ends at 32", style: { indentStart: 64, indentFirstLine: -32 }, level: 0, expected: [64, 0, 0, 32] },
    { label: "complex 30: start 12 points, first line 3.375: the marker ends at 6", style: { indentStart: 21.333, indentFirstLine: -15.333 }, level: 0, expected: [21.333, 0, -26, 32] },
    { label: "Slides level 1 keeps its own indents, no gutter per level", style: { indentStart: 128, indentFirstLine: -32 }, level: 1, expected: [128, 0, 64, 32] },
    { label: "a first line indented past the start: the text follows the marker by a gutter", style: { indentStart: 20, indentFirstLine: 10 }, level: 0, expected: [20, 10 + LIST_INDENT_PER_LEVEL, 30, LIST_INDENT_PER_LEVEL] },
  ];
  for (const row of rows) {
    it(row.label, () => {
      const markup = paragraphsMarkup(textBody([paragraph([run("Approve budget")], { ...row.style, list: membership({ level: row.level }) })]));
      const [padding, textIndent, markerStart, markerWidth] = row.expected;
      assert.match(markup, new RegExp(`<div style="[^"]*padding-inline-start:${padding}px;text-indent:${textIndent}px;`));
      const hanging = (row.style.indentFirstLine ?? 0) < 0;
      assert.match(markup, new RegExp(`data-sasha-list-marker="" style="[^"]*inset-inline-start:${markerStart}px;width:${markerWidth}px;text-indent:0;${hanging ? "text-align:end;white-space:nowrap;" : "user-select"}`));
      const layout = listLayout({ style: { indentStart: row.style.indentStart ?? 0, indentFirstLine: row.style.indentFirstLine ?? 0 }, level: row.level });
      const thousandths = (value: number): number => Math.round(value * 1000) / 1000;
      assert.deepEqual([(row.style.indentStart ?? 0) + layout.listIndent, layout.textIndent, layout.markerStart, layout.markerWidth].map(thousandths), row.expected);
    });
  }
});

describe("a list marker in its own colour and size", () => {
  // Columns: label, marker colour, marker size, expected inner span style (null: the glyph is bare text).
  const blue: ListMarkerColour = "#4a6cf7";
  const rows: readonly Readonly<{ label: string; markerColour: ListMarkerColour | undefined; markerFontSize: number | undefined; expected: string | null }>[] = [
    { label: "no bullet style (control): the marker copies the text", markerColour: undefined, markerFontSize: undefined, expected: null },
    { label: "a blue dot of its own size (complex 30's colour)", markerColour: blue, markerFontSize: 12, expected: `color:${colourValue(listMarkerColour(blue), THEME)};font-size:12px` },
    { label: "a theme slot keeps its reference", markerColour: "accent2", markerFontSize: undefined, expected: `color:${colourValue({ kind: "theme", slot: "accent2", alpha: 1 }, THEME)}` },
  ];
  for (const row of rows) {
    it(row.label, () => {
      const list = membership({ level: 0, markerColour: row.markerColour, markerFontSize: row.markerFontSize });
      const markup = paragraphsMarkup(textBody([paragraph([run("Key priority", { fontSize: 21.333 })], { list })]));
      const marker = /data-sasha-list-marker="" style="[^"]*">(.*?)<\/span><span/.exec(markup)?.[1];
      assert.equal(marker, row.expected === null ? "●" : `<span style="${row.expected}">●</span>`);
    });
  }

  it("speaker notes' ink colour wins over the marker's own colour, as it does over the text's", () => {
    const list = membership({ level: 0, markerColour: "#e53e3e", markerFontSize: 12 });
    const markup = paragraphsMarkup(textBody([paragraph([run("Note")], { list })]), "#ffffff");
    assert.match(markup, /<span style="font-size:12px">●<\/span>/);
  });
});

describe("a soft line break", () => {
  it("complex 24: U+000B draws as a line feed of the same length, never as a missing glyph", () => {
    const text = " of nested containers.\u000B\u000B Each level adds ";
    const markup = paragraphsMarkup(textBody([paragraph([run(text)])]));
    assert.ok(!markup.includes("\u000B"), "no vertical tab reaches the page");
    assert.ok(markup.includes(" of nested containers.\n\n Each level adds "), markup);
  });
});

function membership(options: Readonly<{ level: number; markerColour?: ListMarkerColour | undefined; markerFontSize?: number | undefined }>): ListMembership {
  return {
    kind: "list",
    listId: ids.next("list"),
    glyph: "disc",
    level: options.level,
    ...(options.markerColour === undefined ? {} : { markerColour: options.markerColour }),
    ...(options.markerFontSize === undefined ? {} : { markerFontSize: options.markerFontSize }),
  };
}

function paragraphsMarkup(body: TextBody, inkColour?: string): string {
  return renderToStaticMarkup(
    createElement(TextParagraphs, {
      body,
      styleContext: { theme: THEME, placeholder: null },
      slideNumber: 1,
      slideNumberOf: () => null,
      fontScale: 1,
      renderGeneration: 0,
      ...(inkColour === undefined ? {} : { inkColour }),
    }),
  );
}

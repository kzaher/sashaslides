// THE EXPORT'S SHRINK PASS AGAINST THE RENDERER (export-layout.ts): the page holds a shrinking box's
// text at scale 1 and the pass rescales it in place, so after a step every declaration must read
// what the renderer writes at that scale. The paragraph, its runs' span and a run BIGGER than the
// paragraph's base (the one the renderer moves by a pixel offset) are each one node, declared by
// the renderer's own functions and serialised by react-dom/server, as the page is.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type CSSProperties } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_PARAGRAPH_STYLE, type RunStyle } from "../contracts/style.ts";
import { paragraphDeclarations, paragraphRunsDeclarations, runDeclarations } from "../view/render/inline-styles.ts";
import { resolveRunStyle } from "../view/render/text-layout.ts";
import { sampleTheme } from "../contracts/testing/snapshot-builders.ts";
import { layOutExportedSlide, type ExportLayoutSettings } from "./export-layout.ts";

const theme = sampleTheme();
const LINE_SPACING = 2;
const base = resolveRunStyle({ context: { theme, placeholder: null }, patch: { fontFamily: "Arial", fontSize: 18 } });
const big: RunStyle = { ...base, fontFamily: "Playfair Display", fontSize: 48 };

/** The paragraph, its runs' span and the big run, as the renderer declares them at `fontScale`. */
function declarationsAt(fontScale: number): readonly Map<string, string>[] {
  return [
    paragraphDeclarations({ style: { ...DEFAULT_PARAGRAPH_STYLE, lineSpacing: LINE_SPACING, spaceAbove: 12, indentStart: 20 }, base, theme, fontScale, listIndent: 0 }),
    paragraphRunsDeclarations({ base, lineSpacing: LINE_SPACING, theme, fontScale }),
    runDeclarations({ style: big, base, lineSpacing: LINE_SPACING, theme, fontScale }),
  ].map(serialised);
}

/** One element's declarations as react-dom/server writes them into the page. */
function serialised(style: CSSProperties): Map<string, string> {
  const text = (/style="([^"]*)"/.exec(renderToStaticMarkup(createElement("span", { style })))?.[1] ?? "").replaceAll("&quot;", '"');
  return new Map(
    text
      .split(";")
      .filter((declaration) => declaration.length > 0)
      .map((declaration): [string, string] => [declaration.slice(0, declaration.indexOf(":")), declaration.slice(declaration.indexOf(":") + 1)]),
  );
}

/** The browser's element class, which the pass narrows the layer and the content with. */
class PageElement {}

/**
 * Runs the compiled pass, as the page does, over one shrinking box whose content needs twice the
 * height it has at scale 1: one step takes it to 50 %. Returns the nodes' declarations afterwards.
 */
async function shrunk(declarations: readonly Map<string, string>[]): Promise<readonly Map<string, string>[]> {
  const nodes = declarations.map((declared) => ({
    hasAttribute: () => false,
    style: { getPropertyValue: (property: string) => declared.get(property) ?? "", setProperty: (property: string, value: string) => declared.set(property, value) },
  }));
  const bigFontSize = (): number => Number.parseFloat(declarations[2]?.get("font-size") ?? "0");
  const startSize = bigFontSize();
  const content = Object.assign(new PageElement(), { querySelectorAll: () => nodes });
  Object.defineProperty(content, "offsetHeight", { get: () => (100 * bigFontSize()) / startSize });
  const layer = Object.assign(new PageElement(), { clientHeight: 50, querySelector: () => content });
  const settings: ExportLayoutSettings = {
    shrinkTargets: [{ elementId: "box", verticalPadding: 0 }],
    fontQueries: [],
    fontMetricOverrides: [],
    readyAttribute: "data-ready",
    elementIdAttribute: "data-element",
    textLayerAttribute: "data-layer",
    textContentAttribute: "data-content",
    listMarkerAttribute: "data-marker",
    minimumScale: 0.25,
    scaleStep: 0.025,
    fontWaitMilliseconds: 0,
  };
  const page = {
    fonts: { load: () => Promise.resolve([]), ready: Promise.resolve() },
    querySelector: () => ({ querySelector: () => layer }),
    documentElement: { setAttribute: () => undefined },
  };
  const sandbox: Record<string, unknown> = { page, settings, setTimeout };
  Reflect.set(sandbox, "HTMLElement", PageElement);
  await Promise.resolve(runInNewContext(`(${layOutExportedSlide.toString()})(page, settings)`, sandbox));
  return declarations;
}

describe("the shrink pass rescales what the renderer scales", () => {
  it("after a step to 50 %, every declaration of the paragraph, the span and a big run reads as the renderer's at 50 %", async () => {
    const after = await shrunk(declarationsAt(1));
    const expected = declarationsAt(0.5);
    assert.ok(expected[2]?.get("vertical-align")?.endsWith("px"), "the big run is moved by a pixel offset");
    expected.forEach((declared, index) => {
      const actual = after[index] ?? new Map<string, string>();
      assert.deepEqual([...actual.keys()].sort(), [...declared.keys()].sort());
      for (const [property, value] of declared) {
        const written = actual.get(property) ?? "";
        if (value.endsWith("px")) assert.ok(Math.abs(Number.parseFloat(written) - Number.parseFloat(value)) < 0.01, `node ${index} ${property}: ${written}, the renderer writes ${value}`);
        else assert.equal(written, value, `node ${index} ${property}`);
      }
    });
  });
});

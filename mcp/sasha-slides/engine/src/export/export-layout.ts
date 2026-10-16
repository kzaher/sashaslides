// THE EXPORTED PAGE'S ONE LAYOUT PASS: what the editor does in layout effects, done once by a script
// inside the exported slide page (slide-html.ts), because react-dom/server runs no effects and the
// export must still look like the editor.
//
// Key decisions:
//
//  * ONLY SHRINK ON OVERFLOW NEEDS IT. Every other measured behaviour of the renderer is plain
//    layout the browser does on its own (a table row grows past its stored minimum height, text
//    overflows a box that does not shrink). Shrinking is the one place the editor measures and
//    re-renders (element-view.tsx `useShrinkToFit`), and this pass repeats that loop step for step:
//    the same available height, the same estimate, the same 2.5 % steps and 25 % floor.
//  * IT RESCALES THE SAME DECLARATIONS THE RENDERER SCALES. The renderer multiplies a fixed set of
//    pixel values by `fontScale` (inline-styles.ts `runDeclarations` and `paragraphDeclarations`,
//    text-paragraphs.tsx `markerDeclarations`); the markup holds them at scale 1, so this pass
//    multiplies exactly those properties and leaves unitless line heights alone, as the renderer does.
//  * WRITTEN IN TYPESCRIPT, SHIPPED AS ITS COMPILED SOURCE. slide-html.ts inlines
//    `layOutExportedSlide.toString()`, so the function must be self-contained: no imports, no module
//    constants (everything arrives in `settings`), and no `CSS.escape`, which node tests lack.
//  * A STAND-IN FONT GETS THE ORIGINAL'S VERTICAL METRICS before anything waits on it: the overrides
//    from view/render/font-families.ts are set on the stylesheet's faces (which exist by now: the
//    page's stylesheets block this script), the same as the editor's `applyFontMetricOverrides`.
//  * THE PAGE SAYS WHEN IT IS DONE. After the fonts load (or a deadline passes) and the shrink pass
//    runs, the root element gets `settings.readyAttribute`; screenshot drivers poll for it instead of
//    sleeping. It is set on every path, failures included, so a driver never waits out its budget.

import type { FontMetricOverride } from "../view/render/font-families.ts";

/** One text box that shrinks its text on overflow, with the padding the editor subtracts. */
export type ShrinkTarget = Readonly<{ elementId: string; verticalPadding: number }>;

/** Everything the layout pass needs, serialised into the page next to the function. */
export type ExportLayoutSettings = Readonly<{
  shrinkTargets: readonly ShrinkTarget[];
  /** `document.fonts.load` queries, one per face the slide draws. */
  fontQueries: readonly string[];
  /** Vertical metrics for the stand-in fonts, set on their faces before the fonts are awaited. */
  fontMetricOverrides: readonly FontMetricOverride[];
  /** Set to "true" on the root element when layout is final. */
  readyAttribute: string;
  elementIdAttribute: string;
  textLayerAttribute: string;
  textContentAttribute: string;
  listMarkerAttribute: string;
  minimumScale: number;
  scaleStep: number;
  fontWaitMilliseconds: number;
}>;

/** Loads the fonts, shrinks overflowing text like the editor, then marks the page ready. */
export async function layOutExportedSlide(page: Document, settings: ExportLayoutSettings): Promise<void> {
  try {
    if (settings.fontMetricOverrides.length > 0) {
      page.fonts.forEach((face) => {
        const override = settings.fontMetricOverrides.find((candidate) => candidate.family === face.family.replace(/["']/g, ""));
        if (override === undefined) return;
        face.ascentOverride = override.ascent;
        face.descentOverride = override.descent;
        face.lineGapOverride = override.lineGap;
      });
    }
    const fontLoads = settings.fontQueries.map((query) => page.fonts.load(query).catch(() => []));
    await Promise.race([
      Promise.all(fontLoads).then(() => page.fonts.ready),
      new Promise((resolve) => setTimeout(resolve, settings.fontWaitMilliseconds)),
    ]);
    // Properties the renderer multiplies by `fontScale` on every text node, and the two only a list marker scales.
    const textProperties = ["font-size", "letter-spacing", "margin-top", "margin-bottom", "padding-inline-start", "text-indent"];
    const markerProperties = ["inset-inline-start", "width"];
    for (const target of settings.shrinkTargets) {
      const quotedIdentifier = target.elementId.replace(/["\\]/g, "\\$&");
      const element = page.querySelector(`[${settings.elementIdAttribute}="${quotedIdentifier}"]`);
      const layer = element?.querySelector(`[${settings.textLayerAttribute}]`) ?? null;
      const content = layer?.querySelector(`[${settings.textContentAttribute}]`) ?? null;
      if (!(layer instanceof HTMLElement) || !(content instanceof HTMLElement)) continue;
      const scalable: { node: HTMLElement; property: string; value: number }[] = [];
      for (const node of content.querySelectorAll<HTMLElement>("[style]")) {
        const properties = node.hasAttribute(settings.listMarkerAttribute) ? [...textProperties, ...markerProperties] : textProperties;
        for (const property of properties) {
          const declared = node.style.getPropertyValue(property);
          if (!declared.endsWith("px")) continue;
          scalable.push({ node, property, value: Number.parseFloat(declared) });
        }
      }
      let fontScale = 1;
      // The editor re-renders until the text fits; 64 steps is far past the 31 between 100 % and 25 %.
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const available = layer.clientHeight - target.verticalPadding;
        const needed = content.offsetHeight;
        if (needed <= available + 0.5 || fontScale <= settings.minimumScale) break;
        const estimate = Math.floor(((fontScale * available) / needed) / settings.scaleStep) * settings.scaleStep;
        fontScale = Math.max(settings.minimumScale, Math.min(fontScale - settings.scaleStep, estimate));
        for (const entry of scalable) entry.node.style.setProperty(entry.property, `${Math.round(entry.value * fontScale * 1000) / 1000}px`);
      }
    }
  } finally {
    page.documentElement.setAttribute(settings.readyAttribute, "true");
  }
}

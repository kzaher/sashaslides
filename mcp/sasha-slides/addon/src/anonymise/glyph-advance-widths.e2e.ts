/**
 * glyph-advance-widths.e2e.ts — where the numbers in glyph-advance-widths.ts come from.
 *
 *   cd mcp/sasha-slides/addon && node --import tsx src/anonymise/glyph-advance-widths.e2e.ts
 *   (about 2 s; Chrome must be listening on 9222 — never 9223)
 *
 * `glyph-widths.e2e.ts` measures the same thing for a different purpose: it SCORES the width
 * buckets `substitute-text.ts` substitutes inside. The lorem strategy cannot work from buckets,
 * because it has to decide how much text to emit, so it needs the widths as NUMBERS. This prints
 * the whole table, ready to paste into `glyph-advance-widths.ts`, and the mono-to-proportional
 * ratio that `MONOSPACE_ADVANCE_PER_MILLE` carries.
 *
 * It is a measuring tool, not an assertion: the absolute numbers differ a little per machine and
 * per installed font, and what the table encodes is the RATIOS between glyphs, which are a
 * property of the typefaces rather than of this container.
 */
import CDPraw from "chrome-remote-interface";
import type { CdpModule } from "../../../../../types/cdp-types.ts";

// SAFETY: types/ambient.d.ts declares the default export as `unknown`; types/cdp-types.ts is the
// repo's hand-written shape for it and this is the single narrowing point.
const CDP = CDPraw as unknown as CdpModule;

/** The stacks the four candidate fixtures actually ask for. The first two are proportional. */
const PROPORTIONAL: readonly string[] = ['Georgia, "Times New Roman", serif', '"Helvetica Neue", Arial, sans-serif'];
const MONOSPACE = '"SF Mono", Menlo, monospace';

/** Every character the lorem strategy ever has to measure: a word's letters, either case. */
const MEASURED = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const tab = await CDP.New({ port: 9222, url: "about:blank" });
const client = await CDP({ target: tab, port: 9222 });
try {
  const families = [...PROPORTIONAL, MONOSPACE];
  const { result } = await client.Runtime.evaluate({ expression: measureScript(families), returnByValue: true });
  if (typeof result.value !== "string") throw new Error("the measuring script returned no JSON");
  // SAFETY: `measureScript` below is the only producer of this string.
  const widths = JSON.parse(result.value) as Readonly<Record<string, Readonly<Record<string, number>>>>;

  for (const family of PROPORTIONAL) {
    const row = widths[family] ?? {};
    console.log(`\n// ${family} — per mille of the font size.`);
    for (const alphabet of ["abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "0123456789"]) {
      const entries = [...alphabet].map((character) => `["${character}", ${row[character] ?? 0}]`);
      for (let at = 0; at < entries.length; at += 6) console.log(`  ${entries.slice(at, at + 6).join(", ")},`);
    }
  }

  for (const family of families) {
    const row = widths[family] ?? {};
    const measured = [...MEASURED].map((character) => row[character] ?? 0);
    const mean = measured.reduce((sum, value) => sum + value, 0) / measured.length;
    console.log(`// ${family}: mean ${mean.toFixed(0)}, min ${Math.min(...measured)}, max ${Math.max(...measured)}`);
  }
  const mono = widths[MONOSPACE]?.["m"] ?? 0;
  console.log(`// MONOSPACE_ADVANCE_PER_MILLE = ${mono} (every cell, measured on "m")`);
} finally {
  await client.close();
  await CDP.Close({ port: 9222, id: tab.id });
}

function measureScript(families: readonly string[]): string {
  return `(() => {
    const context = document.createElement("canvas").getContext("2d");
    const out = {};
    for (const family of ${JSON.stringify(families)}) {
      context.font = "1000px " + family;
      const row = {};
      for (const character of ${JSON.stringify(MEASURED)}) {
        row[character] = Math.round(context.measureText(character).width);
      }
      out[family] = row;
    }
    return JSON.stringify(out);
  })()`;
}

/**
 * glyph-widths.e2e.ts — where the width buckets in substitute-text.ts come from.
 *
 *   cd mcp/sasha-slides/addon && node --import tsx src/anonymise/glyph-widths.e2e.ts
 *   (about 2 s; Chrome must be listening on 9222 — never 9223)
 *
 * It measures the advance width of every ASCII letter and digit in the font stacks the real
 * fixtures use, then scores the buckets `letterCandidates` actually ships: for each bucket it
 * prints the worst relative width error a substitution inside it can cause. That is the number the
 * inline drift in fidelity.e2e.ts is made of, so this is the tool to run before changing a bucket.
 *
 * It is a measuring tool, not an assertion: fonts differ per machine and the buckets encode the
 * ORDER of the widths, which is stable, rather than any one machine's numbers.
 */
import CDPraw from "chrome-remote-interface";
import type { CdpModule } from "../../../../../types/cdp-types.ts";
import { LOWERCASE_WIDTH_BUCKETS, UPPERCASE_WIDTH_BUCKETS } from "./substitute-text.ts";

// SAFETY: types/ambient.d.ts declares the default export as `unknown`; types/cdp-types.ts is the
// repo's hand-written shape for it and this is the single narrowing point.
const CDP = CDPraw as unknown as CdpModule;

const FAMILIES: readonly string[] = [
  'Georgia, "Times New Roman", serif',
  '"Helvetica Neue", Arial, sans-serif',
  '"SF Mono", Menlo, monospace',
];

const tab = await CDP.New({ port: 9222, url: "about:blank" });
const client = await CDP({ target: tab, port: 9222 });
try {
  const { result } = await client.Runtime.evaluate({ expression: measureScript(FAMILIES), returnByValue: true });
  if (typeof result.value !== "string") throw new Error("the measuring script returned no JSON");
  // SAFETY: `measureScript` a few lines below is the only producer of this string.
  const widths = JSON.parse(result.value) as Readonly<Record<string, Readonly<Record<string, number>>>>;

  for (const family of FAMILIES) {
    const row = widths[family] ?? {};
    console.log(`\n== ${family}`);
    for (const buckets of [LOWERCASE_WIDTH_BUCKETS, UPPERCASE_WIDTH_BUCKETS]) {
      for (const bucket of buckets) {
        const measured = [...bucket].map((character) => row[character] ?? 0);
        const low = Math.min(...measured);
        const high = Math.max(...measured);
        const spread = low === 0 ? 0 : ((high - low) / low) * 100;
        console.log(`   ${bucket.padEnd(18)} ${low.toFixed(1)}..${high.toFixed(1)}  worst error ${spread.toFixed(1)}%`);
      }
    }
    console.log(
      `   digits             ${[...("0123456789")].map((digit) => (row[digit] ?? 0).toFixed(0)).join(" ")}`,
    );
    for (const alphabet of ["abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"]) {
      const sorted = [...alphabet].sort((left, right) => (row[left] ?? 0) - (row[right] ?? 0));
      console.log(`   sorted: ${sorted.map((character) => `${character}:${(row[character] ?? 0).toFixed(1)}`).join(" ")}`);
    }
  }
} finally {
  await client.close();
  await CDP.Close({ port: 9222, id: tab.id });
}

function measureScript(families: readonly string[]): string {
  return `(() => {
    const context = document.createElement("canvas").getContext("2d");
    const out = {};
    for (const family of ${JSON.stringify(families)}) {
      context.font = "100px " + family;
      const row = {};
      for (const character of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
        row[character] = Math.round(context.measureText(character).width * 10) / 10;
      }
      out[family] = row;
    }
    return JSON.stringify(out);
  })()`;
}

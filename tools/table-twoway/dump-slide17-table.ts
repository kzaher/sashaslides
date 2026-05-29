/**
 * dump-slide17-table.ts — Dump the row-3 right table's extracted DOM
 * (bounds, per-cell bounds, classes, bgColor) so we can see what
 * renderTableAsShapes is actually getting.
 */
import CDP from "chrome-remote-interface";
import { readFileSync } from "fs";
import { resolve, join } from "path";
import { transformSync } from "esbuild";

const EXTRACT_TS = readFileSync(join(process.cwd(), "renderer/html2slides/extract-dom.ts"), "utf-8");
const EXTRACT_JS = transformSync(EXTRACT_TS, { loader: "ts", target: "es2020" }).code;

interface CDPStatic {
  New(opts: { port: number; url: string }): Promise<{ id: string }>;
  Close(opts: { port: number; id: string }): Promise<void>;
}
const CDPS = CDP as unknown as CDPStatic;

async function main(): Promise<void> {
  const htmlPath = resolve("renderer/html2slides/e2e/fixtures-basic/slide_17_table_rounded.html");
  const tab = await CDPS.New({ port: 9222, url: `file://${htmlPath}` });
  await new Promise(r => setTimeout(r, 1500));
  const client = await CDP({ target: tab, port: 9222 });
  const { Runtime, Emulation, Page } = client;
  await Page.enable();
  await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({ width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
  await new Promise(r => setTimeout(r, 800));

  const { result } = await Runtime.evaluate({ expression: EXTRACT_JS, returnByValue: true });
  const data = JSON.parse(result.value);

  const tables = (data.elements || []).filter((e: { type: string }) => e.type === "table");
  console.log(`Found ${tables.length} table elements.`);
  for (let ti = 0; ti < tables.length; ti++) {
    const t = tables[ti];
    const b = t.bounds || {};
    console.log(`\n--- table[${ti}] bounds=(${b.x?.toFixed(2)},${b.y?.toFixed(2)},${b.w?.toFixed(2)},${b.h?.toFixed(2)}) shapeRender=${t.renderAsShapes ?? false}/${t.shapeRenderEmpty ?? false}`);
    const rows = t.rows || [];
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const parts = row.map((c: { bounds?: { x: number; y: number; w: number; h: number }; isHeader?: boolean; style?: { bgColor?: string }; text?: string }) => {
        const cb = c.bounds || {};
        return `${c.isHeader ? "TH" : "td"}[${cb.x?.toFixed(1)},${cb.y?.toFixed(1)},${cb.w?.toFixed(1)},${cb.h?.toFixed(1)}] bg=${c.style?.bgColor ?? "-"} txt=${JSON.stringify((c.text ?? "").slice(0, 10))}`;
      });
      console.log(`  row[${ri}]: ${parts.join(" | ")}`);
    }
  }

  await client.close();
  await CDPS.Close({ port: 9222, id: tab.id });
}
main().catch(e => { console.error(e); process.exit(1); });

import CDP from "chrome-remote-interface";
import { readFileSync } from "fs";
import { resolve, join } from "path";
import { transformSync } from "esbuild";

const EXTRACT_TS = readFileSync(
  join(process.cwd(), "renderer/html2slides/extract-dom.ts"),
  "utf-8",
);
const EXTRACT_JS = transformSync(EXTRACT_TS, { loader: "ts", target: "es2020" }).code;

interface CDPStatic {
  New(opts: { port: number; url: string }): Promise<{ id: string }>;
  Close(opts: { port: number; id: string }): Promise<void>;
}
const CDPS = CDP as unknown as CDPStatic;

async function main() {
  const htmlPath = resolve(process.argv[2]);
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

  for (let i = 0; i < data.elements.length; i++) {
    const el = data.elements[i];
    if (el.type !== "table") continue;
    console.log(`TABLE[${i}] bgColor=${el.bgColor || "null"} borderRadius=${el.borderRadius} clipMask=${el.clipMask ? "YES" : "no"}`);
    if (el.clipMask) {
      const m = el.clipMask;
      console.log(`  clipMask bounds=(${m.bounds.x.toFixed(0)},${m.bounds.y.toFixed(0)},${m.bounds.w.toFixed(0)},${m.bounds.h.toFixed(0)}) cr=tl${m.cornerRadii.tl}/tr${m.cornerRadii.tr}/br${m.cornerRadii.br}/bl${m.cornerRadii.bl}`);
    }
    console.log(`  bounds=(${el.bounds.x.toFixed(0)},${el.bounds.y.toFixed(0)},${el.bounds.w.toFixed(0)},${el.bounds.h.toFixed(0)})`);
    for (let r = 0; r < el.rows.length; r++) {
      const row = el.rows[r];
      const cellInfo = row.map((c: any) => `${c.isHeader?'H':'D'}${c.style?.bgColor||"-"}`).join(",");
      const hs = row.map((c: any) => c.bounds ? c.bounds.h.toFixed(0) : "?").join(",");
      console.log(`  row[${r}] heights=[${hs}]  cells=[${cellInfo}]`);
    }
  }

  await client.close();
  await CDPS.Close({ port: 9222, id: tab.id });
}
main().catch(e => { console.error(e); process.exit(1); });

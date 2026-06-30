import CDPraw from "chrome-remote-interface";
import { readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { transformSync } from "esbuild";
import type { CdpModule } from "../../types/cdp-types.ts";

const EXTRACT_TS = readFileSync(
  join(process.cwd(), "renderer/html2slides/extract-dom.ts"),
  "utf-8",
);
const EXTRACT_JS = transformSync(EXTRACT_TS, { loader: "ts", target: "es2020" }).code;

// chrome-remote-interface ships no .d.ts; its default export is declared
// `unknown` (types/ambient.d.ts). Narrow it to the typed boundary once.
const CDP = CDPraw as CdpModule;

async function main() {
  const htmlPath = resolve(process.argv[2]);
  const tab = await CDP.New({ port: 9222, url: `file://${htmlPath}` });
  await new Promise(r => setTimeout(r, 1500));
  const client = await CDP({ target: tab, port: 9222 });
  const { Runtime, Emulation, Page } = client;
  await Page.enable();
  await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({ width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
  await new Promise(r => setTimeout(r, 800));

  const { result } = await Runtime.evaluate({ expression: EXTRACT_JS, returnByValue: true });
  if (typeof result.value !== "string") throw new Error("extract-dom did not return a JSON string");
  const data = JSON.parse(result.value);

  for (let i = 0; i < data.elements.length; i++) {
    const el = data.elements[i];
    const cm = el.clipMask
      ? `clipMask={bnds:(${el.clipMask.bounds.x.toFixed(0)},${el.clipMask.bounds.y.toFixed(0)},${el.clipMask.bounds.w.toFixed(0)},${el.clipMask.bounds.h.toFixed(0)}) tl:${el.clipMask.cornerRadii.tl} tr:${el.clipMask.cornerRadii.tr} br:${el.clipMask.cornerRadii.br} bl:${el.clipMask.cornerRadii.bl}}`
      : "clipMask=null";
    const cr = el.cornerRadii
      ? `cornerRadii={tl:${el.cornerRadii.tl},tr:${el.cornerRadii.tr},br:${el.cornerRadii.br},bl:${el.cornerRadii.bl}}`
      : "";
    const br = el.borderRadius !== undefined ? `br=${el.borderRadius}` : "";
    const bnds = el.bounds ? `(${el.bounds.x.toFixed(0)},${el.bounds.y.toFixed(0)},${el.bounds.w.toFixed(0)},${el.bounds.h.toFixed(0)})` : "()";
    let extra = "";
    if (el.type === "table") {
      extra = ` rows=${(el.rows||[]).length}`;
    } else if (el.type === "rect") {
      extra = ` fill=${el.fill||"-"} bg=${(el as { bgColor?: string }).bgColor||"-"}`;
    } else if (el.type === "text") {
      extra = ` text=${JSON.stringify((el.text||"").slice(0, 30))}`;
    }
    console.log(`[${i}] ${el.type} ${bnds} ${br} ${cr} ${cm}${extra}`);
  }

  await client.close();
  await CDP.Close({ port: 9222, id: tab.id });
}
main().catch(e => { console.error(e); process.exit(1); });

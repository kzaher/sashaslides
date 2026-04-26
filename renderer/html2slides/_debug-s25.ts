import CDP from "chrome-remote-interface";
import { readFileSync } from "fs";
import { resolve, dirname, join } from "path";

import { transformSync } from "esbuild";
const EXTRACT_TS = readFileSync(join(dirname(new URL(import.meta.url).pathname), "extract-dom.ts"), "utf-8");
const EXTRACT_JS = transformSync(EXTRACT_TS, { loader: "ts", target: "es2020" }).code;

async function main() {
  const htmlPath = resolve(process.argv[2]);
  const tab = await (CDP as any).New({ port: 9222, url: `file://${htmlPath}` });
  await new Promise(r => setTimeout(r, 1500));
  const client = await CDP({ target: tab, port: 9222 });
  const { Runtime, Emulation, Page } = client;
  await Page.enable(); await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({ width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
  await new Promise(r => setTimeout(r, 800));
  await Runtime.evaluate({ expression: `document.fonts.ready.then(() => true)`, awaitPromise: true });
  await new Promise(r => setTimeout(r, 300));

  const { result: probe } = await Runtime.evaluate({ expression: `
    const p = document.querySelector('.annotation p');
    const cs = getComputedStyle(p);
    const pb = p.getBoundingClientRect();
    JSON.stringify({
      bounds: { x: pb.x, y: pb.y, w: pb.width, h: pb.height },
      padTop: cs.paddingTop, padBot: cs.paddingBottom,
      padLeft: cs.paddingLeft, padRight: cs.paddingRight,
      fontSize: cs.fontSize, lineHeight: cs.lineHeight, display: cs.display,
    });
  `, returnByValue: true });
  console.log("P DOM:", probe.value);

  const { result } = await Runtime.evaluate({ expression: EXTRACT_JS, returnByValue: true });
  const extraction = JSON.parse(result.value);
  const tp = extraction.elements.find((e: any) => typeof e.text === "string" && e.text.startsWith("Test purpose"));
  console.log("EL:");
  console.log(JSON.stringify({
    bounds: tp.bounds,
    verticallyCentered: tp.verticallyCentered,
    lineCount: tp.lineCount,
    style_padTop: tp.style?.paddingTop,
    style_padLeft: tp.style?.paddingLeft,
    textAlign: tp.style?.textAlign,
  }, null, 2));

  await client.close();
  await (CDP as any).Close({ port: 9222, id: tab.id });
}
main().catch(e => { console.error(e); process.exit(1); });

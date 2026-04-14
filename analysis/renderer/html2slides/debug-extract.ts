import CDP from "chrome-remote-interface";
import { readFileSync } from "fs";
import { resolve, dirname, join } from "path";

import { transformSync } from "esbuild";
const EXTRACT_TS = readFileSync(join(dirname(new URL(import.meta.url).pathname), "extract-dom.ts"), "utf-8");
const EXTRACT_JS = transformSync(EXTRACT_TS, { loader: "ts", target: "es2020" }).code;

async function main() {
  const htmlPath = resolve(process.argv[2] || "slide_05.html");
  const tab = await (CDP as any).New({ port: 9222, url: `file://${htmlPath}` });
  await new Promise(r => setTimeout(r, 1500));
  const client = await CDP({ target: tab, port: 9222 });
  const { Runtime, Emulation, Page } = client;
  await Page.enable();
  await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({ width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
  await new Promise(r => setTimeout(r, 800));

  const { result } = await Runtime.evaluate({ expression: EXTRACT_JS, returnByValue: true });
  const data = JSON.parse(result.value);

  for (const el of data.elements) {
    if (el.type === "text") {
      console.log(`TEXT: ${JSON.stringify(el.text)}  bounds=${JSON.stringify(el.bounds)}  font=${el.style?.fontFamily}/${el.style?.fontSize}/${el.style?.fontWeight}  color=${el.style?.color}  align=${el.style?.textAlign}`);
      if (el.runs) {
        for (const r of el.runs) {
          console.log(`  run: ${JSON.stringify(r.text)}  color=${r.style?.color || "(inherit)"}`);
        }
      }
    } else if (el.type === "rect") {
      const cornerRadii = el.cornerRadii ? `cornerRadii={tl:${el.cornerRadii.tl},tr:${el.cornerRadii.tr},br:${el.cornerRadii.br},bl:${el.cornerRadii.bl}}` : "cornerRadii=none";
      const borderSides = el.borderSides ? `borderSides={top:${el.borderSides.top.width}/${el.borderSides.top.color},right:${el.borderSides.right.width}/${el.borderSides.right.color},bottom:${el.borderSides.bottom.width}/${el.borderSides.bottom.color},left:${el.borderSides.left.width}/${el.borderSides.left.color}}` : "borderSides=none";
      const gradient = el.gradient ? `gradient={angle:${el.gradient.angle},stops:[${el.gradient.stops.map((s: any) => `${s.color}@${s.position}`).join(",")}]}` : "gradient=none";
      console.log(`rect  bounds=${JSON.stringify(el.bounds)}  fill=${el.fill}  ${cornerRadii}  ${borderSides}  ${gradient}`);
    } else {
      console.log(`${el.type}  bounds=${JSON.stringify(el.bounds)}  ${el.color || ""}`);
    }
  }

  await client.close();
  await (CDP as any).Close({ port: 9222, id: tab.id });
}
main().catch(e => { console.error(e); process.exit(1); });

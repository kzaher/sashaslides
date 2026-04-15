import CDP from "chrome-remote-interface";
import { readFileSync, writeFileSync } from "fs";
import { transformSync } from "esbuild";
import { resolve } from "path";

const htmlPath = resolve(process.argv[2]);
const outJson = process.argv[3] || "/tmp/extract.json";
const EXTRACT_TS = readFileSync("/workspaces/sashaslides/analysis/renderer/html2slides/extract-dom.ts", "utf-8");
const EXTRACT_JS = transformSync(EXTRACT_TS, { loader: "ts", target: "es2020" }).code;

(async () => {
  const target = await CDP.New({ port: 9222, url: "about:blank" });
  const client = await CDP({ target, port: 9222 });
  const { Page, Runtime, Emulation } = client;
  await Page.enable(); await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({ width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await Page.navigate({ url: "file://" + htmlPath });
  await Page.loadEventFired();
  await new Promise(r => setTimeout(r, 500));
  const { result } = await Runtime.evaluate({ expression: EXTRACT_JS, returnByValue: true });
  writeFileSync(outJson, typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2));
  const parsed = typeof result.value === "string" ? JSON.parse(result.value) : result.value;
  result.value = parsed;
  console.log("elementCount:", result.value.elementCount);
  console.log("types:", result.value.elements.map((e:any)=>e.type).join(","));
  await client.close(); await CDP.Close({ port: 9222, id: target.id });
})();

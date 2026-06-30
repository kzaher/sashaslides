import CDPraw from "chrome-remote-interface";
import { readFileSync } from "fs";
import { transformSync } from "esbuild";
import { resolve } from "path";
import type { CdpModule } from "./types/cdp-types.ts";

const CDP = CDPraw as CdpModule;

const EXTRACT_TS = readFileSync("analysis/renderer/html2slides/extract-dom.ts", "utf-8");
const EXTRACT_JS = transformSync(EXTRACT_TS, { loader: "ts", target: "es2020" }).code;

(async () => {
  const absPath = resolve("analysis/renderer/html2slides/e2e/fixtures-basic/slide_02_rounded_rect.html");
  const tab = await (CDP as any).New({ port: 9222, url: "file://" + absPath });
  await new Promise(r => setTimeout(r, 1000));
  const client = await CDP({ target: tab, port: 9222 });
  const { Runtime } = client;
  await Runtime.enable();
  const { result } = await Runtime.evaluate({ expression: EXTRACT_JS, returnByValue: true });
  const extraction = result.value;
  console.log(JSON.stringify(extraction, null, 2).slice(0, 5000));
  await client.close();
  await (CDP as any).Close({ port: 9222, id: tab.id });
})();

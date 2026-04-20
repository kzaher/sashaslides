import CDP from "chrome-remote-interface";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { transformSync } from "esbuild";

const EXTRACT_TS = readFileSync(join(dirname(new URL(import.meta.url).pathname), "html2slides", "extract-dom.ts"), "utf-8");
const EXTRACT_JS = transformSync(EXTRACT_TS, { loader: "ts", target: "es2020" }).code;

async function main() {
  const tab = await (CDP as any).New({ port: 9222, url: `file:///workspaces/sashaslides/renderer/html2slides/e2e/fixtures/slide_12.html` });
  await new Promise(r => setTimeout(r, 1500));
  const client = await CDP({ target: tab, port: 9222 });
  const { Runtime, Emulation, Page } = client;
  await Page.enable();
  await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({ width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
  await new Promise(r => setTimeout(r, 800));

  // Use the actual extract-dom pipeline
  const { result } = await Runtime.evaluate({ expression: EXTRACT_JS, returnByValue: true });
  const data = JSON.parse(result.value);

  for (const el of data.elements) {
    if (el.type === "rect" && el.bounds && el.bounds.h <= 50 && el.bounds.h >= 40 && el.bounds.x > 100 && el.bounds.x < 150) {
      console.log("STATUS-BAR?", JSON.stringify(el.bounds), "cornerRadii:", JSON.stringify(el.cornerRadii), "fill:", el.fill);
    }
  }

  // Now run a direct test of inheritClippingCorners
  const { result: r2 } = await Runtime.evaluate({ 
    expression: `(function(){
      const sb = document.querySelector('.status-bar');
      const dev = document.querySelector('.device');
      const sbr = sb.getBoundingClientRect();
      const dr = dev.getBoundingClientRect();
      return JSON.stringify({
        sb_bounds: {x:sbr.x, y:sbr.y, w:sbr.width, h:sbr.height, right:sbr.right, bottom:sbr.bottom},
        dev_bounds: {x:dr.x, y:dr.y, w:dr.width, h:dr.height, right:dr.right, bottom:dr.bottom},
        dev_tl: getComputedStyle(dev).borderTopLeftRadius,
        dev_tr: getComputedStyle(dev).borderTopRightRadius,
        dev_ov: getComputedStyle(dev).overflow,
        sb_parent_is_dev: sb.parentElement === dev,
        sb_parent_tag: sb.parentElement.className,
      });
    })()`, returnByValue: true
  });
  console.log(JSON.parse(r2.value));
  await (CDP as any).Close({ id: tab.id, port: 9222 });
}
main().catch(e => { console.error(e); process.exit(1); });

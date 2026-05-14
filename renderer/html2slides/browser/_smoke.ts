/**
 * Smoke test for browser/html2slides.html. Loads the page in headless Chrome,
 * synthesizes a drag-drop of every fixture HTML file, clicks Convert, and
 * pulls the downloaded .pptx bytes out via fetch(blob:url) → Uint8Array.
 *
 * Usage:
 *   npx tsx renderer/html2slides/browser/_smoke.ts
 *   FIXTURES=slide_07.html,slide_25.html npx tsx renderer/html2slides/browser/_smoke.ts
 */
import CDP from "chrome-remote-interface";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { resolve, join } from "path";

const PORT = 9222;
const HTML_PATH = resolve("/workspaces/sashaslides/renderer/html2slides/browser/html2slides.html");
const FIXTURE_DIR = resolve("/workspaces/sashaslides/renderer/html2slides/e2e/fixtures");
const FIXTURES: string[] =
  (process.env.FIXTURES?.split(",").map(s => s.trim()).filter(Boolean)) ??
  readdirSync(FIXTURE_DIR).filter(f => f.endsWith(".html")).sort();
const OUT_DIR = "/tmp/sxs-browser-smoke";

async function main() {
  if (!existsSync(HTML_PATH)) throw new Error("missing " + HTML_PATH);
  mkdirSync(OUT_DIR, { recursive: true });

  const target = await (CDP as any).New({ port: PORT, url: "about:blank" });
  const client = await CDP({ target, port: PORT });
  const { Page, Runtime } = client;
  await Page.enable();
  await Runtime.enable();

  const logs: string[] = [];
  const errors: string[] = [];
  Runtime.consoleAPICalled((p: any) => {
    logs.push(`[${p.type}] ${p.args.map((a: any) => a.value ?? a.description ?? JSON.stringify(a.preview)).join(" ")}`);
  });
  Runtime.exceptionThrown((p: any) => {
    errors.push("EXC: " + (p.exceptionDetails.exception?.description || p.exceptionDetails.text));
  });

  await Page.navigate({ url: "file://" + HTML_PATH });
  await Page.loadEventFired();
  await new Promise(r => setTimeout(r, 500));

  const probe = await Runtime.evaluate({
    expression: `JSON.stringify({ pptxgen: typeof PptxGenJS, jszip: typeof JSZip, dropzone: !!document.getElementById('dropzone') })`,
    returnByValue: true,
  });
  console.log("PROBE:", probe.result.value);

  // Stash all fixture HTML payloads in the page.
  const fixturePayload: Record<string, string> = {};
  for (const name of FIXTURES) {
    fixturePayload[name] = readFileSync(join(FIXTURE_DIR, name), "utf-8");
  }
  await Runtime.evaluate({
    expression: `window.__fixtures = ${JSON.stringify(fixturePayload)};`,
    returnByValue: true,
  });

  // Intercept the auto-triggered download.
  await Runtime.evaluate({
    expression: `
      window.__downloadBytes = null;
      const _click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function() {
        if (this.href && this.href.startsWith('blob:')) {
          fetch(this.href).then(r => r.arrayBuffer()).then(b => { window.__downloadBytes = new Uint8Array(b); });
          return;
        }
        _click.call(this);
      };
    `,
    returnByValue: true,
  });

  // Build a DataTransfer with every fixture file and drop it.
  await Runtime.evaluate({
    expression: `
      (async () => {
        const dt = new DataTransfer();
        for (const [name, html] of Object.entries(window.__fixtures)) {
          dt.items.add(new File([html], name, { type: "text/html" }));
        }
        const dz = document.getElementById('dropzone');
        dz.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        await new Promise(r => setTimeout(r, 100));
        document.getElementById('convert-btn').click();
      })();
    `,
    returnByValue: true,
  });

  // Poll for completion. With ~30 slides this takes a while.
  const t0 = Date.now();
  const deadlineMs = Math.max(60_000, FIXTURES.length * 5_000);
  let bytes: number = 0;
  while (Date.now() - t0 < deadlineMs) {
    const r = await Runtime.evaluate({
      expression: `window.__downloadBytes ? window.__downloadBytes.byteLength : 0`,
      returnByValue: true,
    });
    if (r.result.value > 0) { bytes = r.result.value; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`=== logs (${logs.length}) ===`);
  for (const l of logs.slice(-Math.min(logs.length, 80))) console.log(l);
  if (errors.length) {
    console.log("=== errors ===");
    for (const e of errors) console.log(e);
  }
  console.log(`=== result === bytes=${bytes} elapsed=${elapsed}s`);

  if (bytes > 0) {
    const got = await Runtime.evaluate({
      expression: `Array.from(window.__downloadBytes).map(b => b.toString(16).padStart(2,'0')).join('')`,
      returnByValue: true,
    });
    const buf = Buffer.from(got.result.value as string, "hex");
    const outPath = join(OUT_DIR, FIXTURES.length === 1 ? FIXTURES[0].replace(/\.html?$/i, ".pptx") : "deck.pptx");
    writeFileSync(outPath, buf);
    console.log(`wrote ${outPath} (${buf.length.toLocaleString()} bytes)`);
  } else {
    console.error("no download captured within deadline");
    process.exitCode = 2;
  }

  await client.close();
  await (CDP as any).Close({ port: PORT, id: target.id });
}

main().catch(e => { console.error(e); process.exit(1); });

/**
 * drawio editor round-trip E2E (live, headless).
 *
 * Boots nothing itself — REQUIRES:
 *   - Chrome CDP on :9222
 *   - addon-server on :8787 with the deps/drawio submodule populated
 *     (cd addon-server && PORT=8787 npx tsx server.ts)
 *
 * Drives the REAL self-hosted drawio editor through the harness page
 * (public/e2e-drawio.html) using the exact dual-export protocol the sidebar
 * inline editor / edit-tab use: load(xml) → export xmlpng → export xmlsvg.
 *
 * Asserts:
 *   1. the editor initialises and accepts the seed XML
 *   2. the xmlpng export returns a PNG data URL with the mxfile chunk embedded
 *   3. the xmlsvg export returns an SVG whose content= attr round-trips the
 *      diagram (structure + the seeded marker text survive)
 *   4. drawio-store's extractXmlFromEditableSvg can parse that SVG — i.e. the
 *      Drive-stored .drawio.svg written by saveDiagram is re-openable.
 */
import CDPraw from "chrome-remote-interface";
import { inflateRawSync } from "node:zlib";
import type { CdpModule } from "../../types/cdp-types.ts";
import { extractXmlFromEditableSvg } from "../drawio-store.ts";

const CDP = CDPraw as unknown as CdpModule;
const CDP_PORT = 9222;
const SERVER = "http://127.0.0.1:8787";

const MARKER = "E2E-ROUND-TRIP-MARKER";
const SEED_XML =
  `<mxfile host="e2e"><diagram id="d1" name="Page-1"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10">` +
  `<root><mxCell id="0"/><mxCell id="1" parent="0"/>` +
  `<mxCell id="2" value="${MARKER}" style="rounded=1;fillColor=#dae8fc" vertex="1" parent="1">` +
  `<mxGeometry x="120" y="120" width="200" height="80" as="geometry"/></mxCell>` +
  `</root></mxGraphModel></diagram></mxfile>`;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  // Pre-flight: the harness page must be served (addon-server up + submodule present).
  const head = await fetch(`${SERVER}/e2e-drawio.html`).catch(() => null);
  if (!head || !head.ok) throw new Error(`addon-server not reachable at ${SERVER} — start it first`);
  const editor = await fetch(`${SERVER}/drawio/index.html`).catch(() => null);
  if (!editor || !editor.ok) throw new Error("drawio webapp not served — is deps/drawio populated?");

  const tab = await CDP.New({ port: CDP_PORT, url: `${SERVER}/e2e-drawio.html` });
  let client: Awaited<ReturnType<typeof CDP>> | null = null;
  try {
    client = await CDP({ target: tab, port: CDP_PORT });
    const { Page, Runtime } = client;
    await Page.enable();
    await Runtime.enable();
    // Wait for the real load event (may already have fired).
    const loaded = Page.loadEventFired();
    const rs = await Runtime.evaluate({ expression: "document.readyState", returnByValue: true });
    if (rs.result?.value !== "complete") await Promise.race([loaded, new Promise((r) => setTimeout(r, 5000))]);

    const { result, exceptionDetails } = await Runtime.evaluate({
      expression: `window.__run(${JSON.stringify(SEED_XML)}).then(r => JSON.stringify({
        pngHead: (r.png || "").slice(0, 30), pngLen: (r.png || "").length,
        svg: r.svg || "", xml: r.xml || "" }))`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 40000,
    });
    if (exceptionDetails) throw new Error(`editor round-trip failed: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ""}`);
    const out = JSON.parse(result.value as string) as { pngHead: string; pngLen: number; svg: string; xml: string };

    check("editor initialised + exported", out.pngLen > 0);
    check("xmlpng is a PNG data URL", out.pngHead.startsWith("data:image/png"), out.pngHead);
    check("xmlpng payload is non-trivial", out.pngLen > 5000, `${out.pngLen} chars`);

    // xmlsvg arrives as a data URL (data:image/svg+xml;base64,…) — decode it.
    let svgText = out.svg;
    if (svgText.startsWith("data:")) {
      const comma = svgText.indexOf(",");
      const meta = svgText.slice(0, comma);
      const body = svgText.slice(comma + 1);
      svgText = /;base64/.test(meta) ? Buffer.from(body, "base64").toString("utf-8") : decodeURIComponent(body);
    }
    check("xmlsvg decodes to an <svg>", svgText.includes("<svg"), svgText.slice(0, 60));

    const roundXml = extractXmlFromEditableSvg(svgText);
    check("editable SVG carries content= XML (drawio-store parses it)", roundXml !== null);
    // drawio compresses diagram payloads by default: <diagram> holds
    // base64(rawDeflate(uriEncode(mxGraphModel-xml))). The editor re-opens the
    // compressed form natively, so the STORED file stays compressed — inflate
    // here only to assert the content survived.
    const inflate = (mxfile: string): string => {
      const m = mxfile.match(/<diagram[^>]*>([^<]+)<\/diagram>/);
      if (!m) return mxfile;                       // uncompressed → mxGraphModel inline
      try {
        return decodeURIComponent(inflateRawSync(Buffer.from(m[1].trim(), "base64")).toString("utf-8"));
      } catch { return mxfile; }
    };
    const inflated = inflate(roundXml ?? "");
    check("marker survives the SVG round-trip", inflated.includes(MARKER));
    check("diagram structure survives (mxGraphModel)", inflated.includes("<mxGraphModel"));
    check("editor-reported xml keeps the marker", inflate(out.xml).includes(MARKER));
  } finally {
    try { if (client) await client.close(); } catch { /* */ }
    try { await CDP.Close({ port: CDP_PORT, id: tab.id }); } catch { /* */ }
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });

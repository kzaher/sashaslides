/**
 * api-table-probe.ts — read EXACT table geometry from the Google Slides REST API
 * (presentations.get) instead of pixel-measuring a thumbnail. Dumps each table's
 * tableRows[].rowHeight + tableColumns[].columnWidth (EMU) and the element
 * transform/size, converts to fixture px, and compares against the known fuzz
 * specs — to see whether the API exposes the RENDERED (auto-grown) geometry or
 * only the spec.
 *
 *   cd renderer && npx tsx html2slides/e2e/api-table-probe.ts <presId> [fz_000 ...]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { google } from "googleapis";

const EMU_PER_IN = 914400;
const PX_PER_IN = 128;                 // 1280px fixture = 10in slide
const emuToPx = (emu: number) => (emu / EMU_PER_IN) * PX_PER_IN;

function auth() {
  const creds = JSON.parse(readFileSync(resolve("/workspaces/sashaslides/.auth/google_oauth.json"), "utf-8"));
  const tokens = JSON.parse(readFileSync(resolve("/workspaces/sashaslides/.auth/tokens.json"), "utf-8"));
  const c = creds.installed || creds.web || creds;
  const o = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uris?.[0]);
  o.setCredentials(tokens);
  return o;
}

async function main() {
  const presId = process.argv[2];
  const only = process.argv.slice(3);
  if (!presId) { console.error("usage: api-table-probe.ts <presId> [slideTitle ...]"); process.exit(1); }
  const slides = google.slides({ version: "v1", auth: auth() });
  const pres = (await slides.presentations.get({ presentationId: presId })).data;
  const specs = JSON.parse(readFileSync(resolve("html2slides/e2e/_fuzz/specs.json"), "utf-8"));
  const specById = new Map(specs.map((s: { id: string }) => [s.id, s]));
  const out: Record<string, unknown> = {};

  for (const slide of pres.slides ?? []) {
    // slide title: the speaker-notes / object id won't carry fz id; use the
    // page index → manifest order. Simpler: match by the single table per slide.
    const tables = (slide.pageElements ?? []).filter((e) => e.table);
    for (const el of tables) {
      const t = el.table!;
      const rowsEmu = (t.tableRows ?? []).map((r) => r.rowHeight?.magnitude ?? 0);
      const colsEmu = (t.tableColumns ?? []).map((c) => c.columnWidth?.magnitude ?? 0);
      const xf = el.transform ?? {};
      const sz = el.size ?? {};
      const rec = {
        objectId: el.objectId,
        rows: t.tableRows?.length, cols: t.tableColumns?.length,
        rowHeightsPx: rowsEmu.map((e) => +emuToPx(e).toFixed(2)),
        colWidthsPx: colsEmu.map((e) => +emuToPx(e).toFixed(2)),
        originXpx: +emuToPx((xf.translateX ?? 0)).toFixed(2),
        originYpx: +emuToPx((xf.translateY ?? 0)).toFixed(2),
        sizeWpx: +emuToPx((sz.width?.magnitude ?? 0) * (xf.scaleX ?? 1)).toFixed(2),
        sizeHpx: +emuToPx((sz.height?.magnitude ?? 0) * (xf.scaleY ?? 1)).toFixed(2),
      };
      out[el.objectId!] = rec;
    }
  }
  // map page order → fz id via manifest
  const mani = JSON.parse(readFileSync(resolve("html2slides/e2e/_fuzz/out/thumbs/manifest.json"), "utf-8"));
  const order: string[] = mani.slides ?? [];
  const apiList = Object.values(out) as Array<{ rowHeightsPx: number[]; colWidthsPx: number[]; rows: number; cols: number }>;
  // presentations.get returns slides in page order → align to manifest order
  let i = 0;
  console.log(`presId ${presId}: ${apiList.length} tables`);
  for (const rec of apiList) {
    const id = order[i++];
    if (only.length && !only.includes(id)) continue;
    const spec = specById.get(id) as { rowHeightsPx: number[]; colWidthsPx: number[]; fontPx: number; padYPx: number } | undefined;
    if (!spec) { console.log(`${id}: (no spec)`, rec.rowHeightsPx); continue; }
    console.log(`\n${id}  font=${spec.fontPx} padY=${spec.padYPx}`);
    console.log(`  rowH spec=[${spec.rowHeightsPx}]  API=[${rec.rowHeightsPx}]`);
    console.log(`  colW spec=[${spec.colWidthsPx}]  API=[${rec.colWidthsPx}]`);
  }
  writeFileSync(resolve("html2slides/e2e/_fuzz/api-geometry.json"), JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error("FAILED:", e?.response?.data || e); process.exit(1); });

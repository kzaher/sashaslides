/**
 * Diagnose slide_01 CTA/chip vertical padding regression after wave1a+wave1b
 * were merged together. For each targeted shape (Get Started ×2, Contact
 * Sales, MOST POPULAR) print: bounds, bodyPr anchor/insets, pPr, spcPct.
 */
import { readFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const JSZip = require("jszip");

(async () => {
  const zip = await JSZip.loadAsync(readFileSync("/tmp/sxs-complex/complex.pptx"));
  const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  const sps = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
  const EMU2PX = 1280 / 9144000;

  const targets = ["Get Started", "Contact Sales", "MOST POPULAR"];
  for (const sp of sps) {
    const textMatch = sp.match(/<a:t>([^<]*)<\/a:t>/g);
    if (!textMatch) continue;
    const texts = textMatch.map(m => m.replace(/<\/?a:t>/g, "")).join("|");
    if (!targets.some(t => texts.includes(t))) continue;

    const off = sp.match(/<a:off x="(\d+)" y="(\d+)"\/>/);
    const ext = sp.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    const bodyPr = sp.match(/<a:bodyPr[\s\S]*?(?:\/>|<\/a:bodyPr>)/);
    const pPr = sp.match(/<a:pPr[\s\S]*?(?:\/>|<\/a:pPr>)/);
    const lnSpc = sp.match(/<a:lnSpc>[\s\S]*?<\/a:lnSpc>/);
    const spcBef = sp.match(/<a:spcBef>[\s\S]*?<\/a:spcBef>/);
    const spcAft = sp.match(/<a:spcAft>[\s\S]*?<\/a:spcAft>/);
    const rPr = sp.match(/<a:rPr[\s\S]*?(?:\/>|<\/a:rPr>)/);

    console.log(`\n=== "${texts}" ===`);
    if (off && ext) {
      const x = +off[1] * EMU2PX, y = +off[2] * EMU2PX;
      const w = +ext[1] * EMU2PX, h = +ext[2] * EMU2PX;
      console.log(`  bounds: x=${x.toFixed(1)} y=${y.toFixed(1)} w=${w.toFixed(1)} h=${h.toFixed(1)} cy=${(y+h/2).toFixed(1)}`);
    }
    console.log(`  bodyPr: ${bodyPr?.[0] ?? "(none)"}`);
    console.log(`  pPr:    ${pPr?.[0]?.slice(0, 200) ?? "(none)"}`);
    console.log(`  lnSpc:  ${lnSpc?.[0] ?? "(ABSENT — wave1a skip path)"}`);
    console.log(`  spcBef: ${spcBef?.[0] ?? "(none)"}`);
    console.log(`  spcAft: ${spcAft?.[0] ?? "(none)"}`);
    console.log(`  rPr:    ${rPr?.[0]?.slice(0, 150) ?? "(none)"}`);
  }
})();

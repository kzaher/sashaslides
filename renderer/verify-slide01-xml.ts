import { readFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const JSZip = require("jszip");

(async () => {
  const zip = await JSZip.loadAsync(readFileSync("/tmp/verify.pptx"));
  const xml: string = await zip.file("ppt/slides/slide1.xml")!.async("string");
  const sps = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
  const EMU2PX = 1280 / 9144000;

  const targets = ["Get Started", "Contact Sales", "MOST POPULAR"];
  console.log("Inspecting CTA/chip shapes for <a:lnSpc> presence and spcPct value:\n");
  for (const sp of sps) {
    const textMatch = sp.match(/<a:t>([^<]*)<\/a:t>/g);
    if (!textMatch) continue;
    const texts = textMatch.map(m => m.replace(/<\/?a:t>/g, "")).join("|");
    if (!targets.some(t => texts.includes(t))) continue;
    const off = sp.match(/<a:off x="(\d+)" y="(\d+)"\/>/);
    const ext = sp.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    const spcPct = sp.match(/<a:spcPct val="(\d+)"/);
    if (off && ext) {
      const x = +off[1] * EMU2PX, y = +off[2] * EMU2PX;
      const h = +ext[2] * EMU2PX;
      console.log(`"${texts}"  (x=${x.toFixed(0)} y=${y.toFixed(0)} h=${h.toFixed(0)})  spcPct=${spcPct?.[1] ?? "(absent)"}`);
    }
  }
  // Also: count all spcPct on the slide to confirm they're distributed correctly.
  const all = [...xml.matchAll(/<a:spcPct val="(\d+)"/g)].map(m => +m[1]);
  const counts: Record<string, number> = {};
  for (const v of all) counts[v] = (counts[v] || 0) + 1;
  console.log(`\nAll spcPct values on slide_01 (count): ${JSON.stringify(counts)}`);
  console.log(`Total lnSpc elements: ${(xml.match(/<a:lnSpc>/g) || []).length}`);
})();

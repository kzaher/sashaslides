import { readFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const JSZip = require("jszip");

(async () => {
  const a = await JSZip.loadAsync(readFileSync("/tmp/current-slide01.pptx"));
  const b = await JSZip.loadAsync(readFileSync("/tmp/wave1a-only-slide01.pptx"));
  const xa = await a.file("ppt/slides/slide1.xml")!.async("string");
  const xb = await b.file("ppt/slides/slide1.xml")!.async("string");
  if (xa === xb) {
    console.log("slide1.xml IDENTICAL between current (wave1a+b) and wave1a-only");
  } else {
    console.log("slide1.xml DIFFERS");
    // Find first position of difference
    const len = Math.min(xa.length, xb.length);
    let i = 0;
    while (i < len && xa[i] === xb[i]) i++;
    const ctx = 200;
    console.log(`\nFirst divergence at char ${i}:`);
    console.log(`Current  : ...${xa.slice(Math.max(0, i - ctx), i + ctx)}...`);
    console.log(`\nWave1a-only: ...${xb.slice(Math.max(0, i - ctx), i + ctx)}...`);
    // Count lnSpc occurrences in each
    const cntA = (xa.match(/<a:lnSpc>/g) || []).length;
    const cntB = (xb.match(/<a:lnSpc>/g) || []).length;
    console.log(`\nlnSpc count: current=${cntA}  wave1a-only=${cntB}`);
    // Extract all spcPct values from each
    const pctsA = [...xa.matchAll(/<a:spcPct val="(\d+)"/g)].map(m => +m[1]);
    const pctsB = [...xb.matchAll(/<a:spcPct val="(\d+)"/g)].map(m => +m[1]);
    console.log(`spcPct values current  : ${pctsA.join(",")}`);
    console.log(`spcPct values wave1a-only: ${pctsB.join(",")}`);
  }
})();

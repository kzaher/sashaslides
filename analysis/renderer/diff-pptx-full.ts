import { readFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const JSZip = require("jszip");

(async () => {
  const a = await JSZip.loadAsync(readFileSync("/tmp/current-slide01.pptx"));
  const b = await JSZip.loadAsync(readFileSync("/tmp/wave1a-only-slide01.pptx"));
  // Compare every file in the zip.
  const namesA = Object.keys(a.files).filter(n => !a.files[n].dir).sort();
  const namesB = Object.keys(b.files).filter(n => !b.files[n].dir).sort();
  const all = new Set([...namesA, ...namesB]);
  for (const name of [...all].sort()) {
    const xa = a.file(name) ? await a.file(name)!.async("string") : null;
    const xb = b.file(name) ? await b.file(name)!.async("string") : null;
    if (xa === xb) continue;
    if (!xa) { console.log(`ONLY in wave1a-only: ${name} (${xb!.length} chars)`); continue; }
    if (!xb) { console.log(`ONLY in current:    ${name} (${xa!.length} chars)`); continue; }
    console.log(`\nDIFFERS: ${name}  (len current=${xa.length} wave1a-only=${xb.length})`);
    // Extract lnSpc + spcPct occurrences
    const lA = (xa.match(/<a:lnSpc>/g) || []).length;
    const lB = (xb.match(/<a:lnSpc>/g) || []).length;
    const pA = [...xa.matchAll(/<a:spcPct val="(\d+)"/g)].map(m => +m[1]);
    const pB = [...xb.matchAll(/<a:spcPct val="(\d+)"/g)].map(m => +m[1]);
    console.log(`  current lnSpc=${lA} spcPct=${pA.join(",")}`);
    console.log(`  wave1a  lnSpc=${lB} spcPct=${pB.join(",")}`);
  }
})();

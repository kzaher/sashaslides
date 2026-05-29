import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
const s=PNG.sync.read(readFileSync("/tmp/sxs/slides/slide_17.png"));const W=s.width;
// .rounded table (row1-L) CSS (88,92,...). TL corner slide ~ (110,115).
// Expect: pink wrapper → #d1d5db border ring (209,213,219) → indigo header (#4f46e5=79,70,229).
function px(x:number,y:number){const i=(y*W+x)*4;return `(${s.data[i]},${s.data[i+1]},${s.data[i+2]})`;}
console.log(".rounded TL corner diagonal (expect pink → grey border → indigo):");
for(let d=0;d<=16;d++){const x=108+d,y=110+d;console.log(`  (${x},${y}) = ${px(x,y)}`);}

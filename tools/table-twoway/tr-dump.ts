import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
const s=PNG.sync.read(readFileSync("/tmp/sxs/slides/slide_17.png"));const W=s.width;
// .colored TR corner: table right ~x=1490, top ~y=115. Dump grid.
function px(x:number,y:number){const i=(y*W+x)*4;return `(${s.data[i]},${s.data[i+1]},${s.data[i+2]})`;}
console.log(".colored TR corner — rows y=114..126, cols x=1480..1492:");
for(let y=114;y<=126;y++){
  let line=`y=${y}: `;
  for(let x=1480;x<=1492;x++) line+=px(x,y).padEnd(15);
  console.log(line);
}

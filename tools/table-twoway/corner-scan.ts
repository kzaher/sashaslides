import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
const s = PNG.sync.read(readFileSync("/tmp/sxs/slides/slide_17.png"));
const W = s.width;
// Scan TL corner box of .colored for WHITE pixels (R,G,B all high) — the
// wedge between pink frame and black cell. Pink=low G, black=low all.
function scanBox(name:string, x0:number,y0:number,x1:number,y1:number){
  const whites:[number,number][]=[];
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
    const i=(y*W+x)*4; const r=s.data[i],g=s.data[i+1],b=s.data[i+2];
    if(r>=215&&g>=215&&b>=215) whites.push([x,y]);
  }
  console.log(`${name}: ${whites.length} white(>=215) px`);
  if(whites.length) console.log("   "+whites.slice(0,30).map(([x,y])=>`(${x},${y})`).join(" "));
}
// table .colored bounds slide: x 830..1490, y 115..251
scanBox("TL", 826,111, 860,145);
scanBox("TR", 1460,111, 1494,145);
scanBox("BL", 826,221, 860,251);
scanBox("BR", 1460,221, 1494,251);

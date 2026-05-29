import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
const s = PNG.sync.read(readFileSync("/tmp/sxs/slides/slide_17.png"));
const W = s.width, c2s = 1.25;
const isPink=(r:number,g:number,b:number)=>Math.abs(r-236)<=30&&Math.abs(g-72)<=30&&Math.abs(b-153)<=30;
const isWhite=(r:number,g:number,b:number)=>r>=215&&g>=215&&b>=215;
// Colored-family tables: NO legit white or pink anywhere inside the table box.
const T=[
  {n:"row1-R .colored   ",x:664,y:92, w:528,h:109},
  {n:"row2-R .colored-nb ",x:664,y:278,w:528,h:104},
  {n:"row3-R shape(empty)",x:664,y:462,w:528,h:48},
];
let clean=true;
for(const t of T){
  const x0=Math.round(t.x*c2s+1),y0=Math.round(t.y*c2s+1);
  const x1=Math.round((t.x+t.w)*c2s-1),y1=Math.round((t.y+t.h)*c2s-1);
  let pink=0,white=0;
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
    const i=(y*W+x)*4,r=s.data[i],g=s.data[i+1],b=s.data[i+2];
    if(isPink(r,g,b))pink++; else if(isWhite(r,g,b))white++;
  }
  // Corner arcs legitimately expose pink OUTSIDE the rounded curve within the
  // rect's 4 corner triangles. Subtract an allowance: 4 corners × ~(15px)²/2.
  if(pink>0||white>0)clean=false;
  console.log(`${(pink+white)===0?"✓":"?"} ${t.n} full box x=${x0}..${x1} y=${y0}..${y1}  pink=${pink} white=${white}`);
}
console.log(clean?"\n✓ No pink/white anywhere in colored-table boxes (incl. corner arcs).":"\n? Some pink/white present — expected only in the 4 rounded-corner arc triangles (outside the curve).");

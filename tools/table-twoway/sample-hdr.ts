import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
function load(p:string){return PNG.sync.read(readFileSync(p));}
const o=load("/tmp/br-probe-original-native.png"), s=load("/tmp/sxs/slides/slide_17.png");
const X=820+340; // mid-table
for(const label of ["TOP edge (frame y8-12)","BOT edge (frame y23-27)"]){
  const ys = label.startsWith("TOP")?[576,577,578,579,580]:[591,592,593,594,595];
  console.log(label);
  for(const Y of ys){
    const i=(Y*o.width+X)*4;
    const oc=`(${o.data[i]},${o.data[i+1]},${o.data[i+2]})`;
    const sc=`(${s.data[i]},${s.data[i+1]},${s.data[i+2]})`;
    console.log(`  slideY=${Y} frameY=${Y-568}  chrome=${oc.padEnd(15)} slides=${sc}`);
  }
}

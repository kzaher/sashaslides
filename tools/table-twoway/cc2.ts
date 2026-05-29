import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
const s = PNG.sync.read(readFileSync("/tmp/sxs/slides/slide_17.png"));
const W=s.width, c2s=1.25, S=70, Z=5;
const tx=Math.round((664-10)*c2s), ty=Math.round((278-10)*c2s);
const tw=Math.round((528+20)*c2s), th=Math.round((104+20)*c2s);
for(const [n,cx,cy] of [["tl",tx,ty],["tr",tx+tw-S,ty],["bl",tx,ty+th-S],["br",tx+tw-S,ty+th-S]] as [string,number,number][]){
  const o=new PNG({width:S*Z,height:S*Z});
  for(let y=0;y<S*Z;y++)for(let x=0;x<S*Z;x++){const sx=cx+Math.floor(x/Z),sy=cy+Math.floor(y/Z),si=(sy*W+sx)*4,di=(y*o.width+x)*4;o.data[di]=s.data[si];o.data[di+1]=s.data[si+1];o.data[di+2]=s.data[si+2];o.data[di+3]=255;}
  writeFileSync(`/tmp/cnb-${n}.png`,PNG.sync.write(o));
}
console.log("wrote /tmp/cnb-{tl,tr,bl,br}.png");

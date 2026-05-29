import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
const slide = PNG.sync.read(readFileSync("/tmp/sxs/slides/slide_17.png"));
const W = slide.width;
// row1-R .colored CSS (664,92,528,109) → slide ×1.25. Include 12px wrapper pad.
const c2s = 1.25;
const tx = Math.round((664-10)*c2s), ty = Math.round((92-10)*c2s);
const tw = Math.round((528+20)*c2s), th = Math.round((109+20)*c2s);
const S = 70; // corner crop size (slide-px)
const ZOOM = 5;
const corners: [string,number,number][] = [
  ["tl", tx, ty], ["tr", tx+tw-S, ty], ["bl", tx, ty+th-S], ["br", tx+tw-S, ty+th-S],
];
for (const [name, cx, cy] of corners) {
  const out = new PNG({ width: S*ZOOM, height: S*ZOOM });
  for (let y=0;y<S*ZOOM;y++) for (let x=0;x<S*ZOOM;x++){
    const sx=cx+Math.floor(x/ZOOM), sy=cy+Math.floor(y/ZOOM);
    const si=(sy*W+sx)*4, di=(y*out.width+x)*4;
    out.data[di]=slide.data[si];out.data[di+1]=slide.data[si+1];out.data[di+2]=slide.data[si+2];out.data[di+3]=255;
  }
  writeFileSync(`/tmp/corner-colored-${name}.png`, PNG.sync.write(out));
}
console.log("wrote /tmp/corner-colored-{tl,tr,bl,br}.png (5x zoom)");

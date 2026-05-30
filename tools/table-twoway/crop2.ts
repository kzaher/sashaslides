import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
const R=PNG.sync.read(readFileSync("/tmp/sxs/slides/slide_17.png"));
const O=PNG.sync.read(readFileSync("/tmp/sxs/originals/slide_17.png"));
function crop(im:PNG,x:number,y:number,w:number,h:number,sc:number){const o=new PNG({width:Math.round(w*sc),height:Math.round(h*sc)});for(let yy=0;yy<o.height;yy++)for(let xx=0;xx<o.width;xx++){const sx=Math.round(x+xx/sc),sy=Math.round(y+yy/sc);const si=(sy*im.width+sx)*4,di=(yy*o.width+xx)*4;o.data[di]=im.data[si];o.data[di+1]=im.data[si+1];o.data[di+2]=im.data[si+2];o.data[di+3]=255;}return o;}
// .colored render: slide (820,108,680,150) ; original ×1.6
writeFileSync("/tmp/cmp-colored-render.png",PNG.sync.write(crop(R,820,108,680,150,2)));
writeFileSync("/tmp/cmp-colored-orig.png",PNG.sync.write(crop(O,820*1.6,108*1.6,680*1.6,150*1.6,2/1.6)));
// .colored-nb render: slide (820,340,680,150)
writeFileSync("/tmp/cmp-nb-render.png",PNG.sync.write(crop(R,820,340,680,150,2)));
writeFileSync("/tmp/cmp-nb-orig.png",PNG.sync.write(crop(O,820*1.6,340*1.6,680*1.6,150*1.6,2/1.6)));
console.log("wrote 4 crops");

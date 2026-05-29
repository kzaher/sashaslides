const fs=require('fs'),{PNG}=require('pngjs');
const png=PNG.sync.read(fs.readFileSync("/workspaces/sashaslides/.claude/worktrees/bs-wave33-A-1780091905168/.bug-solving-scratch/after/thumbs/slide_17.png"));
const W=png.width,H=png.height,d=png.data;
function p(x,y){const i=(y*W+x)*4;return [d[i],d[i+1],d[i+2]];}
function cls(r,g,b){if(r>235&&g>235&&b>235)return"W";if(r<75&&g<75&&b<75)return"K";if(r>222&&g>175&&g<240&&b>190&&b<245)return"P";return"o";}
// Find black header bands in right half (x>800). For each row count black pixels in x 850..1500
function blackInRow(y,x0,x1){let n=0;for(let x=x0;x<x1;x++){if(cls(...p(x,y))==="K")n++;}return n;}
let prev=false,bands=[];
for(let y=0;y<H;y++){const n=blackInRow(y,850,1560);const has=n>200;if(has&&!prev){bands.push([y,null]);}if(!has&&prev){bands[bands.length-1][1]=y;}prev=has;}
console.log("RIGHT-HALF black header bands (y ranges):");
bands.forEach(b=>console.log(b[0],"-",b[1],"h=",(b[1]||H)-b[0]));

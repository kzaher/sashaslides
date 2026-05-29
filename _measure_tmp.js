const fs=require('fs');
const {PNG}=require('pngjs');
const f="/workspaces/sashaslides/.claude/worktrees/bs-wave33-A-1780091905168/.bug-solving-scratch/after/thumbs/slide_17.png";
const png=PNG.sync.read(fs.readFileSync(f));
const W=png.width,H=png.height,d=png.data;
function p(x,y){const i=(y*W+x)*4;return [d[i],d[i+1],d[i+2]];}
console.log("SIZE",W,H,"scale1csspx=",(W/1280).toFixed(3));
function cls(r,g,b){
  if(r>235&&g>235&&b>235)return"W";
  if(r<75&&g<75&&b<75)return"K";
  if(r>225&&g>180&&g<238&&b>195&&b<242)return"P"; //pink
  return `(${r},${g},${b})`;
}
function rleRow(y,x0,x1){let out=[],prev=null,cnt=0,start=x0;for(let x=x0;x<x1;x++){const c=cls(...p(x,y));if(c!==prev){if(prev!==null)out.push([prev,cnt,start]);prev=c;cnt=1;start=x;}else cnt++;}out.push([prev,cnt,start]);return out;}
function rleCol(x,y0,y1){let out=[],prev=null,cnt=0,start=y0;for(let y=y0;y<y1;y++){const c=cls(...p(x,y));if(c!==prev){if(prev!==null)out.push([prev,cnt,start]);prev=c;cnt=1;start=y;}else cnt++;}out.push([prev,cnt,start]);return out;}
module.exports={W,H,p,cls,rleRow,rleCol,png};
// dump coarse map to find pink wrappers / black regions
let lines=[];
for(let y=0;y<H;y+=Math.floor(H/40)){let s="";for(let x=0;x<W;x+=Math.floor(W/80)){const[r,g,b]=p(x,y);const c=cls(r,g,b);s+= c==="P"?"P":c==="K"?"K":c==="W"?".":"#";}lines.push(s);}
console.log(lines.join("\n"));

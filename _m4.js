const fs=require('fs'),{PNG}=require('pngjs');
const png=PNG.sync.read(fs.readFileSync("/workspaces/sashaslides/.claude/worktrees/bs-wave33-A-1780091905168/.bug-solving-scratch/after/thumbs/slide_17.png"));
const W=png.width,H=png.height,d=png.data;
function p(x,y){const i=(y*W+x)*4;return [d[i],d[i+1],d[i+2]];}
function cls(r,g,b){if(r>235&&g>235&&b>235)return"W";if(r<75&&g<75&&b<75)return"K";if(r>222&&g>175&&g<240&&b>190&&b<245)return"P";return"o";}
function rleRow(y,x0,x1){let out=[],prev=null,cnt=0,start=x0;for(let x=x0;x<x1;x++){const c=cls(...p(x,y));if(c!==prev){if(prev!==null)out.push(prev+":"+cnt+"@"+start);prev=c;cnt=1;start=x;}else cnt++;}out.push(prev+":"+cnt+"@"+start);return out;}
function rleCol(x,y0,y1){let out=[],prev=null,cnt=0,start=y0;for(let y=y0;y<y1;y++){const c=cls(...p(x,y));if(c!==prev){if(prev!==null)out.push(prev+":"+cnt+"@"+start);prev=c;cnt=1;start=y;}else cnt++;}out.push(prev+":"+cnt+"@"+start);return out;}
// colored-nb header y=348-381. Scan full header row mid y=364 from x=780 (left of table) to find pink->black left edge
console.log("center-nb LEFT, full header row y=364, x=780..845:");
console.log(rleRow(364,780,845).join("  "));
// Find table right extent: scan header row for last black
let lastK=0,firstK=9999;for(let x=780;x<1599;x++){if(cls(...p(x,364))==="K"){if(x<firstK)firstK=x;lastK=x;}}
console.log("header firstK,lastK=",firstK,lastK);
// Body bottom: black header ends 381; body below. find table bottom = last non-pink? Body has pastel + black left col. Scan col at x=820 (black left column of nb) downward
console.log("center-nb left-col x=820 y=345..470:");
console.log(rleCol(820,345,470).join("  "));
// BR corner: right edge of body. scan body row y ~ 440 from right side
console.log("center-nb body row y=440 x=1380..1560:");
console.log(rleRow(440,1380,1560).join("  "));
// bottom edge at right col x=1450 going down
console.log("center-nb bottom col x=1450 y=400..520:");
console.log(rleCol(1450,400,520).join("  "));

const fs=require('fs'),{PNG}=require('pngjs');
const png=PNG.sync.read(fs.readFileSync("/workspaces/sashaslides/.claude/worktrees/bs-wave33-A-1780091905168/.bug-solving-scratch/after/thumbs/slide_17.png"));
const W=png.width,H=png.height,d=png.data;
function p(x,y){const i=(y*W+x)*4;return [d[i],d[i+1],d[i+2]];}
function cls(r,g,b){if(r>235&&g>235&&b>235)return"W";if(r<75&&g<75&&b<75)return"K";if(r>222&&g>175&&g<240&&b>190&&b<245)return"P";return"o";}
function rleRow(y,x0,x1){let out=[],prev=null,cnt=0,start=x0;for(let x=x0;x<x1;x++){const c=cls(...p(x,y));if(c!==prev){if(prev!==null)out.push(prev+":"+cnt+"@"+start);prev=c;cnt=1;start=x;}else cnt++;}out.push(prev+":"+cnt+"@"+start);return out;}
function rleCol(x,y0,y1){let out=[],prev=null,cnt=0,start=y0;for(let y=y0;y<y1;y++){const c=cls(...p(x,y));if(c!==prev){if(prev!==null)out.push(prev+":"+cnt+"@"+start);prev=c;cnt=1;start=y;}else cnt++;}out.push(prev+":"+cnt+"@"+start);return out;}
function raw(x,y){const [r,g,b]=p(x,y);return `${x},${y}=(${r},${g},${b})`;}

console.log("=== colored-nb header band y=348-381, mid y=364 ===");
// (A) LEFT EDGE: scan across header left, find pink->...->black transition. Header is at left of right-column table ~ x 840-870 wrapper edge
console.log("(A) LEFT row scan y=364, x 820..960:");
console.log(rleRow(364,820,960).join("  "));
console.log(" raw px:",[840,845,848,850,852,855,858,860,862,865,868].map(x=>raw(x,364)).join(" "));

console.log("(B) TOP col scan x=950 (in header), y 320..400:");
console.log(rleCol(950,320,400).join("  "));
console.log(" raw px:",[330,335,340,343,345,348,350,352].map(y=>raw(950,y)).join(" "));

// (C) BR corner of colored-nb. Need bottom & right extent. Table body bottom ~ before next band 578. Right edge: scan a body row.
console.log("(C) BR corner. Right edge body, scan row y=540 x 1480..1600:");
console.log(rleRow(540,1480,1599).join("  "));
console.log("    bottom edge, scan col x=1500 y=520..600:");
console.log(rleCol(1500,520,600).join("  "));

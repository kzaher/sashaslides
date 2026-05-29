const fs=require('fs'),{PNG}=require('pngjs');
const png=PNG.sync.read(fs.readFileSync("/workspaces/sashaslides/.claude/worktrees/bs-wave33-A-1780091905168/.bug-solving-scratch/after/thumbs/slide_17.png"));
const W=png.width,H=png.height,d=png.data;
function p(x,y){const i=(y*W+x)*4;return [d[i],d[i+1],d[i+2]];}
// pink wrapper = (236,72,153). classify with that.
function cls(r,g,b){
  if(r>235&&g>235&&b>235)return"W";        // white
  if(r<75&&g<75&&b<75)return"K";            // black
  if(r>215&&g>40&&g<110&&b>120&&b<185)return"P"; // hot pink wrapper
  return"o";                                 // pastel cell / AA
}
function rleRow(y,x0,x1){let out=[],prev=null,cnt=0,start=x0;for(let x=x0;x<x1;x++){const c=cls(...p(x,y));if(c!==prev){if(prev!==null)out.push(prev+":"+cnt+"@"+start);prev=c;cnt=1;start=x;}else cnt++;}out.push(prev+":"+cnt+"@"+start);return out;}
function rleCol(x,y0,y1){let out=[],prev=null,cnt=0,start=y0;for(let y=y0;y<y1;y++){const c=cls(...p(x,y));if(c!==prev){if(prev!==null)out.push(prev+":"+cnt+"@"+start);prev=c;cnt=1;start=y;}else cnt++;}out.push(prev+":"+cnt+"@"+start);return out;}
function raw(x,y){const[r,g,b]=p(x,y);return `${x}:(${r},${g},${b})`;}

console.log("== CENTER-NB ==");
console.log("(A) LEFT, header y=364 x=795..845:");
console.log(rleRow(364,795,845).join(" "));
console.log("   raw:",[804,808,812,816,820,824,828,830,832].map(x=>raw(x,364)).join(" "));
console.log("(B) TOP, header x=1100 y=330..360:");
console.log(rleCol(1100,330,362).join(" "));
console.log("   raw:",[336,338,340,342,344,346,348,350].map(y=>raw(1100,y)).join(" "));
// BR corner: find table bottom & right. Body pastel cells. find right edge by scanning body row for P(wrapper) on right
console.log("(C) BR. body row y=440 x=1460..1530:");
console.log(rleRow(440,1460,1530).join(" "));
console.log("   raw:",[1482,1486,1488,1490,1492,1494,1496,1500].map(x=>raw(x,440)).join(" "));
// bottom of body: scan down a body cell column x=1300
console.log("    body col x=1300 y=440..500:");
console.log(rleCol(1300,440,500).join(" "));
console.log("   raw:",[470,474,476,478,480,482,484,488].map(y=>raw(1300,y)).join(" "));

console.log("\n== TOP-RIGHT .colored (header y=117-147) ==");
// perimeter: outer should be white 1px border. Top-left corner area. wrapper pink then white border then black header.
console.log("TR LEFT, header y=132 x=795..845:");
console.log(rleRow(132,795,845).join(" "));
console.log("   raw:",[806,810,814,818,822,826,830,832].map(x=>raw(x,132)).join(" "));
console.log("TR TOP, x=1100 y=100..130:");
console.log(rleCol(1100,100,130).join(" "));
console.log("   raw:",[108,110,112,114,116,118].map(y=>raw(1100,y)).join(" "));
// TR BR corner: body row & col
console.log("TR BR, body row y=210 x=1460..1530:");
console.log(rleRow(210,1460,1530).join(" "));
console.log("TR BR, body col x=1300 y=245..300:");
console.log(rleCol(1300,245,300).join(" "));

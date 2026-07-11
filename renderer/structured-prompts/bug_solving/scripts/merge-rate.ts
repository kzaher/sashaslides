/**
 * merge-rate.ts — the BLOCKING human rating UI for the merge's changed slides.
 *
 * llm-merge.ts's `mergeRatingViaUI` execs this (stdio inherited) and waits: it
 * boots a tiny HTTP server showing each CHANGED slide's MERGED render ("proposed")
 * next to its APPROVED reference, with per-slide GREEN/RED and a REJECT ALL & STOP
 * convenience (= red every shown slide). On submit it writes the verdict and exits,
 * unblocking the merge. See docs/merge-flow.drawio (ALL_AT_ONCE_RATE / SEQ_RATE).
 *
 *   argv: merge-rate.ts <input.json> <verdict.json>
 *   input.json:  { phase, label, slides: [{ slide, test: absPath|null, original: absPath|null }] }
 *   verdict.json (written on submit): { green: string[], red: string[], stopAll: boolean }
 */
import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { extname } from "node:path";

interface SlidePair { slide: string; test: string | null; original: string | null; }
interface Input { phase: string; label: string; slides: SlidePair[]; }

const [inputPath, outPath] = process.argv.slice(2);
if (!inputPath || !outPath) { console.error("usage: merge-rate.ts <input.json> <verdict.json>"); process.exit(2); }
const input = JSON.parse(readFileSync(inputPath, "utf8")) as Input;

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

function page(): string {
  const cards = input.slides.map((s, i) => `
    <div class="card" data-slide="${s.slide}" data-i="${i}">
      <div class="hdr"><b>${s.slide}</b> <span class="verdict" id="v${i}">— unrated</span></div>
      <div class="imgs">
        <figure><figcaption>approved (reference)</figcaption>${s.original && existsSync(s.original) ? `<img src="/img?p=${encodeURIComponent(s.original)}">` : `<div class="noimg">no approved image</div>`}</figure>
        <figure><figcaption>proposed (merged)</figcaption>${s.test && existsSync(s.test) ? `<img src="/img?p=${encodeURIComponent(s.test)}">` : `<div class="noimg">no merged image</div>`}</figure>
      </div>
      <div class="btns"><button class="g" onclick="rate(${i},'green')">✓ GREEN (accept)</button><button class="r" onclick="rate(${i},'red')">✗ RED (reject)</button></div>
    </div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>merge rating — ${input.phase}: ${input.label}</title>
<style>
body{font:14px system-ui,sans-serif;margin:0;background:#111;color:#eee}
header{position:sticky;top:0;background:#1b1b1b;padding:12px 16px;border-bottom:1px solid #333;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header h1{font-size:15px;margin:0;font-weight:600}
.spacer{flex:1}
button{cursor:pointer;border:0;border-radius:6px;padding:8px 12px;font-weight:600}
.card{border:1px solid #333;border-radius:8px;margin:16px;overflow:hidden}
.hdr{padding:8px 12px;background:#1b1b1b;border-bottom:1px solid #333}
.verdict.green{color:#5cd65c}.verdict.red{color:#ff6b6b}
.imgs{display:flex;gap:8px;padding:12px;flex-wrap:wrap}
figure{margin:0;flex:1;min-width:280px}figcaption{color:#aaa;font-size:12px;margin-bottom:4px}
img{max-width:100%;border:1px solid #333;background:#fff}
.noimg{padding:40px;text-align:center;color:#777;border:1px dashed #444}
.btns{display:flex;gap:8px;padding:0 12px 12px}
.btns .g{background:#1f6f1f;color:#fff}.btns .r{background:#7a2020;color:#fff}
.card.green{outline:2px solid #5cd65c}.card.red{outline:2px solid #ff6b6b}
#submit{background:#2d6cdf;color:#fff}#submit:disabled{opacity:.4;cursor:not-allowed}
#stopall{background:#7a2020;color:#fff}
#count{color:#aaa}
</style></head><body>
<header>
  <h1>MERGE RATING — ${input.phase}: ${input.label}</h1>
  <span id="count"></span><div class="spacer"></div>
  <button id="stopall" onclick="stopAll()">REJECT ALL &amp; STOP</button>
  <button id="submit" disabled onclick="submit()">SUBMIT</button>
</header>
${cards}
<script>
const N=${input.slides.length}, slides=${JSON.stringify(input.slides.map((s) => s.slide))};
const v={};
function rate(i,val){v[i]=val;const c=document.querySelectorAll('.card')[i];c.classList.remove('green','red');c.classList.add(val);const el=document.getElementById('v'+i);el.className='verdict '+val;el.textContent=val==='green'?'— GREEN (accept)':'— RED (reject)';refresh();}
function refresh(){const done=Object.keys(v).length;document.getElementById('count').textContent=done+' / '+N+' rated';document.getElementById('submit').disabled=done<N;}
function submit(){const green=[],red=[];for(let i=0;i<N;i++){(v[i]==='green'?green:red).push(slides[i]);}post({green,red,stopAll:false});}
function stopAll(){if(!confirm('Reject ALL '+N+' shown slide(s) and stop rating this batch?'))return;post({green:[],red:slides.slice(),stopAll:true});}
function post(body){fetch('/api/verdict',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(()=>{document.body.innerHTML='<h1 style="padding:40px">Recorded. You can close this tab.</h1>';});}
refresh();
</script></body></html>`;
}

function boot(port: number, attemptsLeft: number): void {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(page()); return; }
    if (url.pathname === "/img") {
      const p = url.searchParams.get("p") ?? "";
      if (p && existsSync(p)) { res.setHeader("content-type", MIME[extname(p).toLowerCase()] ?? "application/octet-stream"); res.end(readFileSync(p)); return; }
      res.statusCode = 404; res.end("no image"); return;
    }
    if (url.pathname === "/api/verdict" && req.method === "POST") {
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", () => {
        let v: { green?: string[]; red?: string[]; stopAll?: boolean };
        try { v = JSON.parse(body); } catch { res.statusCode = 400; res.end("bad json"); return; }
        writeFileSync(outPath, JSON.stringify({ green: v.green ?? [], red: v.red ?? [], stopAll: !!v.stopAll }));
        res.end("ok");
        console.error(`[merge-rate] verdict recorded: green=${(v.green ?? []).length} red=${(v.red ?? []).length}${v.stopAll ? " (reject-all)" : ""}`);
        server.close(); setTimeout(() => process.exit(0), 200).unref();
      });
      return;
    }
    res.statusCode = 404; res.end("not found");
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE" && attemptsLeft > 0) { boot(port + 1, attemptsLeft - 1); return; }
    console.error(`[merge-rate] server error: ${e.message}`); process.exit(3);
  });
  server.listen(port, () => {
    console.error(`\n┌── MERGE RATING (${input.phase}: ${input.label}) — ${input.slides.length} changed slide(s)`);
    console.error(`│ Rate here:  http://localhost:${port}/`);
    console.error(`│ GREEN = accept (becomes the new approved) · RED = reject · REJECT ALL & STOP = red everything`);
    console.error(`└── (the merge is BLOCKED until you submit)\n`);
  });
}

boot(Number(process.env.MERGE_RATE_PORT ?? 4790), 40);

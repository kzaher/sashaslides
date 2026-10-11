// Regenerates index.html by inlining each concept-*.svg as an <svg><symbol>, so
// currentColor and --sasha-accent resolve from the surrounding wrapper.
// Run: node build-index.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

const CONCEPTS = [
  { file: "concept-1-pilot-head.svg",   name: "Pilot",      verdict: "warn", measure: "anchor 4.0px \u00b7 one mass \u00b7 keeps its shape, loses its species",       rationale: "A cute geometric sheepdog head, mark only: shaggy forelock, drop ears with a lighter inner ear, and a visor knocked clean out of the silhouette so the eyes are the brightest thing in the mark." },
  { file: "concept-2-frame-hound.svg",  name: "Frame Hound", verdict: "pass", measure: "anchor 4.0px \u00b7 ink dominance 0.98 \u00b7 ears, eye slit and mouth all still read",  rationale: "The 16:9 slide frame IS the dog's head — two folded ears on the top corners, a visor window where the content would be, and two bullet lines for the deck." },
  { file: "concept-3-flock-pen.svg",    name: "Flock Pen",   verdict: "fail", measure: "anchor 5.7px but ink dominance 0.81 across 4 separated masses \u2014 reads as noise",    rationale: "The literal pun: each sheep IS a slide \u2014 a 16:9 body under a fleece of bumps \u2014 trotting right out of the scattered margin and into an open corral, motion dashes trailing behind." },
  { file: "concept-4-tailmark.svg",     name: "Tailmark",    verdict: "pass", measure: "S stroke 3.4px \u00b7 single ink mass (dominance 1.00) \u00b7 letterform holds",     rationale: "An abstract S monogram whose top terminal flares into an ear and whose bottom flicks into a tail, drawn straight through a 16:9 slide frame." },
  { file: "concept-5-rally-arc.svg",    name: "Rally",       verdict: "warn", measure: "anchor 3.1px \u00b7 nothing under 1.3px \u00b7 ring holds, the three strays merge into one blob",        rationale: "Pure herding motion with no animal in it: a fat arc sweeps almost the full circle to gather three strays, and a detached arrowhead closes the gate." },
  { file: "concept-6-corral-seal.svg",  name: "Corral Seal", verdict: "pass", measure: "anchor 5.0px \u00b7 only 2.3% of mass in sub-1.3px detail \u00b7 simplest silhouette of the six",  rationale: "Favicon-first emblem: one solid disc with two ear bumps breaking the top edge and a single bright 16:9 window punched clean through the middle. Round on purpose, so it never collides with concept 2 in a tab strip." },
];

const PALETTE = [
  ["Ink",    "#1E1B3A", "Light-mode foreground"],
  ["Paper",  "#FFF8F0", "Light background"],
  ["Night",  "#0D0F1C", "Dark background"],
  ["Violet", "#6C4BF4", "Light-mode accent"],
  ["Mint",   "#19D3C5", "Dark-mode accent"],
  ["Amber",  "#FFB020", "Tertiary: UI and lockup only, never inside a mark"],
];

const symbols = [];
const inner = (svg) => svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").trim();

CONCEPTS.forEach((c, i) => {
  const raw = readFileSync(c.file, "utf8");
  c.bytes = Buffer.byteLength(raw);
  symbols.push(`<symbol id="mark${i + 1}" viewBox="0 0 256 256">${inner(raw)}</symbol>`);
});

const sizes = [256, 64, 16];
const use = (i, px) =>
  `<svg class="mark" width="${px}" height="${px}" viewBox="0 0 256 256" aria-hidden="true"><use href="#mark${i}"/></svg>`;

const panel = (i, mode) => `
        <div class="panel ${mode}">
          <div class="panel-tag">${mode === "light" ? "Paper #FFF8F0" : "Night #0D0F1C"}</div>
          <div class="stack">
            ${sizes.map((px) => `<figure class="slot s${px}">${use(i, px)}<figcaption>${px}px</figcaption></figure>`).join("\n            ")}
          </div>
        </div>`;

const cards = CONCEPTS.map((c, idx) => {
  const i = idx + 1;
  return `
      <article class="card">
        <header class="card-head">
          <span class="num">${i}</span>
          <h2>${c.name}</h2>
          <code class="file">${c.file} &middot; ${c.bytes} B</code>
        </header>
        <p class="rationale">${c.rationale}</p>
        <p class="verdict v-${c.verdict}"><b>${{pass:"Survives 16px",warn:"16px: degraded",fail:"Fails at 16px"}[c.verdict]}</b> &mdash; ${c.measure}</p>
        <div class="panels">${panel(i, "light")}${panel(i, "dark")}
        </div>
      </article>`;
}).join("\n");

const faviconRow = (mode) => `
        <div class="panel ${mode} favrow">
          <div class="panel-tag">${mode === "light" ? "Paper" : "Night"} &middot; rendered at exactly 16&times;16, no scaling</div>
          <div class="favstrip">
            ${CONCEPTS.map((c, idx) => `<figure class="favslot">${use(idx + 1, 16)}<figcaption>${idx + 1}</figcaption></figure>`).join("\n            ")}
          </div>
        </div>`;

const lockups = CONCEPTS.map((c, idx) => `
          <div class="lockup">${use(idx + 1, 40)}<span class="wordmark">Sasha<strong>Slides</strong></span></div>`).join("");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sasha Slides &mdash; Six Logo Concepts</title>
<style>
  :root{
    --ink:#1E1B3A; --paper:#FFF8F0; --night:#0D0F1C;
    --violet:#6C4BF4; --mint:#19D3C5; --amber:#FFB020;
    --page:#F3EFE9; --rule:#D9D2C8;
  }
  *{box-sizing:border-box}
  body{
    margin:0; padding:32px 28px 72px;
    background:var(--page); color:var(--ink);
    font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  }
  h1{margin:0 0 6px; font-size:28px; letter-spacing:-.02em}
  .sub{margin:0 0 26px; max-width:76ch; color:#5B5570}

  /* The two documented wrappers. Every mark below is the SAME markup; only these differ. */
  .light{ color:var(--ink);   --sasha-accent:var(--violet); background:var(--paper); }
  .dark { color:var(--paper); --sasha-accent:var(--mint);   background:var(--night); }

  .palette{display:flex; flex-wrap:wrap; gap:10px; margin:0 0 30px; padding:0; list-style:none}
  .palette li{display:flex; align-items:center; gap:9px; background:#fff; border:1px solid var(--rule);
    border-radius:9px; padding:7px 12px 7px 8px; font-size:12.5px}
  .chip{width:26px; height:26px; border-radius:6px; border:1px solid rgba(0,0,0,.18); flex:0 0 auto}
  .palette b{font-weight:650} .palette span{color:#6B6580}

  .note{margin:0 0 34px; padding:13px 16px; background:#fff; border:1px solid var(--rule);
    border-left:4px solid var(--violet); border-radius:8px; font-size:13px; max-width:92ch}
  .note code{background:#F1EDF8; padding:1px 5px; border-radius:4px; font-size:12px}

  .grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(520px,1fr)); gap:22px}
  .card{background:#fff; border:1px solid var(--rule); border-radius:14px; padding:18px 18px 20px}
  .card-head{display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:8px}
  .num{display:grid; place-items:center; width:24px; height:24px; border-radius:50%;
    background:var(--violet); color:#fff; font-size:13px; font-weight:700; flex:0 0 auto}
  .card-head h2{margin:0; font-size:18px; letter-spacing:-.01em}
  .file{margin-left:auto; font-size:11.5px; color:#8A849B; font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .rationale{margin:0 0 15px; font-size:13.5px; color:#4A4560; min-height:3.2em}

  .verdict{margin:-6px 0 14px; font-size:12px; padding:6px 10px; border-radius:7px; line-height:1.45}
  .verdict b{font-weight:700}
  .v-pass{background:#E8F7F1; color:#14624A; border:1px solid #BFE6D6}
  .v-warn{background:#FFF4E0; color:#7A5410; border:1px solid #F3DCAE}
  .v-fail{background:#FDEBEC; color:#8A2630; border:1px solid #F3C9CD}
  .panels{display:grid; grid-template-columns:1fr 1fr; gap:12px}
  .panel{border-radius:11px; padding:12px 12px 10px; border:1px solid var(--rule); overflow:hidden}
  .panel.dark{border-color:#2A2C42}
  .panel-tag{font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; opacity:.55; margin-bottom:10px}
  .stack{display:flex; align-items:flex-end; justify-content:center; gap:14px}
  .slot{margin:0; display:flex; flex-direction:column; align-items:center; gap:7px}
  .slot figcaption{font-size:10px; opacity:.5; font-variant-numeric:tabular-nums}
  .s256 .mark{width:120px; height:120px}   /* 256 artwork shown at 120px to fit the grid */
  .mark{display:block}

  .favband{margin-top:34px; background:#fff; border:1px solid var(--rule); border-radius:14px; padding:18px}
  .favband h2{margin:0 0 4px; font-size:18px}
  .favband .method{font-size:12.5px; color:#5B5570; max-width:100ch; background:#FAF8F4;
    border:1px solid var(--rule); border-radius:8px; padding:12px 15px; margin:10px 0 18px; max-width:none}
  .favband p{margin:0 0 14px; font-size:13px; color:#4A4560}
  .favrows{display:grid; grid-template-columns:1fr 1fr; gap:12px}
  .favstrip{display:flex; gap:30px; align-items:center; justify-content:center; padding:10px 0 4px}
  .favslot{margin:0; display:flex; flex-direction:column; align-items:center; gap:8px}
  .favslot figcaption{font-size:10px; opacity:.5}

  .lockband{margin-top:22px; background:#fff; border:1px solid var(--rule); border-radius:14px; padding:18px}
  .lockband h2{margin:0 0 14px; font-size:18px}
  .lockups{display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:14px}
  .lockup{display:flex; align-items:center; gap:11px; padding:12px 14px; border-radius:10px}
  .lockups > .lockup:nth-child(odd){background:var(--paper); color:var(--ink); --sasha-accent:var(--violet)}
  .lockups > .lockup:nth-child(even){background:var(--night); color:var(--paper); --sasha-accent:var(--mint)}
  .wordmark{font:600 19px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    letter-spacing:-.025em}
  .wordmark strong{font-weight:400; opacity:.72}
</style>
</head>
<body>

<h1>Sasha Slides &mdash; six logo concepts</h1>
<p class="sub">Each mark is one hand-authored SVG on a <code>0 0 256 256</code> viewBox, no fonts inside the mark, no raster
tracing. Every mark uses exactly <b>two paints</b> &mdash; <code>currentColor</code> and <code>--sasha-accent</code> &mdash; and every
hole is <b>true negative space</b>, so it can never lose contrast against the background it sits on.</p>

<ul class="palette">
${PALETTE.map(([n, hex, use]) => `  <li><span class="chip" style="background:${hex}"></span><b>${n}</b> <code>${hex}</code> <span>${use}</span></li>`).join("\n")}
</ul>

<div class="note">
<b>The documented wrapper.</b> One file per concept serves both backgrounds. Put the mark inside an element that sets
two properties &mdash; light: <code>color:#1E1B3A; --sasha-accent:#6C4BF4</code> on <code>#FFF8F0</code>; dark:
<code>color:#FFF8F0; --sasha-accent:#19D3C5</code> on <code>#0D0F1C</code>. The accent flips violet&rarr;mint on purpose:
mint only reaches usable contrast on the night background, violet only on paper. Amber is deliberately kept out of the
marks for the same reason. Note that <code>currentColor</code> requires the SVG to be inlined or
<code>&lt;use&gt;</code>d &mdash; referenced through <code>&lt;img src&gt;</code> it falls back to black, which is still
a valid light-mode rendering. None of these hues sit near Google's brand blues (#4285F4 / #1A73E8 / #174EA6).
</div>

<div class="grid">
${cards}
</div>

<section class="favband">
  <h2>Favicon honesty check</h2>
  <p>All six at <b>exactly 16&times;16 device pixels</b>, nothing scaled up. This row is the real test.</p>
  <p class="method">Tested by rendering each mark alone into a 16&times;16 cell in headless Chrome at
  <code>deviceScaleFactor: 1</code>, then measuring the raster. Two numbers decide it: the <b>anchor feature</b>
  (max inscribed diameter of the mark's largest shape, in device pixels at 16&times;16) and <b>ink dominance</b>
  (largest connected ink mass &divide; total ink). Every one of the six is structurally fat &mdash; 93&ndash;100% of each
  mark's mass sits in features wider than 1.3px &mdash; so thinness is not what separates them. <b>Fragmentation is.</b>
  Concept 3 has the fattest single feature of all six (5.7px, the corral rail) and still fails, because its ink
  scatters into four separated masses with no figure to lock onto. Concept 6 is split too, but its split is the one
  intentional window, so it stays one object.</p>
  <div class="favrows">${faviconRow("light")}${faviconRow("dark")}
  </div>
</section>

<section class="lockband">
  <h2>Lockups</h2>
  <div class="lockups">${lockups}
  </div>
</section>

<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
${symbols.join("\n")}
</defs></svg>

</body>
</html>
`;

writeFileSync("index.html", html);
console.log("wrote index.html", Buffer.byteLength(html), "bytes");

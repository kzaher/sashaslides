#!/usr/bin/env npx tsx
/**
 * e2e.ts — full, self-contained E2E for the html2slides Slides add-on.
 *
 * No manual browser steps. Phases (run all, or one via `--phase <name>`):
 *   auth    ensure .auth/tokens.json has the script.projects scope; if not,
 *           spawn mint-token.ts and drive consent through the signed-in
 *           Chrome on :9222 (account chooser / "unverified" / Allow).
 *   deploy  push appsscript.json + Code.gs + Sidebar.html to a bound Apps
 *           Script project (created once, scriptId cached) via the Apps
 *           Script API projects.create / projects.updateContent.
 *   ui      reload the presentation, open Extensions → html2slides sidebar,
 *           queue a demo .html via the sidebar file input, click Insert.
 *   verify  assert the deck's slide count increased.
 *
 * Instrumentation (always on): every CDP target gets console + exception
 * scraping (→ /tmp/e2e-out/console.log) and screenshots are written to
 * /tmp/e2e-out/NN_label.png. Re-run and read those to iterate.
 */
import CDP from "chrome-remote-interface";
import { google } from "googleapis";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { spawn } from "child_process";

const ROOT = "/workspaces/sashaslides";
const PID = process.env.PID || "1If1xjsogouF6tx_O_e0HFHHUYAjf1bfdh8grEB2aTz4";
const ADDON = `${ROOT}/dist/renderer/html2slides/addon`;
const TOKENS = `${ROOT}/.auth/tokens.json`;
const OAUTH = `${ROOT}/.auth/google_oauth.json`;
const SCRIPTID_CACHE = `${ROOT}/.auth/addon-script-id.txt`;
const DEMO_HTML = `${ROOT}/renderer/html2slides/e2e/fixtures/slide_31.html`;
const OUT = "/tmp/e2e-out";
const PORT = 9222;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

let shotN = 0;
const consoleLog: string[] = [];
function logc(s: string) { consoleLog.push(s); writeFileSync(`${OUT}/console.log`, consoleLog.join("\n")); console.log(s); }

/** Attach console + exception scraping to a CDP client, tagged by `tag`. */
async function instrument(client: any, tag: string) {
  const { Runtime } = client;
  await Runtime.enable().catch(() => {});
  Runtime.consoleAPICalled((e: any) => {
    const txt = (e.args || []).map((a: any) => a.value ?? a.description ?? a.unserializableValue ?? "").join(" ");
    logc(`[${tag}][${e.type}] ${txt}`);
  });
  Runtime.exceptionThrown((e: any) => {
    const d = e.exceptionDetails;
    logc(`[${tag}][EXCEPTION] ${d.exception?.description || d.text}`);
  });
}

async function shot(client: any, label: string) {
  try {
    const { data } = await client.Page.captureScreenshot({ format: "png" });
    const p = `${OUT}/${String(++shotN).padStart(2, "0")}_${label}.png`;
    writeFileSync(p, Buffer.from(data, "base64"));
    logc(`  shot → ${p}`);
  } catch (e) { logc(`  shot(${label}) failed: ${(e as Error).message}`); }
}

async function click(Input: any, x: number, y: number) {
  await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(50);
  await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
/** Click the first VISIBLE element (any role) whose trimmed text matches. */
async function clickText(Runtime: any, Input: any, texts: string[]): Promise<string | null> {
  const r = await Runtime.evaluate({
    returnByValue: true,
    expression: `(() => {
      const ts = ${JSON.stringify(texts)};
      const els = document.querySelectorAll('button,[role=button],[role=menuitem],a,span,div,li');
      for (const el of els) {
        const t = (el.textContent || '').trim();
        if (ts.some(x => t === x || t.startsWith(x))) {
          const b = el.getBoundingClientRect();
          if (b.width > 1 && b.height > 1) return { x: b.x + b.width/2, y: b.y + b.height/2, t: t.slice(0,40) };
        }
      }
      return null;
    })()`,
  });
  if (r.result.value) { await click(Input, r.result.value.x, r.result.value.y); return r.result.value.t; }
  return null;
}

const NEED_SCOPES = ["script.projects", "cloud-platform"];
function tokenHasScriptScope(): boolean {
  if (!existsSync(TOKENS)) return false;
  try { const s = JSON.parse(readFileSync(TOKENS, "utf-8")).scope || ""; return NEED_SCOPES.every((x) => s.includes(x)); }
  catch { return false; }
}
const GCP_PROJECT = "982862611156";
function authClient() {
  const creds = JSON.parse(readFileSync(OAUTH, "utf-8")).installed;
  const tokens = JSON.parse(readFileSync(TOKENS, "utf-8"));
  const o = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost:8080");
  o.setCredentials(tokens);
  return o;
}

// ---- phase: auth ----------------------------------------------------------
async function phaseAuth() {
  if (tokenHasScriptScope()) { logc("auth: tokens.json already has script.projects — skip"); return; }
  logc("auth: minting token (consent via signed-in Chrome)…");
  const child = spawn("npx", ["tsx", `${ROOT}/renderer/html2slides/addon/mint-token.ts`], { cwd: ROOT });
  let authUrl = "";
  const done = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (d) => { const s = d.toString(); process.stdout.write("[mint] " + s);
      const m = s.match(/AUTH_URL=(\S+)/); if (m) authUrl = m[1];
      if (/TOKENS_SAVED/.test(s)) resolve();
    });
    child.stderr.on("data", (d) => process.stderr.write("[mint:err] " + d.toString()));
    child.on("exit", (c) => c === 0 ? resolve() : reject(new Error("mint-token exited " + c)));
  });
  for (let i = 0; i < 40 && !authUrl; i++) await sleep(150);
  if (!authUrl) throw new Error("no AUTH_URL from mint-token");
  logc("auth: driving consent…");
  // IMPORTANT: open a blank tab then Page.navigate — CDP.New passes the URL as a
  // DevTools HTTP query param, which mangles long OAuth URLs (drops response_type
  // → Google "Access blocked: response_type missing"). Page.navigate is clean.
  const tab = await (CDP as any).New({ port: PORT, url: "about:blank" });
  const cc = await CDP({ target: tab, port: PORT });
  await cc.Page.enable(); await instrument(cc, "consent");
  // Tall viewport so the Allow/Continue button (below a long scopes list) is on-screen.
  await cc.Emulation.setDeviceMetricsOverride({ width: 900, height: 1300, deviceScaleFactor: 1, mobile: false });
  await cc.Page.navigate({ url: authUrl });
  // Click the actual <button>/[role=button] whose exact text matches (shortest
  // match wins → the real button, not a container like "AllowDeny").
  const clickBtn = async (texts: string[]): Promise<string | null> => {
    const r = await cc.Runtime.evaluate({ returnByValue: true, expression: `(() => {
      const ts = ${JSON.stringify(texts)};
      const els = [...document.querySelectorAll('button,[role=button],a[href]')]
        .map(el => ({ el, t: (el.textContent||'').trim() }))
        .filter(o => ts.some(x => o.t === x || o.t.startsWith(x)))
        .sort((a,b) => a.t.length - b.t.length);
      for (const o of els) { const b = o.el.getBoundingClientRect();
        if (b.width>1 && b.height>1) { o.el.scrollIntoView({block:'center'}); const r=o.el.getBoundingClientRect();
          return { x: r.x+r.width/2, y: r.y+r.height/2, t: o.t.slice(0,40) }; } }
      return null; })()` });
    if (r.result.value) { await click(cc.Input, r.result.value.x, r.result.value.y); return r.result.value.t; }
    return null;
  };
  for (let step = 0; step < 12; step++) {
    await sleep(2500); await shot(cc, `consent_${step}`);
    const url = (await cc.Runtime.evaluate({ returnByValue: true, expression: "location.href" })).result.value as string;
    if (url.includes("localhost:8080")) { logc("auth: redirect captured"); break; }
    let clicked: string | null = null;
    if (/accountchooser|signin\/v2\/identifier|selectaccount/i.test(url)) {
      // Account chooser — the row is a div/li, not a button.
      clicked = await clickText(cc.Runtime, cc.Input, ["ante.materija@gmail.com", "ante.materija"]);
    } else {
      clicked = await clickBtn(["Continue", "Allow", "Tillåt", "Fortsätt"]);
      if (!clicked) clicked = await clickBtn(["Go to ", "Advanced", "Avancerat"]);
    }
    logc(`auth: consent step ${step} url=${url.slice(0, 55)} clicked=${clicked}`);
  }
  await cc.close();
  await Promise.race([done, sleep(8000)]);
  if (!tokenHasScriptScope()) throw new Error("auth failed — tokens.json still lacks script.projects");
  logc("auth: token has script.projects ✓");
}

// ---- phase: enableapi -----------------------------------------------------
async function phaseEnableApi() {
  const su = google.serviceusage({ version: "v1", auth: authClient() as any });
  const name = `projects/${GCP_PROJECT}/services/script.googleapis.com`;
  try {
    const got = await su.services.get({ name });
    if (got.data.state === "ENABLED") { logc("enableapi: script.googleapis.com already ENABLED"); return; }
  } catch (e) { logc("enableapi: get failed (continuing to enable): " + (e as Error).message); }
  logc("enableapi: enabling script.googleapis.com via Service Usage API…");
  const op = await su.services.enable({ name });
  logc("enableapi: enable op done=" + op.data.name + " — waiting for propagation…");
  await sleep(20000);
  logc("enableapi: ✓ (give it up to a minute to fully propagate)");
}

// ---- phase: deploy --------------------------------------------------------
async function phaseDeploy() {
  const script = google.script({ version: "v1", auth: authClient() as any });
  let scriptId = existsSync(SCRIPTID_CACHE) ? readFileSync(SCRIPTID_CACHE, "utf-8").trim() : "";
  if (!scriptId) {
    logc("deploy: creating bound script…");
    const r = await script.projects.create({ requestBody: { title: "html2slides", parentId: PID } });
    scriptId = r.data.scriptId!;
    writeFileSync(SCRIPTID_CACHE, scriptId);
    logc("deploy: scriptId=" + scriptId);
  } else logc("deploy: reusing scriptId=" + scriptId);
  const files = [
    { name: "appsscript", type: "JSON", source: readFileSync(`${ADDON}/appsscript.json`, "utf-8") },
    { name: "Code", type: "SERVER_JS", source: readFileSync(`${ADDON}/Code.gs`, "utf-8") },
    { name: "Sidebar", type: "HTML", source: readFileSync(`${ADDON}/Sidebar.html`, "utf-8") },
  ];
  await script.projects.updateContent({ scriptId, requestBody: { files } as any });
  logc(`deploy: pushed ${files.length} files ✓`);
  return scriptId;
}

// ---- phase: ui ------------------------------------------------------------
async function findPresTab() {
  const tabs = await (CDP as any).List({ port: PORT });
  return tabs.find((t: any) => t.type === "page" && t.url.includes(PID));
}
async function phaseUi() {
  let tab = await findPresTab();
  const c = await CDP({ target: tab, port: PORT });
  await c.Page.enable(); await instrument(c, "slides");
  logc("ui: reloading presentation to pick up the deployed bound script…");
  await c.Page.reload({}); await sleep(9000); await shot(c, "reloaded");
  const before = (await c.Runtime.evaluate({ returnByValue: true, expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length` })).result.value as number;
  logc("ui: slides before = " + before);
  // Extensions menu → html2slides → Open
  const ext = (await c.Runtime.evaluate({ returnByValue: true, expression: `(()=>{for(const i of document.querySelectorAll('[role=menubar] [role=menuitem]'))if(i.textContent.trim()==='Extensions'){const r=i.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}}return null})()` })).result.value as any;
  await click(c.Input, ext.x, ext.y); await sleep(1200); await shot(c, "ext_menu");
  const dump = (await c.Runtime.evaluate({ returnByValue: true, expression: `[...document.querySelectorAll('[role=menuitem]')].map(i=>i.textContent.trim()).filter(Boolean)` })).result.value;
  logc("ui: ext menu items = " + JSON.stringify(dump));
  // open the add-on submenu, then the open item
  await clickText(c.Runtime, c.Input, ["html2slides"]); await sleep(1000); await shot(c, "addon_submenu");
  const opened = await clickText(c.Runtime, c.Input, ["Open html2slides", "Open"]); await sleep(6000);
  logc("ui: opened sidebar via: " + opened); await shot(c, "sidebar_open");
  // find the sidebar iframe target (Apps Script userCodeAppPanel, googleusercontent)
  const tabs = await (CDP as any).List({ port: PORT });
  const sb = tabs.find((t: any) => /googleusercontent\.com|script\.google/.test(t.url) && t.type === "iframe");
  logc("ui: sidebar target = " + (sb ? sb.url.slice(0, 60) : "NOT FOUND"));
  if (!sb) { await c.close(); throw new Error("sidebar iframe target not found"); }
  const sc = await CDP({ target: sb, port: PORT });
  await sc.Page.enable().catch(() => {}); await sc.DOM.enable(); await instrument(sc, "sidebar");
  // queue the demo HTML via the file input (#picker), reliable vs synthetic paste
  const doc = await sc.DOM.getDocument({ depth: -1 });
  const pick = await sc.DOM.querySelector({ nodeId: doc.root.nodeId, selector: "#picker" });
  if (!pick.nodeId) { await c.close(); throw new Error("#picker not found in sidebar"); }
  await sc.DOM.setFileInputFiles({ files: [DEMO_HTML], nodeId: pick.nodeId });
  await sc.Runtime.evaluate({ expression: `document.getElementById('picker').dispatchEvent(new Event('change',{bubbles:true}))` });
  await sleep(1500); await shot(c, "queued");
  // click Insert
  await sc.Runtime.evaluate({ expression: `document.getElementById('insert-btn').click()` });
  logc("ui: clicked Insert — waiting for conversion + insert…");
  await sleep(20000); await shot(c, "after_insert");
  const after = (await c.Runtime.evaluate({ returnByValue: true, expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length` })).result.value as number;
  logc(`verify: slides ${before} → ${after} ${after > before ? "✓ INSERTED" : "✗ NO CHANGE"}`);
  await sc.close(); await c.close();
  return after > before;
}

async function main() {
  const phase = (process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1]) || "all";
  logc(`=== e2e start (phase=${phase}, PID=${PID}) ===`);
  try {
    if (phase === "all" || phase === "auth") await phaseAuth();
    if (phase === "all" || phase === "enableapi") await phaseEnableApi();
    if (phase === "all" || phase === "deploy") await phaseDeploy();
    if (phase === "all" || phase === "ui" || phase === "verify") { const ok = await phaseUi(); logc("RESULT: " + (ok ? "PASS" : "FAIL")); }
    logc("=== e2e done ===");
  } catch (e) { logc("E2E ERROR: " + (e as Error).message); logc((e as Error).stack || ""); process.exit(1); }
}
main();

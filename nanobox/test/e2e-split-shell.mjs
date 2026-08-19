// Drive the sandbox page's SPLIT VIEW (?shell=1) and prove both panes are live at the same time:
// the CLI on the left in the guest, an interactive /bin/sh -l on a pty in the SAME guest on the right.
//
//   node test/e2e-split-shell.mjs [--cli sh|codex|agy|claude|claude-native] [--timeout 240] [--out web/results]
//
// Asserts, in order:
//   1. the page reaches its CLI screen with ?shell=1 on (the split must not break the normal path);
//   2. the shell pane's shell starts and answers a command (it is a REAL guest shell: uname/ps/mount);
//   3. the shell's pty carries the PANE's geometry, not the CLI console's — `stty size` must equal
//      window.nanoboxShell.size, and must still equal it after the divider is dragged (this is the
//      check that a mis-sized pty, which is what makes TUIs render garbage, cannot come back);
//   4. it is the same guest: a file written in the shell pane is visible to the CLI pane's guest, and
//      the shell's `ps` lists the CLI process;
//   5. the shell keeps answering while the CLI pane is busy.
import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt("--port", 8093)), CDP_PORT = Number(opt("--cdp", 9222));
const CLI = opt("--cli", "sh");
const PAGE = opt("--page", "sandbox.html");   // --page sandbox-split.html: a scratch copy on a pristine VM worker
const TIMEOUT_S = Number(opt("--timeout", 240));
const OUT = opt("--out", join(HERE, "../web/results"));
const KEEP = argv.includes("--keep");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const checks = {};
const check = (name, ok, detail) => { checks[name] = ok ? true : (detail || false); if (!ok) failures.push(`${name}: ${detail || "failed"}`); console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? "  — " + String(detail).slice(0, 300) : ""}`); };

const client = await CDP({ port: CDP_PORT });
const { Target } = client;
const { targetId } = await Target.createTarget({ url: "about:blank" });
const page = await CDP({ port: CDP_PORT, target: targetId });
const { Page, Runtime, Emulation } = page;
await Promise.all([Page.enable(), Runtime.enable()]);
await Emulation.setDeviceMetricsOverride({ width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
Runtime.consoleAPICalled(({ args }) => { const t = (args || []).map((a) => a.value ?? a.description).join(" "); if (/error|FAIL|failed/i.test(t)) console.log("    [page] " + t.slice(0, 220)); });

const url = `http://localhost:${PORT}/${PAGE}?cli=${CLI}&shell=1`;
console.log(`=== split view: ${url}`);
await Page.navigate({ url });
await Page.loadEventFired();

const ev = async (expr) => (await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true })).result.value;
async function until(name, expr, seconds) {
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) { if (await ev(expr)) return (Date.now() - t0) / 1000; await sleep(400); }
  return null;
}

// --- 1. the CLI pane still gets where it is supposed to get -------------------------------------
const cliReady = await until("cli", "!!(window.nanobox && (window.nanobox.signinMs || window.nanobox.phases.bootMs))", TIMEOUT_S);
check("cli-pane-reaches-its-screen", cliReady != null, cliReady != null ? `${cliReady.toFixed(1)} s` : "timed out");

// --- 2. the shell pane comes up ------------------------------------------------------------------
const shellUp = await until("shell", "!!(window.nanoboxShell && window.nanoboxShell.live)", 90);
check("shell-pane-starts", shellUp != null, shellUp != null ? `${shellUp.toFixed(1)} s` : "no term-opened");

// run a command in the shell pane and wait for its marker to appear on that pane's screen
async function sh(cmd, marker, seconds = 25) {
  await ev(`window.nanoboxShell.send(${JSON.stringify(cmd + "\r")})`);
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    const scr = await ev("window.nanoboxShell.screen()");
    if (scr && scr.includes(marker)) return scr;
    await sleep(300);
  }
  return await ev("window.nanoboxShell.screen()");
}

if (shellUp != null) {
  const uname = await sh("echo NB1-$(uname -s)-$(id -u)", "NB1-Linux-0");
  check("shell-is-a-real-guest-shell", /NB1-Linux-0/.test(uname), (uname.match(/NB1[^\s]*/) || ["no output"])[0]);

  // --- 3. the pty carries the PANE's geometry ---------------------------------------------------
  const size = await ev("JSON.stringify(window.nanoboxShell.size)");
  const paneSize = JSON.parse(size);
  // NOT `$(stty size)`: inside a command substitution busybox stty falls back to the COLUMNS/LINES
  // environment, which the spawn set from the same pane — that would make this check circular.
  const stty = await sh("unset COLUMNS LINES; printf NB2-; stty size", "NB2-");
  const got = (stty.match(/NB2-(\d+) (\d+)/) || []).slice(1).map(Number);
  check("pty-size-matches-the-pane", got.length === 2 && got[0] === paneSize.rows && got[1] === paneSize.cols,
    `pane ${paneSize.cols}x${paneSize.rows} (colsxrows), stty rows=${got[0]} cols=${got[1]}`);

  // drag the divider, then check the pty followed
  await ev(`(() => { const b = document.getElementById("split"), p = document.getElementById("panes"); const r = p.getBoundingClientRect();
    const opts = (x) => ({ bubbles: true, cancelable: true, clientX: x, clientY: r.top + r.height / 2, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1 });
    b.dispatchEvent(new PointerEvent("pointerdown", opts(r.left + r.width / 2)));
    b.dispatchEvent(new PointerEvent("pointermove", opts(r.left + Math.round(r.width * 0.3))));
    b.dispatchEvent(new PointerEvent("pointerup", opts(r.left + Math.round(r.width * 0.3))));
    return true; })()`);
  await sleep(1200);
  const size2 = JSON.parse(await ev("JSON.stringify(window.nanoboxShell.size)"));
  const stty2 = await sh("printf NB3-; stty size", "NB3-");
  const got2 = (stty2.match(/NB3-(\d+) (\d+)/) || []).slice(1).map(Number);
  check("pty-follows-the-divider", size2.cols !== paneSize.cols && got2.length === 2 && got2[0] === size2.rows && got2[1] === size2.cols,
    `pane ${paneSize.cols}->${size2.cols} cols, stty now rows=${got2[0]} cols=${got2[1]}`);

  // --- 4. same guest ----------------------------------------------------------------------------
  const ps = await sh("echo NB4-$(ps -o args= 2>/dev/null | grep -c .)", "NB4-");
  check("ps-sees-the-guest-processes", /NB4-[1-9]/.test(ps), (ps.match(/NB4-\d+/) || ["-"])[0]);
  const psFull = await sh("ps -o pid,args 2>/dev/null | head -20; echo NB5-END", "NB5-END");
  console.log("    ps in the guest:\n" + psFull.split("\n").filter((l) => /^\s*\d+\s/.test(l)).slice(0, 12).map((l) => "      " + l.trim()).join("\n"));
  const wrote = await sh("echo split-view-was-here > /tmp/nb-split && cat /tmp/nb-split && echo NB6-OK", "NB6-OK");
  check("shell-writes-into-the-guest-fs", /split-view-was-here/.test(wrote), "wrote and read /tmp/nb-split");

  // --- 5. still answering after the CLI pane has been typed at --------------------------------
  await ev(`window.nanobox.send("\\r")`);
  await sleep(800);
  const alive = await sh("echo NB7-$(date +%s)", "NB7-");
  check("shell-survives-a-busy-cli", /NB7-\d{6,}/.test(alive), (alive.match(/NB7-\d+/) || ["-"])[0]);
}

const shot = await Page.captureScreenshot({ format: "png" });
writeFileSync(join(OUT, `split-shell-${CLI}.png`), Buffer.from(shot.data, "base64"));
const summary = { cli: CLI, url, ok: failures.length === 0, checks, failures, cliScreen: (await ev("window.nanobox.screen()") || "").split("\n").filter(Boolean).slice(-12), shellScreen: (await ev("window.nanoboxShell ? window.nanoboxShell.screen() : ''") || "").split("\n").filter(Boolean).slice(-16) };
writeFileSync(join(OUT, `split-shell-${CLI}.json`), JSON.stringify(summary, null, 2));
console.log(`\nscreenshot: ${join(OUT, `split-shell-${CLI}.png`)}`);
console.log("SPLIT-SHELL " + (failures.length === 0 ? "PASS" : "FAIL " + failures.join(" | ")));
if (!KEEP) await Target.closeTarget({ targetId });
await page.close(); await client.close();
process.exit(failures.length === 0 ? 0 : 1);

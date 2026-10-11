#!/usr/bin/env node
// Boot an agent CLI in the browser VM and wait for its sign-in screen.
//
//   node test/boot-browser.mjs --image claude [--backend qemu|wasi] [--timeout 900]
//
// Drives a real Chrome over CDP against a running `node server.mjs`: navigates to /c2w/, watches
// what the VM actually paints into the terminal, answers the onboarding prompts a human would
// answer, and fails unless the CLI's sign-in screen shows up. Screenshots + a transcript land in
// --out so a failure is inspectable.
import CDP from "chrome-remote-interface";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? def : argv[i + 1];
};
const IMAGE = arg("image", "claude");
// claude (Bun/AVX2) and agy (Go/pclmul) SIGILL on the QEMU engine's CPU; Bochs emulates a Haswell.
const DEFAULT_BACKEND = { claude: "wasi", agy: "wasi", codex: "wasi", base: "qemu" };
const BACKEND = arg("backend", DEFAULT_BACKEND[IMAGE] || "qemu");
const TIMEOUT_S = Number(arg("timeout", 900));
const PORT = Number(arg("port", 8088));
const CDP_PORT = Number(arg("cdp-port", 9222));
const OUT = arg("out", `/tmp/nanobox-boot/${IMAGE}-${BACKEND}`);
const HEADFUL = argv.includes("--headful");

mkdirSync(OUT, { recursive: true });

// What counts as "the sign-in screen is up", per CLI. These are matched against the terminal text.
const SIGNIN = {
  claude: /sign in|log in|claude\.ai\/oauth|authenticate|subscription|api key|browser didn't open/i,
  codex:  /sign in|log in|chatgpt|api key|authenticate|auth\.openai/i,
  agy:    /sign in|log in|google|authenticate|antigravity\.google|paste.*code/i,
  base:   /~ #|\$ $|# $/,  // busybox prompt — the base image has no CLI to sign in to
};
// Onboarding that stands between boot and the sign-in screen. Each entry: when `when` shows up on
// screen, send `send` (once).
const PROMPTS = [
  { name: "claude theme", when: /choose the text style|dark mode|light mode/i, send: "\r" },
  { name: "claude continue", when: /press enter to continue|continue\?/i, send: "\r" },
  { name: "trust folder", when: /do you trust|trust the files/i, send: "\r" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chromeUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (res.ok) return null;
  } catch {}
  const bin = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
  if (!bin) throw new Error("no chrome binary found");
  const child = spawn(bin, [
    HEADFUL ? "--headless=false" : "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-allow-origins=*",
    "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--user-data-dir=/tmp/nanobox-chrome-profile",
    "--window-size=1280,860",
    "about:blank",
  ], { stdio: "ignore", detached: true });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) return child; } catch {}
  }
  throw new Error("chrome did not expose CDP");
}

async function main() {
  await chromeUp();
  const url = `http://localhost:${PORT}/c2w/?backend=${BACKEND}&image=${IMAGE}`;
  const tab = await CDP.New({ port: CDP_PORT, url: "about:blank" });
  const client = await CDP({ target: tab, port: CDP_PORT });
  const { Page, Runtime, Input, Log, Network } = client;
  await Promise.all([Page.enable(), Runtime.enable(), Log.enable(), Network.enable()]);
  await Network.setCacheDisabled({ cacheDisabled: true });

  const consoleLines = [];
  Runtime.consoleAPICalled(({ args, type }) => {
    consoleLines.push(`[${type}] ` + args.map((a) => a.value ?? a.description ?? "").join(" "));
  });
  Runtime.exceptionThrown(({ exceptionDetails }) => {
    consoleLines.push("[exception] " + (exceptionDetails.exception?.description || exceptionDetails.text));
  });
  Log.entryAdded(({ entry }) => consoleLines.push(`[${entry.level}] ${entry.text}`));

  console.log(`→ ${url}`);
  await Page.navigate({ url });
  await Page.loadEventFired();

  const screen = async () => {
    const { result } = await Runtime.evaluate({
      expression: "window.nanobox ? window.nanobox.screen() : ''", returnByValue: true, awaitPromise: false,
    });
    return result.value || "";
  };
  const shot = async (tag) => {
    try {
      const { data } = await Page.captureScreenshot({ format: "png" });
      writeFileSync(join(OUT, `${tag}.png`), Buffer.from(data, "base64"));
    } catch {}
  };
  // Feed the terminal through its own data path rather than synthetic key events: a headless page
  // has no window focus, and the keystrokes go nowhere.
  const type = async (text) => {
    await Runtime.evaluate({ expression: `window.nanobox.send(${JSON.stringify(text)})`, awaitPromise: false });
  };

  const t0 = Date.now();
  const sent = new Set();
  let last = "", verdict = null;
  const marks = [];
  while ((Date.now() - t0) / 1000 < TIMEOUT_S) {
    const s = await screen();
    if (s !== last) {
      last = s;
      const secs = Math.round((Date.now() - t0) / 1000);
      marks.push(`----- t+${secs}s -----\n${s.replace(/\n+$/, "")}`);
      process.stdout.write(`\r  t+${secs}s  ${s.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 90) || ""}`.padEnd(120));
    }
    for (const p of PROMPTS) {
      if (!sent.has(p.name) && p.when.test(s)) {
        sent.add(p.name);
        await shot(`prompt-${p.name.replace(/\W+/g, "-")}`);
        console.log(`\n  · answering prompt: ${p.name}`);
        await type(p.send);
      }
    }
    if (SIGNIN[IMAGE].test(s)) { verdict = "signin"; break; }
    await sleep(2000);
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  await shot("final");
  const finalScreen = await screen();
  writeFileSync(join(OUT, "transcript.txt"), marks.join("\n\n"));
  writeFileSync(join(OUT, "console.log"), consoleLines.join("\n"));
  writeFileSync(join(OUT, "final-screen.txt"), finalScreen);

  await client.close();
  await CDP.Close({ port: CDP_PORT, id: tab.id });

  console.log(`\n\n${"=".repeat(78)}\n${finalScreen}\n${"=".repeat(78)}`);
  if (verdict === "signin") {
    console.log(`\n✅ ${IMAGE} on ${BACKEND}: sign-in screen reached in ${elapsed}s (artifacts: ${OUT})`);
    process.exit(0);
  }
  console.log(`\n❌ ${IMAGE} on ${BACKEND}: no sign-in screen after ${elapsed}s (artifacts: ${OUT})`);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });

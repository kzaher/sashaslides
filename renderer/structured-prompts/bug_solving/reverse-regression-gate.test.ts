/**
 * reverse-regression-gate.test.ts — the REVERSE direction's per-fork gate and its rating block:
 *   (1) the pure decision (reverse-regression-gate.ts): a non-cluster rise over 0.05 points fails,
 *       0.05 or less passes; a cluster slide never fails (reported as a target); a golden slide
 *       fails only when the fork moved it further from the golden than the baseline was;
 *       pre-existing drift is reported, not failed; a lost render fails; a missing / malformed
 *       result file reads back as a FAILED gate;
 *   (2) the CLI on a FAKE reverse results tree (baseline, fork every-set, goldens-reverse): real
 *       PNG comparison, the JSON it writes, and the goldens directory left byte-identical;
 *   (3) the fork's reverse rating UI (rating-server.ts --direction reverse, the argv the fork uses)
 *       on a fake attempt dir: a "Good" lands in the attempt's ratings-reverse.json, blesses into
 *       the FORK's goldens dir (the user's stays untouched), and the server exits once rated;
 *       then wait-for-ratings --ratings-file turns it into a GREEN marker.
 * Only the human click is simulated (an HTTP POST); everything else runs for real.
 */
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { readReverseGateResult, reverseRegressionGate, type ReverseGateSlide } from "./reverse-regression-gate.js";
import { reverseForkPaths, reverseRatingServerArguments } from "./reverse-direction.js";

let passed = 0;
let failed = 0;
function ok(name: string, condition: boolean, extra = ""): void {
  if (condition) { passed++; console.log(`  ✓ ${name}`); return; }
  failed++;
  console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_CLI = join(HERE, "scripts", "reverse-regression-gate.ts");
const WAIT_CLI = join(HERE, "scripts", "wait-for-ratings.ts");
const RATING_SERVER = resolve(HERE, "../../html2slides/rating-server.ts");
const RENDERER = resolve(HERE, "../..");
const limits = { metricRise: 0.05, goldenDrift: 0.05 };

function slide(id: string, fields: Partial<Omit<ReverseGateSlide, "id">>): ReverseGateSlide {
  return { id, baselineMismatchPercent: 0.1, candidateMismatchPercent: 0.1, goldenDriftPercent: null, baselineGoldenDriftPercent: null, hasGolden: false, ...fields };
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "reverse-gate-"));
  try {
    pureGate();
    cliOnFakeTree(root);
    await forkRatingBlock(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

function pureGate(): void {
  console.log("\n(1) the pure gate\n");
  const clean = reverseRegressionGate({ slides: [slide("complex__slide_01", {}), slide("basic__slide_02", { candidateMismatchPercent: 0.15 })], clusterSlides: [], limits });
  ok("(1a) unchanged and a 0.05-point rise pass", clean.ok && clean.regressions.length === 0 && clean.comparedSlides === 2, JSON.stringify(clean));
  const rose = reverseRegressionGate({ slides: [slide("complex__slide_01", { candidateMismatchPercent: 0.16 })], clusterSlides: [], limits });
  ok("(1b) a 0.06-point rise on a non-cluster slide fails", !rose.ok && rose.findings[0]?.kind === "metric-rise" && rose.regressions.join() === "complex__slide_01");
  const target = reverseRegressionGate({ slides: [slide("complex__slide_05", { candidateMismatchPercent: 3 })], clusterSlides: ["complex__slide_05", "complex__slide_30"], limits });
  ok("(1c) a cluster slide never fails; before/after reported (missing ones too)", target.ok && target.targets.length === 2 && target.targets[0]?.after === 3 && target.targets[1]?.before === null);
  const drifted = reverseRegressionGate({ slides: [slide("deck__slide_04", { hasGolden: true, goldenDriftPercent: 2.5, baselineGoldenDriftPercent: 0 })], clusterSlides: [], limits });
  ok("(1d) the fork moved a golden slide away from its golden → golden-drift", !drifted.ok && drifted.findings[0]?.kind === "golden-drift");
  const preexisting = reverseRegressionGate({ slides: [slide("deck__slide_02", { hasGolden: true, goldenDriftPercent: 17.978, baselineGoldenDriftPercent: 17.978 })], clusterSlides: [], limits });
  ok("(1e) drift the untouched tree already had passes and is reported", preexisting.ok && preexisting.preexistingGoldenDrift[0]?.slide === "deck__slide_02");
  const lost = reverseRegressionGate({ slides: [slide("basic__slide_03", { candidateMismatchPercent: null })], clusterSlides: [], limits });
  ok("(1f) a slide that rendered before and not after fails", !lost.ok && lost.findings[0]?.kind === "missing-render");
  const goldenLost = reverseRegressionGate({ slides: [slide("basic__slide_03", { hasGolden: true, goldenDriftPercent: null })], clusterSlides: [], limits });
  ok("(1g) a golden slide with no render to compare fails", !goldenLost.ok);
  ok("(1h) a missing result file reads back as FAILED", !readReverseGateResult("/nonexistent/regression-gate.json").ok);
  const malformed = join(tmpdir(), `reverse-gate-malformed-${process.pid}.json`);
  writeFileSync(malformed, "{ not json");
  ok("(1i) a malformed result file reads back as FAILED", !readReverseGateResult(malformed).ok);
  rmSync(malformed, { force: true });
}

function cliOnFakeTree(root: string): void {
  console.log("\n(2) the CLI on a fake reverse results tree\n");
  const baseline = join(root, "baseline");
  const candidate = join(root, "every-set");
  const goldens = join(root, "goldens-reverse");
  mkdirSync(goldens, { recursive: true });
  // complex slide_01: golden, untouched by the fork. complex slide_02: golden, the fork changed it.
  // complex slide_05: the cluster slide, the fork changed it (intended). basic slide_01: metric rise.
  for (const directory of [baseline, candidate]) {
    for (const set of ["complex", "basic"]) mkdirSync(join(directory, set, "slides"), { recursive: true });
  }
  for (const [set, file, value] of [["complex", "slide_01", 200], ["complex", "slide_02", 200], ["complex", "slide_05", 90], ["basic", "slide_01", 120]] as const) {
    writePng(join(baseline, set, "slides", `${file}.png`), value);
  }
  for (const [set, file, value] of [["complex", "slide_01", 200], ["complex", "slide_02", 20], ["complex", "slide_05", 180], ["basic", "slide_01", 120]] as const) {
    writePng(join(candidate, set, "slides", `${file}.png`), value);
  }
  writePng(join(goldens, "complex__slide_01.png"), 200);
  writePng(join(goldens, "complex__slide_02.png"), 200);
  writeMetrics(baseline, [["complex", "slide_01", 0.1], ["complex", "slide_02", 0.1], ["complex", "slide_05", 4], ["basic", "slide_01", 0.2]]);
  writeMetrics(candidate, [["complex", "slide_01", 0.1], ["complex", "slide_02", 0.1], ["complex", "slide_05", 0.5], ["basic", "slide_01", 0.4]]);
  const goldensBefore = digestDirectory(goldens);
  const out = join(root, "regression-gate.json");
  execFileSync("npx", ["tsx", GATE_CLI, "--results", candidate, "--baseline", baseline, "--goldens", goldens, "--cluster", "complex__slide_05", "--out", out], {
    cwd: RENDERER, stdio: ["ignore", "ignore", "pipe"], timeout: 25_000,
  });
  const result = readReverseGateResult(out);
  ok("(2a) the CLI wrote a result over every slide", result.comparedSlides === 4, JSON.stringify(result));
  ok("(2b) the changed golden slide and the risen slide fail; the untouched golden passes", result.regressions.join(",") === "basic__slide_01,complex__slide_02", result.regressions.join(","));
  ok("(2c) the kinds are golden-drift and metric-rise", result.findings.some((finding) => finding.slide === "complex__slide_02" && finding.kind === "golden-drift") && result.findings.some((finding) => finding.slide === "basic__slide_01" && finding.kind === "metric-rise"));
  ok("(2d) the cluster slide is a reported target, not a failure", result.targets.length === 1 && result.targets[0]?.before === 4 && result.targets[0]?.after === 0.5);
  ok("(2e) the goldens directory is byte-identical afterwards", digestDirectory(goldens) === goldensBefore);
  const crashOut = join(root, "crash.json");
  execFileSync("npx", ["tsx", GATE_CLI, "--results", candidate, "--goldens", goldens, "--out", crashOut], { cwd: RENDERER, stdio: ["ignore", "ignore", "pipe"], timeout: 25_000 });
  ok("(2f) a bad invocation still writes a FAILED result and exits 0", existsSync(crashOut) && !readReverseGateResult(crashOut).ok);
}

async function forkRatingBlock(root: string): Promise<void> {
  console.log("\n(3) the fork's reverse rating UI + the --ratings-file wait\n");
  const fork = reverseForkPaths(join(root, "shared", "task-a"));
  const set = join(fork.attempt, "complex");
  for (const directory of ["originals", "slides", "html"]) mkdirSync(join(set, directory), { recursive: true });
  writePng(join(set, "originals", "slide_05.png"), 250);
  writePng(join(set, "slides", "slide_05.png"), 240);
  writeFileSync(join(set, "html", "slide_05.html"), "<html></html>");
  const userGoldens = resolve(HERE, "../../html2slides/e2e/goldens-reverse");
  const userGoldensBefore = existsSync(userGoldens) ? digestDirectory(userGoldens) : "absent";
  const analysis = join(root, "analysis.md");
  writeFileSync(analysis, "## complex__slide_05\nfixed\n");
  const port = await freePort();
  const server = spawn("npx", ["tsx", RATING_SERVER, ...reverseRatingServerArguments({
    attemptDirectory: fork.attempt, port, slides: ["complex__slide_05"], analysisPath: analysis, taskTitle: "reverse test",
    forkGoldensDirectory: fork.forkGoldens, historyDirectory: join(root, "history-reverse"),
  })], { cwd: RENDERER, stdio: ["ignore", "pipe", "pipe"] });
  let serverLog = "";
  server.stdout.on("data", (chunk: Buffer) => { serverLog += chunk.toString(); });
  server.stderr.on("data", (chunk: Buffer) => { serverLog += chunk.toString(); });
  const exited = new Promise<number | null>((resolveExit) => server.on("exit", (code) => resolveExit(code)));
  try {
    const ready = await waitReady(port, 20_000);
    ok("(3a) the reverse rating UI boots on the fork's attempt dir", ready, serverLog.slice(-400));
    if (!ready) return;
    const page = await (await fetch(`http://localhost:${port}/api/comparisons`)).text();
    ok("(3b) it shows the cluster slide", page.includes("complex__slide_05"), page.slice(0, 300));
    const rated = await fetch(`http://localhost:${port}/api/rate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "complex__slide_05", status: "good" }) });
    ok("(3c) the verdict is accepted", rated.status === 200);
    const verdicts = JSON.parse(readFileSync(join(fork.attempt, "ratings-reverse.json"), "utf8")) as Record<string, { status?: string }>;
    ok("(3d) it lands in the attempt's ratings-reverse.json", verdicts["complex__slide_05"]?.status === "good");
    ok("(3e) the Good click blessed into the FORK's goldens dir", existsSync(join(fork.forkGoldens, "complex__slide_05.png")));
    ok("(3f) the user's goldens-reverse is untouched", (existsSync(userGoldens) ? digestDirectory(userGoldens) : "absent") === userGoldensBefore);
    const code = await Promise.race([exited, new Promise<"timeout">((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 12_000))]);
    ok("(3g) the server exits once every slide is rated (the block ends)", code === 0, String(code));
  } finally {
    server.kill("SIGTERM");
  }
  const marker = join(root, "shared", "task-a", "rating-outcome.json");
  execFileSync("npx", ["tsx", WAIT_CLI, "--results-dir", fork.attempt, "--ratings-file", join(fork.attempt, "ratings-reverse.json"), "--slides", "complex__slide_05", "--task-id", "task-a", "--marker", marker, "--poll-ms", "50"], {
    cwd: RENDERER, stdio: ["ignore", "ignore", "pipe"], timeout: 25_000, env: { ...process.env, BUG_SOLVING_NO_ACCEPT: "", BUG_SOLVING_RATING_TIMEOUT_MS: "5000" },
  });
  const outcome = JSON.parse(readFileSync(marker, "utf8")) as { green?: boolean; good?: string[] };
  ok("(3h) wait-for-ratings --ratings-file reads ratings-reverse.json → GREEN marker", outcome.green === true && outcome.good?.join() === "complex__slide_05", JSON.stringify(outcome));
}

function writePng(path: string, value: number): void {
  const png = new PNG({ width: 64, height: 36 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = value;
    png.data[offset + 1] = value;
    png.data[offset + 2] = value;
    png.data[offset + 3] = 255;
  }
  writeFileSync(path, PNG.sync.write(png));
}

function writeMetrics(directory: string, rows: ReadonlyArray<readonly [string, string, number]>): void {
  writeFileSync(join(directory, "metrics.json"), JSON.stringify(rows.map(([set, slideId, reverseMismatchPercent]) => ({
    caseId: slideId, set, slideNumber: Number(slideId.slice(-2)), slideId, reverseMismatchPercent, roundTripMismatchPercent: null, textMatch: 1, notes: "",
  }))));
}

function digestDirectory(directory: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(directory).sort()) {
    hash.update(name);
    hash.update(readFileSync(join(directory, name)));
  }
  return hash.digest("hex");
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitReady(port: number, deadlineMilliseconds: number): Promise<boolean> {
  const end = Date.now() + deadlineMilliseconds;
  while (Date.now() < end) {
    try {
      const response = await fetch(`http://localhost:${port}/`);
      if (response.ok) return true;
    } catch { /* not listening yet */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  return false;
}

main().catch((cause: unknown) => {
  console.error(cause);
  process.exit(1);
});

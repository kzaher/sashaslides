/**
 * rating-server-reverse.e2e.test.ts — HTTP route tests for rating-server.ts's
 * REVERSE mode, with a forward-mode control, against fake results in temp dirs.
 *
 * Why: the reverse UI's promises are about which files a click writes. A "Good"
 * must bless the Sasha screenshot into the REVERSE goldens directory and never the
 * forward one; verdicts must land in ratings-reverse.json and leave ratings.json
 * alone; annotations and zoom-crops must stay under the reverse results directory.
 * Each test boots the real server as a child process (no browser) and checks the
 * files on disk. Every row runs the same steps and differs only in --direction, so
 * the written files are shown to follow from the direction and not from the setup.
 *
 * Run: npx tsx --test renderer/html2slides/rating-server-reverse.e2e.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";
import { writeFakeReverseResults } from "./reverse-rating-fake-results.js";

const serverScript = join(dirname(fileURLToPath(import.meta.url)), "rating-server.ts");
const reverseSlideId = "complex__slide_07";

type Workspace = Readonly<{
  root: string;
  results: string;
  /** The sibling goldens/ of meta.json's htmlDir: where a FORWARD Good click blesses. */
  forwardGoldens: string;
  reverseGoldens: string;
}>;

type DirectionRow = Readonly<{
  direction: "forward" | "reverse";
  ratingsFileName: string;
  untouchedRatingsFileName: string;
  blessedGolden: (workspace: Workspace) => string;
  untouchedGoldens: (workspace: Workspace) => string;
}>;

const directionRows: readonly DirectionRow[] = [
  {
    direction: "forward",
    ratingsFileName: "ratings.json",
    untouchedRatingsFileName: "ratings-reverse.json",
    blessedGolden: (workspace) => join(workspace.forwardGoldens, `${reverseSlideId}.png`),
    untouchedGoldens: (workspace) => workspace.reverseGoldens,
  },
  {
    direction: "reverse",
    ratingsFileName: "ratings-reverse.json",
    untouchedRatingsFileName: "ratings.json",
    blessedGolden: (workspace) => join(workspace.reverseGoldens, `${reverseSlideId}.png`),
    untouchedGoldens: (workspace) => workspace.forwardGoldens,
  },
];

for (const row of directionRows) {
  test(`${row.direction}: Good writes ${row.ratingsFileName} and blesses only its own goldens`, async () => {
    const workspace = makeWorkspace();
    const server = await startServer({ workspace, direction: row.direction });
    try {
      const response = await postJson({ port: server.port, path: "/api/rate", body: { id: reverseSlideId, status: "good", view: "round-trip" } });
      assert.equal(response.status, 200);
      const ratings = readJson(join(workspace.results, row.ratingsFileName));
      assert.equal(ratings[reverseSlideId]?.status, "good");
      assert.equal(existsSync(join(workspace.results, row.untouchedRatingsFileName)), false, "the other direction's ratings file stays untouched");
      const golden = row.blessedGolden(workspace);
      assert.ok(existsSync(golden), `blessed ${golden}`);
      // Forward blesses the Google thumbnail (slides/); reverse blesses the Sasha screenshot, which also sits in slides/.
      assert.deepEqual(readFileSync(golden), readFileSync(join(workspace.results, "slides", `${reverseSlideId}.png`)));
      assert.equal(existsSync(row.untouchedGoldens(workspace)), false, "the other direction's goldens directory is never created");
      assert.equal(ratings[reverseSlideId]?.view, row.direction === "reverse" ? "round-trip" : undefined);
    } finally {
      server.stop();
    }
  });
}

test("reverse: the page and comparisons describe Google Slides vs Sasha HTML with metrics and the round trip", async () => {
  const workspace = makeWorkspace();
  const reverse = await startServer({ workspace, direction: "reverse" });
  const forward = await startServer({ workspace, direction: "forward" });
  try {
    const reversePage = await getText({ port: reverse.port, path: "/" });
    const forwardPage = await getText({ port: forward.port, path: "/" });
    for (const marker of ["Full round trip: fixture HTML", '"direction":"reverse"', "Worst reverse mismatch first", "reverseMetrics", "test (Sasha HTML)"]) {
      assert.ok(reversePage.includes(marker), `reverse page has ${marker}`);
      assert.ok(!forwardPage.includes(marker), `forward page lacks ${marker}`);
    }
    assert.ok(forwardPage.includes('"direction":"forward"'));

    const comparisons = JSON.parse(await getText({ port: reverse.port, path: "/api/comparisons" })) as ReadonlyArray<Readonly<{
      id: string; originalPng: string; slidesPng: string;
      reverse?: Readonly<{ fixturePng: string | null; metric: Readonly<{ reverseMismatchPercent: number | null; textMatch: number | null }> | null }>;
    }>>;
    assert.deepEqual(comparisons.map((comparison) => comparison.id), [
      "basic__slide_01_solid_rect", "complex__slide_07", "google__test_deck__01", "google__test_deck__02",
    ]);
    const complex = comparisons.find((comparison) => comparison.id === reverseSlideId);
    assert.equal(complex?.originalPng, join(workspace.results, "originals", `${reverseSlideId}.png`));
    assert.equal(complex?.slidesPng, join(workspace.results, "slides", `${reverseSlideId}.png`));
    assert.equal(complex?.reverse?.fixturePng, join(workspace.results, "round-trip", "originals", `${reverseSlideId}.png`));
    assert.equal(complex?.reverse?.metric?.reverseMismatchPercent, 11.8);
    assert.equal(comparisons.find((comparison) => comparison.id === "google__test_deck__01")?.reverse?.fixturePng, null);

    const image = await fetch(`http://127.0.0.1:${reverse.port}/img?path=${encodeURIComponent(complex?.reverse?.fixturePng ?? "")}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");

    const summary = JSON.parse(await getText({ port: reverse.port, path: "/api/summary" })) as Readonly<Record<string, unknown>>;
    assert.equal(summary.direction, "reverse");
    assert.equal(summary.slideCount, 4);
    assert.deepEqual(summary.missingSashaRender, ["complex__slide_09"]);
    assert.deepEqual(summary.worstReverse, { id: reverseSlideId, mismatchPercent: 11.8 });
    assert.equal(summary.goldenCount, 0);
  } finally {
    reverse.stop();
    forward.stop();
  }
});

test("reverse: an annotated Bad saves the drawing and Google | Sasha | fixture crops under the reverse results", async () => {
  const workspace = makeWorkspace();
  const server = await startServer({ workspace, direction: "reverse" });
  try {
    const annotation = `data:image/png;base64,${PNG.sync.write(markedCanvas()).toString("base64")}`;
    const response = await postJson({
      port: server.port,
      path: "/api/rate",
      body: {
        id: reverseSlideId, status: "bad", comment: "table padding", annotation,
        shapes: [{ kind: "rect", x: 100, y: 100, w: 200, h: 120 }], canvasSize: { w: 1280, h: 720 }, view: "reverse",
      },
    });
    assert.equal(response.status, 200);
    const result = JSON.parse(response.text) as Readonly<{ annotationPath: string; zoomCrops: readonly string[] }>;
    assert.equal(result.annotationPath, join(workspace.results, "annotations", `${reverseSlideId}.png`));
    assert.deepEqual(result.zoomCrops.map((path) => path.replace(join(workspace.results, "zoom-crops") + "/", "")).sort(), [
      `${reverseSlideId}-01-fixture.png`, `${reverseSlideId}-01-original.png`, `${reverseSlideId}-01-rendered.png`,
    ]);
    const ratings = readJson(join(workspace.results, "ratings-reverse.json"));
    assert.equal(ratings[reverseSlideId]?.status, "bad");
    assert.equal(ratings[reverseSlideId]?.comment, "table padding");
    assert.equal(ratings[reverseSlideId]?.view, "reverse");
    assert.equal(existsSync(workspace.reverseGoldens), false, "a Bad never blesses");

    const cleared = await postJson({ port: server.port, path: "/api/clear-annotation", body: { id: reverseSlideId } });
    assert.equal(cleared.status, 200);
    assert.equal(existsSync(result.annotationPath), false);
    assert.deepEqual(readdirSync(join(workspace.results, "zoom-crops")), []);
    assert.equal(readJson(join(workspace.results, "ratings-reverse.json"))[reverseSlideId]?.annotation, undefined);
  } finally {
    server.stop();
  }
});

test("reverse: a forward goldens directory as --reverse-goldens-dir is refused at boot", async () => {
  const workspace = makeWorkspace();
  const exit = await runToExit({
    arguments: [workspace.results, "--direction", "reverse", "--port", "0", "--reverse-goldens-dir", workspace.forwardGoldens],
  });
  assert.notEqual(exit.code, 0);
  assert.match(exit.output, /is a forward goldens directory/);
  assert.equal(existsSync(workspace.forwardGoldens), false);
});

type RunningServer = Readonly<{ port: number; stop: () => void }>;

/**
 * Fake reverse results plus a forward-style meta.json whose htmlDir has a sibling
 * goldens/ inside the temp root, so a misrouted bless would land somewhere this
 * test can see instead of in the repository's real e2e/goldens/.
 */
function makeWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), "rating-server-reverse-"));
  const results = join(root, "results");
  writeFakeReverseResults({ directory: results, googleThumbnails: [] });
  const fixtures = join(root, "fixtures-basic");
  mkdirSync(fixtures, { recursive: true });
  copyFileSync(join(results, "html", `${reverseSlideId}.html`), join(fixtures, `${reverseSlideId}.html`));
  writeFileSync(join(results, "meta.json"), JSON.stringify({ htmlDir: fixtures }));
  return { root, results, forwardGoldens: join(root, "goldens"), reverseGoldens: join(root, "goldens-reverse") };
}

async function startServer(options: Readonly<{ workspace: Workspace; direction: "forward" | "reverse" }>): Promise<RunningServer> {
  const port = await freePort();
  const child = spawn("npx", [
    "tsx", serverScript, options.workspace.results,
    "--direction", options.direction,
    "--port", String(port),
    "--reverse-goldens-dir", options.workspace.reverseGoldens,
  ], { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, BUG_SOLVING_NOTIFY_CMD: "" } });
  const boundPort = await waitForListening({ child, budgetMilliseconds: 20_000 });
  return { port: boundPort, stop: () => stopGroup(child) };
}

/**
 * npx -> tsx -> node is three processes; killing only npx would orphan the server
 * still holding its port. The child leads its own process group (detached), so
 * signal the whole group.
 */
function stopGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // The group already exited between the check and the signal.
  }
}

/**
 * Wait on evidence: done = the "Rating server: http://localhost:<port>" line; stall =
 * the process exiting first; deadline = budgetMilliseconds, reported with the output so far.
 */
function waitForListening(options: Readonly<{ child: ChildProcess; budgetMilliseconds: number }>): Promise<number> {
  const { child } = options;
  const started = Date.now();
  let output = "";
  return new Promise((resolvePort, reject) => {
    const deadline = setTimeout(() => {
      stopGroup(child);
      reject(new Error(`rating server not listening after ${Date.now() - started} ms; output so far:\n${output}`));
    }, options.budgetMilliseconds);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /Rating server: http:\/\/localhost:(\d+)/.exec(output);
      if (match?.[1] === undefined) return;
      clearTimeout(deadline);
      resolvePort(Number(match[1]));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(deadline);
      reject(new Error(`rating server exited with ${code} before listening; output:\n${output}`));
    });
  });
}

function runToExit(options: Readonly<{ arguments: readonly string[] }>): Promise<Readonly<{ code: number | null; output: string }>> {
  const child = spawn("npx", ["tsx", serverScript, ...options.arguments], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  return new Promise((resolveExit, reject) => {
    const deadline = setTimeout(() => {
      stopGroup(child);
      reject(new Error(`server still running after 20 s although its goldens directory should be refused; output:\n${output}`));
    }, 20_000);
    child.on("exit", (code) => {
      clearTimeout(deadline);
      resolveExit({ code, output });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

async function getText(options: Readonly<{ port: number; path: string }>): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${options.port}${options.path}`);
  assert.equal(response.status, 200, options.path);
  return response.text();
}

async function postJson(options: Readonly<{ port: number; path: string; body: unknown }>): Promise<Readonly<{ status: number; text: string }>> {
  const response = await fetch(`http://127.0.0.1:${options.port}${options.path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options.body),
  });
  return { status: response.status, text: await response.text() };
}

type SavedRating = Readonly<{ status?: string; comment?: string; view?: string; annotation?: string }>;

function readJson(path: string): Readonly<Record<string, SavedRating | undefined>> {
  // The server writes this file with JSON.stringify of exactly this record shape.
  return JSON.parse(readFileSync(path, "utf-8")) as Readonly<Record<string, SavedRating | undefined>>;
}

/** A transparent 1280x720 canvas with one red rectangle, like the client's flattened annotation. */
function markedCanvas(): PNG {
  const canvas = new PNG({ width: 1280, height: 720 });
  for (let y = 100; y < 220; y++) {
    for (let x = 100; x < 300; x++) {
      const offset = (y * 1280 + x) * 4;
      canvas.data[offset] = 233;
      canvas.data[offset + 3] = 255;
    }
  }
  return canvas;
}

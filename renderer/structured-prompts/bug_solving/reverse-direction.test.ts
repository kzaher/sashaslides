/**
 * reverse-direction.test.ts — the REVERSE direction's pure parts (reverse-direction.ts), and the
 * places the shared machinery branches on the direction:
 *   (1) clusters from ratings-reverse.json: only BAD "<set>__slide_NN" entries, one per slide,
 *       sorted by set then number, the user's comment verbatim, readable unique slugs;
 *   (2) --only accepts the full id, the bare "slide_NN" and a slug substring;
 *   (3) --clusters groups reverse ids, refuses an ambiguous bare number;
 *   (4) record command selection: offline always, only the cluster's sets/slides per attempt,
 *       every set and no --slides for the regression gate;
 *   (5) slide tasks: Google thumbnail = TARGET, Sasha render = ATTEMPT, the annotation composite is
 *       built over the SASHA render, fixture/HTML/import/zoom crops/metrics are found;
 *   (6) which files a reverse merge folds, and the merge settings per direction;
 *   (7) the worker brief carries the user's words verbatim and the owning files;
 *   (8) the fork rating UI never blesses the user's goldens.
 * Pure (fs on temp dirs only) — no engine, no overlays, no Chrome.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import {
  buildReverseSlideTasks,
  clustersFromReverseRatings,
  isReverseFixFile,
  parseReverseSlideId,
  parseSolveDirection,
  reverseBaselineDirectory,
  reverseClusterMemberKey,
  reverseForkPaths,
  reversePipelineArguments,
  reverseRatingServerArguments,
  reverseSetsOf,
  type ReversePaths,
} from "./reverse-direction.js";
import { applyManualClusters } from "./clusters.js";
import { selectOnlyClusters } from "./workspace-setup.js";
import { mergeSettingsFor, type Task } from "./main.js";
import { defaultConverterFilter } from "./llm-merge.js";
import { reverseBriefFor } from "./reverse-run-task.js";
import { ok, summary } from "./test-harness.js";

function throws(run: () => unknown): string | null {
  try { run(); return null; } catch (cause) { return cause instanceof Error ? cause.message : String(cause); }
}

const root = mkdtempSync(join(tmpdir(), "reverse-direction-"));
const results = join(root, "sxs-reverse");
const repository = join(root, "repository");
const paths: ReversePaths = {
  resultsRoot: results,
  ratingsFile: join(results, "ratings-reverse.json"),
  goldensDirectory: join(repository, "renderer", "html2slides", "e2e", "goldens-reverse"),
  historyDirectory: join(root, "history-reverse"),
};
mkdirSync(results, { recursive: true });
writeFileSync(paths.ratingsFile, JSON.stringify({
  complex__slide_30: { status: "bad", comment: "Something is wrong with the table last cell size.", direction: "reverse" },
  complex__slide_05: { status: "bad", comment: "shouldn't the table items be without internal divs with absolute positions?" },
  complex__slide_14: { status: "good", comment: "fine" },
  basic__slide_07: { status: "bad", comment: "The stars are different." },
  slide_03: { status: "bad", comment: "a FORWARD id must be ignored here" },
  deck__slide_02: { status: "BAD", comment: "" },
}, null, 2));

// ---------------------------------------------------------------------------
console.log("\n(1) clusters from ratings-reverse.json\n");
const clusters = clustersFromReverseRatings({ ratingsPath: paths.ratingsFile, retryBudget: 4 });
ok("(1a) only BAD reverse ids, one cluster each", clusters.length === 4, JSON.stringify(clusters.map((cluster) => cluster.slide_ids)));
ok("(1b) sorted by set then slide number", clusters.map((cluster) => cluster.slide_ids[0]).join(",") === "basic__slide_07,complex__slide_05,complex__slide_30,deck__slide_02", clusters.map((cluster) => cluster.slide_ids[0]).join(","));
ok("(1c) the user's comment verbatim in the description", clusters[1]?.cluster_description.includes("shouldn't the table items be without internal divs with absolute positions?") === true);
ok("(1d) the description names the reverse direction and the owning code", clusters[1]?.cluster_description.includes("reverse: Google Slides -> Sasha HTML") === true && clusters[1]?.cluster_description.includes("mcp/sasha-slides/google-slides") === true);
ok("(1e) readable slug", clusters[2]?.task_id === "reverse-complex-slide-30-something-wrong-table", clusters[2]?.task_id);
ok("(1f) retry budget carried", clusters.every((cluster) => cluster.retry_budget === 4));
ok("(1g) empty comment → (no comment)", clusters[3]?.cluster_description.includes("(no comment)") === true);
ok("(1h) missing ratings file → no clusters", clustersFromReverseRatings({ ratingsPath: join(root, "absent.json"), retryBudget: null }).length === 0);
ok("(1i) parseReverseSlideId rejects forward ids and unknown sets", parseReverseSlideId("slide_05") === null && parseReverseSlideId("other__slide_05") === null && parseReverseSlideId("deck__slide_09")?.fileId === "slide_09");

// ---------------------------------------------------------------------------
console.log("\n(2) --only\n");
ok("(2a) full id", selectOnlyClusters(clusters, "complex__slide_05").map((cluster) => cluster.slide_ids[0]).join() === "complex__slide_05");
ok("(2b) bare slide_NN", selectOnlyClusters(clusters, "slide_30").map((cluster) => cluster.slide_ids[0]).join() === "complex__slide_30");
ok("(2c) slug substring", selectOnlyClusters(clusters, "stars").map((cluster) => cluster.slide_ids[0]).join() === "basic__slide_07");

// ---------------------------------------------------------------------------
console.log("\n(3) --clusters with reverse ids\n");
const badIds = clusters.flatMap((cluster) => cluster.slide_ids);
const grouped = applyManualClusters(clusters, "[['complex__slide_05','slide_30']]", { memberKey: reverseClusterMemberKey(badIds) });
ok("(3a) one shared cluster + the two ungrouped", grouped.length === 3 && grouped[0]?.slide_ids.join(",") === "complex__slide_05,complex__slide_30", JSON.stringify(grouped.map((cluster) => cluster.slide_ids)));
const ambiguous = [...clusters, { task_id: "x", slide_ids: ["basic__slide_05"], cluster_description: "" }];
const ambiguity = throws(() => applyManualClusters(ambiguous, "[['slide_05','complex__slide_30']]", { memberKey: reverseClusterMemberKey(ambiguous.flatMap((cluster) => cluster.slide_ids)) }));
ok("(3b) a bare number BAD in two sets is refused, naming both", ambiguity !== null && ambiguity.includes("basic__slide_05") && ambiguity.includes("complex__slide_05"), String(ambiguity));
const forwardGrouped = applyManualClusters(
  [{ task_id: "a", slide_ids: ["slide_35"], cluster_description: "" }, { task_id: "b", slide_ids: ["slide_36"], cluster_description: "" }],
  "[['S_35','36']]",
);
ok("(3c) forward default (number key) unchanged", forwardGrouped.length === 1 && forwardGrouped[0]?.slide_ids.join(",") === "slide_35,slide_36");

// ---------------------------------------------------------------------------
console.log("\n(4) record command selection\n");
const attemptArguments = reversePipelineArguments({ outputDirectory: "/shared/t/reverse/attempt", slideIds: ["complex__slide_05", "complex__slide_30"], chromePort: 9223 });
ok("(4a) attempt: offline, only the cluster's set and slides", attemptArguments.join(" ") === "--offline --sets complex --output /shared/t/reverse/attempt --chrome-port 9223 --slides complex__slide_05,complex__slide_30", attemptArguments.join(" "));
const gateArguments = reversePipelineArguments({ outputDirectory: "/o", slideIds: null, chromePort: 9300 });
ok("(4b) gate: offline, every set, no --slides", gateArguments.join(" ") === "--offline --sets basic,complex,deck --output /o --chrome-port 9300", gateArguments.join(" "));
ok("(4c) sets of a mixed cluster in ALL_SETS order", reverseSetsOf(["deck__slide_01", "basic__slide_02", "deck__slide_03"]).join(",") === "basic,deck");
const fork = reverseForkPaths("/overlays/shared/run-1/task-a");
ok("(4d) fork outputs live in the SHARED dir (host Chrome must read the export)", fork.attempt.startsWith("/overlays/shared/run-1/task-a/") && fork.everySet.startsWith("/overlays/shared/run-1/task-a/") && fork.gateResult.endsWith(".json"));
ok("(4e) the run baseline sits next to the task dirs", reverseBaselineDirectory("/overlays/shared/run-1/task-a") === "/overlays/shared/run-1/reverse-baseline");

// ---------------------------------------------------------------------------
console.log("\n(5) slide tasks\n");
const complex = join(results, "complex");
for (const directory of ["originals", "slides", "html", "import"]) mkdirSync(join(complex, directory), { recursive: true });
writePng(join(complex, "originals", "slide_05.png"), { width: 16, height: 9, value: 255 });
writePng(join(complex, "slides", "slide_05.png"), { width: 16, height: 9, value: 40 });
writeFileSync(join(complex, "html", "slide_05.html"), "<html></html>");
mkdirSync(join(results, "annotations"), { recursive: true });
const annotation = join(results, "annotations", "complex__slide_05.png");
writeMarkedPng(annotation);
mkdirSync(join(results, "zoom-crops"), { recursive: true });
for (const name of ["complex__slide_05-01-original.png", "complex__slide_05-01-rendered.png", "complex__slide_50-01-original.png"]) writeFileSync(join(results, "zoom-crops", name), "x");
writeFileSync(join(results, "metrics.json"), JSON.stringify([{ caseId: "slide_05", set: "complex", slideNumber: 5, slideId: "slide_05", reverseMismatchPercent: 0.004, roundTripMismatchPercent: 1.2, textMatch: 1, notes: "" }]));
const fixtures = join(repository, "renderer", "html2slides", "e2e", "fixtures");
mkdirSync(fixtures, { recursive: true });
writeFileSync(join(fixtures, "slide_05.html"), "<html>fixture</html>");
const composites = join(root, "composites");
mkdirSync(composites, { recursive: true });
const [task] = buildReverseSlideTasks({ slideIds: ["complex__slide_05"], paths, repositoryRoot: repository, compositesDirectory: composites });
ok("(5a) TARGET = Google thumbnail", task?.original_png === join(complex, "originals", "slide_05.png"));
ok("(5b) ATTEMPT = Sasha render", task?.rendered_png === join(complex, "slides", "slide_05.png"));
ok("(5c) the user's comment verbatim", task?.user_comment === "shouldn't the table items be without internal divs with absolute positions?");
ok("(5d) annotation found by convention", task?.annotation_png === annotation);
ok("(5e) composite built over the SASHA render (dark), not the white target", task?.composite_png !== undefined && compositeOverDarkBase(task.composite_png), String(task?.composite_png));
ok("(5f) fixture HTML + exported HTML + import dir", task?.html_file === join(fixtures, "slide_05.html") && task.reverse?.sasha_html === join(complex, "html", "slide_05.html") && task.reverse.import_directory === join(complex, "import"));
ok("(5g) only this slide's zoom crops", task?.reverse?.zoom_crops.length === 2, JSON.stringify(task?.reverse?.zoom_crops));
ok("(5h) the current metrics row", task?.reverse?.baseline_metrics?.reverseMismatchPercent === 0.004);
ok("(5i) composites never written into the results root", !existsSync(join(results, "composites")));
ok("(5j) a forward id is refused", throws(() => buildReverseSlideTasks({ slideIds: ["slide_05"], paths, repositoryRoot: repository, compositesDirectory: composites })) !== null);

// ---------------------------------------------------------------------------
console.log("\n(6) merge settings\n");
ok("(6a) importer / engine / export / forward converter are reverse fix files", ["mcp/sasha-slides/google-slides/import-presentation.ts", "mcp/sasha-slides/engine/src/view/render/element-view.tsx", "mcp/sasha-slides/engine/src/export/slide-html.ts", "renderer/html2slides/convert-pptx.ts"].every(isReverseFixFile));
ok("(6b) the harness, goldens and results are not", !["renderer/html2slides/reverse/reverse-set.ts", "renderer/html2slides/e2e/goldens-reverse/complex__slide_05.png", ".sxs-reverse/metrics.json", "mcp/sasha-slides/addon/src/x.ts"].some(isReverseFixFile));
const reverseMerge = mergeSettingsFor("reverse", paths);
ok("(6c) reverse: own ledger, reverse filter, no intended forward slide", reverseMerge.historyDir === paths.historyDirectory && reverseMerge.converterFilter === isReverseFixFile && reverseMerge.forwardDeckSlides(["complex__slide_05"]).length === 0);
const forwardMerge = mergeSettingsFor("forward", null);
ok("(6d) forward unchanged", forwardMerge.historyDir === "/workspaces/sashaslides/.bug-solving-history" && forwardMerge.converterFilter === defaultConverterFilter && forwardMerge.forwardDeckSlides(["slide_03"]).join() === "slide_03");
ok("(6e) reverse without paths is an error", throws(() => mergeSettingsFor("reverse", null)) !== null);
ok("(6f) --direction parsing", parseSolveDirection("reverse") === "reverse" && parseSolveDirection("forward") === "forward" && throws(() => parseSolveDirection("sideways")) !== null);

// ---------------------------------------------------------------------------
console.log("\n(7) the worker brief\n");
const brief = reverseBriefFor({
  task: {
    task_id: "reverse-complex-slide-05-table",
    branch_id: "bs-x",
    workspace_dir: repository,
    shared_dir: "/overlays/shared/run-1/reverse-complex-slide-05-table",
    scratch_dir: ".bug-solving-scratch",
    analysis_dir: "bug-solving-analysis",
    fixtures_dir: "renderer/html2slides/e2e/fixtures",
    server_port: 4720,
    presentation_title: "t",
    slides: task === undefined ? [] : [task],
    cluster_description: clusters[1]?.cluster_description ?? "",
    retry_budget: 3,
    direction: "reverse",
  } satisfies Task,
  settings: { paths },
});
ok("(7a) the user's words verbatim", brief.includes(`"shouldn't the table items be without internal divs with absolute positions?"`));
ok("(7b) names the reverse direction and the three owning areas", brief.includes("REVERSE round trip") && brief.includes("mcp/sasha-slides/google-slides/") && brief.includes("engine/src/view/render/") && brief.includes("engine/src/export/slide-html.ts"));
ok("(7c) lists the exported HTML, the fixture and the zoom crops", brief.includes(join(complex, "html", "slide_05.html")) && brief.includes(join(fixtures, "slide_05.html")) && brief.includes("complex__slide_05-01-original.png"));
ok("(7d) forbids touching goldens, the harness and the rated results", brief.includes("Never change the measuring harness") && brief.includes("never write goldens") && brief.includes(results));

// ---------------------------------------------------------------------------
console.log("\n(8) the fork's rating UI\n");
const serverArguments = reverseRatingServerArguments({
  attemptDirectory: fork.attempt, port: 4721, slides: ["complex__slide_05"], analysisPath: "/a.md", taskTitle: "t",
  forkGoldensDirectory: fork.forkGoldens, historyDirectory: paths.historyDirectory,
});
const goldensFlag = serverArguments.indexOf("--reverse-goldens-dir");
ok("(8a) reverse, read-only, exits when rated, candidate", ["--direction", "reverse", "--read-only", "--exit-when-all-rated", "--candidate"].every((flag) => serverArguments.includes(flag)) && serverArguments[0] === fork.attempt);
ok("(8b) blesses into the fork, never e2e/goldens-reverse", serverArguments[goldensFlag + 1] === fork.forkGoldens && !serverArguments.some((argument) => argument.includes("e2e/goldens-reverse")));

rmSync(root, { recursive: true, force: true });
summary();

function writePng(path: string, options: Readonly<{ width: number; height: number; value: number }>): void {
  const png = new PNG({ width: options.width, height: options.height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = options.value;
    png.data[offset + 1] = options.value;
    png.data[offset + 2] = options.value;
    png.data[offset + 3] = 255;
  }
  writeFileSync(path, PNG.sync.write(png));
}

/** A transparent annotation with one opaque mark at the top-left pixel. */
function writeMarkedPng(path: string): void {
  const png = new PNG({ width: 16, height: 9 });
  png.data.fill(0);
  png.data[3] = 255;
  writeFileSync(path, PNG.sync.write(png));
}

/** An unmarked composite pixel copies its base: dark (40) when the base was the Sasha render. */
function compositeOverDarkBase(path: string): boolean {
  const png = PNG.sync.read(readFileSync(path));
  const unmarked = 4 * (png.width * 5 + 8);
  return png.data[unmarked] === 40;
}

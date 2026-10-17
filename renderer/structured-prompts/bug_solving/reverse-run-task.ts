/**
 * reverse-run-task.ts — one REVERSE-direction attempt of a bug_solving fork, as an engine chain.
 *
 * It is the reverse twin of main.ts's forward `runTask` and runs in the same place: inside the
 * fork's jailed overlay branch, wrapped by the same `tryMultipleTimes(retry_budget)`, ending in the
 * same rating-outcome marker the final merge phase reads. Only the evidence differs (see
 * reverse-direction.ts for why):
 *
 *   R2  worker      — the reverse brief (owning files, the user's words verbatim, Google thumbnail
 *                     vs Sasha render vs exported HTML) → analysis.md + the minimal fix.
 *   R3  record      — the reverse pipeline, offline, for the cluster's slides only, into the fork's
 *                     shared dir (scripts/record-reverse.ts). A crash fails the attempt.
 *   R4  gate        — the reverse pipeline over EVERY set, then the regression gate against the
 *                     user's goldens-reverse and the current metrics (reverse-regression-gate.ts).
 *                     Before the verdict, like the forward off-target gate, so the user is never
 *                     asked to rate a fix that regressed another slide.
 *   R4e highlight   — the user's annotation re-composited over the fork's new render.
 *   R5  verdict     — per slide: Google thumbnail vs the new Sasha render (+ the old one, both
 *                     exported HTML pages, the annotation, the zoom crops, the mismatch numbers).
 *   R6  summary     — fix-summary.md + the TaskResult; R6b fails on a regression, an unsolved
 *                     slide or a failed gate (→ the next attempt).
 *   A1  rating UI   — rating-server.ts --direction reverse on the fork's results, read-only,
 *                     FOREGROUND until every slide is rated (it IS the block); its "Good" click
 *                     blesses into the fork's shared dir, never the user's goldens-reverse.
 *   A2  wait        — wait-for-ratings.ts on ratings-reverse.json → the rating-outcome marker.
 *   A3  fold        — the marker into the TaskResult.
 *
 * Shared pieces of the forward chain (the verdict parser, the marker reader) are passed in rather
 * than imported, so this module and main.ts do not import each other at runtime.
 */
import type { ClaudeModel, Session, SessionWithResult } from "../../../structured-prompting/src/index.js";
import type { RatingOutcomeMarker, SlideTask, SlideVerdict, Task, TaskResult } from "./main.js";
import {
  REVERSE_GOLDEN_DRIFT_LIMIT,
  REVERSE_METRIC_RISE_LIMIT,
  REVERSE_SCRIPTS,
  reverseBaselineDirectory,
  reverseForkPaths,
  reverseRatingServerArguments,
  reverseRenderOf,
  type ReversePaths,
} from "./reverse-direction.js";
import { readReverseGateResult } from "./reverse-regression-gate.js";

/** What the reverse chain needs from the run and from main.ts. */
export type ReverseTaskSettings = Readonly<{
  paths: ReversePaths;
  chromePort: number;
  /** `ROOT="$PWD"; cd "$ROOT/renderer"` — main.ts's branch prefix, so both directions resolve
   *  repository-relative paths identically inside the branch. */
  branchCdRenderer: string;
  parseVerdict: (raw: string, expectedSlideId: string) => SlideVerdict;
  verdictRetries: number;
  validationModel: ClaudeModel | undefined;
  ratingMarkerPath: (task: Task) => string;
  readRatingMarker: (task: Task) => RatingOutcomeMarker | null;
  /** Whether BUG_SOLVING_NO_ACCEPT skips the blocking rating (rating-gate.ts). */
  acceptDisabled: boolean;
  /** Repository-relative wait-for-ratings.ts and annotation-composite.ts. */
  waitRatingsScript: string;
  compositeScript: string;
}>;

export function reverseRunTask(session: Session, task: Task, settings: ReverseTaskSettings): SessionWithResult<TaskResult> {
  const fork = reverseForkPaths(task.shared_dir);
  const ids = task.slides.map((slide) => slide.slide_id).join(",");
  const cd = settings.branchCdRenderer;
  return session
    // R2 — worker: analysis.md + the fix, nothing else.
    .prependToNextPrompt(reverseBriefFor({ task, settings }))
    .send({ prompt: reverseFixPrompt(task) })
    .assert((acknowledgement: string) => {
      if (!/FIX_APPLIED/.test(acknowledgement)) throw new Error(`Worker did not confirm fix applied. Response: ${acknowledgement.slice(0, 300)}`);
    })

    // R3 — the cluster's slides through the fork's importer/renderer/export (fatal on failure).
    .executeShell(() =>
      `${cd} && npx tsx "$ROOT/${REVERSE_SCRIPTS.record}" --canonical "${settings.paths.resultsRoot}" ` +
      `--output "${fork.attempt}" --slides ${ids} --chrome-port ${settings.chromePort}`,
    )

    // R4 — every set from the fork, then the gate against the run's baseline (the canonical
    // results when the baseline recording is missing). The gate CLI always writes its JSON and
    // exits 0; R6b reads the JSON (a missing one is a failed gate).
    .executeShell(() =>
      `${cd} && npx tsx "$ROOT/${REVERSE_SCRIPTS.record}" --canonical "${settings.paths.resultsRoot}" ` +
      `--output "${fork.everySet}" --chrome-port ${settings.chromePort} && ` +
      `BASELINE="${reverseBaselineDirectory(task.shared_dir)}"; [ -f "$BASELINE/metrics.json" ] || BASELINE="${settings.paths.resultsRoot}"; ` +
      `npx tsx "$ROOT/${REVERSE_SCRIPTS.gate}" --results "${fork.everySet}" ` +
      `--baseline "$BASELINE" --goldens "${settings.paths.goldensDirectory}" ` +
      `--cluster ${ids} --out "${fork.gateResult}" --metric-rise ${REVERSE_METRIC_RISE_LIMIT} --golden-drift ${REVERSE_GOLDEN_DRIFT_LIMIT}`,
    )

    // R4e — the user's marks over the NEW render, so the verdict sees where they point on it.
    // Best-effort per slide: a missing render keeps the build-time composite.
    .executeShell(() => `${cd} && ${highlightCommands({ task, settings, attempt: fork.attempt }).join(" && ")}`)

    // R5 — one verdict per slide, retried until it parses.
    .parallelFork(task.slides, (child, slide) =>
      (settings.validationModel ? child.switchModel(settings.validationModel) : child)
        .tryMultipleTimes<string>(settings.verdictRetries, (attempt) =>
          attempt
            .prependToNextPrompt(reverseVerdictHeader({ task, slide, attemptDirectory: fork.attempt, gateResult: fork.gateResult }))
            .send({ prompt: reverseVerdictPrompt(slide.slide_id) })
            .assert((raw: string) => { settings.parseVerdict(raw, slide.slide_id); }),
        ),
    )

    // R6 — fix summary + the TaskResult.
    .combineWith<string, TaskResult>(
      (branch) => branch.send({
        prompt:
          `All per-slide verdicts are now in. Write ${task.analysis_dir}/fix-summary.md — one paragraph covering ` +
          `the root cause and what you changed, with file:line references. After writing the file, reply with its ` +
          `contents verbatim (just the text, no JSON, no code fence).`,
      }),
      (verdictResponses, fixSummary) => ({
        task_id: task.task_id,
        workspace_dir: task.workspace_dir,
        analysis_md: `${task.analysis_dir}/analysis.md`,
        verdicts: verdictResponses.map((response, index) => verdictOf({ response, slide: task.slides[index], settings })),
        sxs_server_spec: {
          port: task.server_port,
          slides: task.slides.map((slide) => slide.slide_id),
          analysis_md: `${task.analysis_dir}/analysis.md`,
          diffs_dir: fork.attempt,
          thumbnails_dir: fork.attempt,
          task_title: `bug_solving (reverse): ${task.task_id}`,
        },
        fix_summary: fixSummary.trim(),
        rated: false,
        green: false,
        bad_slides: [],
      }),
    )

    // R6b — a regression, an unsolved slide or a failed gate sends the fork to its next attempt.
    .assert((result: TaskResult) => {
      const lines: string[] = [];
      const regressions = result.verdicts.filter((verdict) => verdict.isRegression);
      const unsolved = result.verdicts.filter((verdict) => !verdict.bugSolved);
      if (regressions.length) lines.push(`REGRESSIONS (${regressions.length}):`, ...regressions.map((verdict) => `  - ${verdict.slide_id}: ${verdict.rationale}`));
      if (unsolved.length) lines.push(`UNSOLVED (${unsolved.length}):`, ...unsolved.map((verdict) => `  - ${verdict.slide_id}: ${verdict.rationale}`));
      const gate = readReverseGateResult(fork.gateResult);
      if (!gate.ok) {
        lines.push(
          `REVERSE REGRESSION GATE FAILED (${gate.regressions.length}) — slides outside this cluster drifted from the user's goldens-reverse, rose more than ${REVERSE_METRIC_RISE_LIMIT} points, or moved a region away from Google's thumbnail:`,
          ...gate.findings.map((finding) => `  - ${finding.slide} ${finding.kind}: ${finding.detail}`),
        );
      }
      if (lines.length) throw new Error(lines.join("\n"));
    })

    // A1 — the fork's own reverse rating UI, foreground until every slide is rated.
    .combineWith<string, TaskResult>(
      (branch) => branch.executeShell((result) => ratingServerCommand({ task, settings, result, fork })),
      (result) => result,
    )

    // A2 — block on ratings-reverse.json, then write the rating-outcome marker. Always exits 0.
    .combineWith<string, TaskResult>(
      (branch) => branch.executeShell(() =>
        `${cd} && npx tsx "$ROOT/${settings.waitRatingsScript}" --results-dir "${fork.attempt}" ` +
        `--ratings-file "${fork.attempt}/ratings-reverse.json" --slides ${ids} --task-id ${task.task_id} ` +
        `--marker "${settings.ratingMarkerPath(task)}" --history-dir ${settings.paths.historyDirectory}`,
      ),
      (result) => result,
    )

    // A3 — fold the marker (missing/malformed = unrated, not green).
    .combineWith<string, TaskResult>(
      (branch) => branch.executeShell(() => `echo rating-marker-read ${task.task_id}`),
      (result) => {
        const outcome = settings.readRatingMarker(task);
        return {
          ...result,
          rated: outcome?.rated ?? false,
          green: outcome?.green ?? false,
          bad_slides: outcome ? [...outcome.bad, ...outcome.unrated] : [],
        };
      },
    );
}

/**
 * The worker's header: the reverse direction, the files that own it, and per slide the user's own
 * words verbatim plus every image/page to open. Exported for the tests (the brief is the contract
 * with the worker).
 */
export function reverseBriefFor(options: Readonly<{ task: Task; settings: Pick<ReverseTaskSettings, "paths"> }>): string {
  const { task } = options;
  return [
    `Task: ${task.task_id}  (REVERSE direction)`,
    `The user's rated results (the BEFORE; READ ONLY — never write there, never write goldens): ${options.settings.paths.resultsRoot}`,
    `You are running INSIDE an isolated overlay branch (${task.branch_id}); your cwd is the repository root and every edit is captured in the branch's private layer (the base working tree is untouched).`,
    `Analysis dir (write analysis.md / fix-summary.md HERE, repo-relative inside the branch): ${task.analysis_dir}`,
    ``,
    `WHAT IS BEING REPAIRED: the REVERSE round trip, Google Slides -> Sasha engine document -> Sasha HTML.`,
    `A Google Slides presentation is imported into a Sasha engine document, each slide is exported as one`,
    `self-contained 1280x720 HTML page, and that page is screenshotted. The user compared Google's own`,
    `thumbnail (TARGET) with the Sasha screenshot (ATTEMPT) in the reverse rating UI and rated these slides BAD.`,
    ``,
    `The code that owns this direction (fix it HERE):`,
    `  - the importer: mcp/sasha-slides/google-slides/ (import-presentation.ts, import-text.ts, import-shape-geometry.ts,`,
    `    import-pptx-supplement.ts, import-assets.ts, import-colours.ts and friends);`,
    `  - the engine renderer: mcp/sasha-slides/engine/src/view/render/;`,
    `  - the HTML export: mcp/sasha-slides/engine/src/export/slide-html.ts.`,
    `  The forward converter (renderer/html2slides/convert-pptx*.ts, extract-dom.ts) only when the user's comment is`,
    `  about the FORWARD deck itself (what Google shows), not about the Sasha side. Never change the measuring harness`,
    `  (renderer/html2slides/reverse/, reverse-roundtrip.ts) or any goldens.`,
    `Tests that must stay green: \`cd mcp/sasha-slides/engine && npm test\` and`,
    `  \`cd mcp/sasha-slides && TSX_TSCONFIG_PATH=engine/tsconfig.json node --test --import tsx 'google-slides/*.test.ts'\`.`,
    `Add a focused test next to the code you change when the defect is reproducible in one.`,
    ``,
    `Cluster hypothesis: ${task.cluster_description}`,
    ``,
    `Slides, the user's words VERBATIM, and what to open (use the Read tool; it renders PNGs):`,
    ...task.slides.flatMap((slide) => reverseSlideLines(slide)),
    ``,
    `How to treat the user's comments:`,
    `  * The user's words are ground truth. Several comments are about the STRUCTURE of the exported HTML`,
    `    (how editable it is in an HTML editor), not only about pixels: read the exported page and the imported`,
    `    snapshot, and fix the structure the user asks for while keeping the render faithful to the TARGET.`,
    `  * The annotation was drawn over the SASHA render; the HIGHLIGHTED image shows where on that render.`,
    `  * Write ${task.analysis_dir}/analysis.md with one H2 section per slide: "User comment" (verbatim), "Observed`,
    `    in current render / HTML", "Root cause" (file:line), "Fix strategy", "Expected change" (in the render and in`,
    `    the exported HTML). It persists across retries — UPDATE sections rather than rewriting.`,
    ``,
    `After writing analysis.md, apply the fix. Do NOT commit.`,
  ].join("\n");
}

function reverseSlideLines(slide: SlideTask): readonly string[] {
  const reverse = slide.reverse;
  const lines = [
    ``,
    `  ${slide.slide_id}: "${slide.user_comment}"`,
    `    - TARGET (Google Slides thumbnail — what the slide SHOULD look like): ${slide.img_original ?? slide.original_png}`,
    `    - ATTEMPT (Sasha HTML screenshot today — the defect is HERE): ${slide.img_attempt ?? slide.rendered_png}`,
  ];
  const highlighted = slide.img_highlighted ?? slide.composite_png;
  if (highlighted) lines.push(`    - HIGHLIGHTED ATTEMPT (the user's marks over the Sasha render, max contrast — WHERE the user points): ${highlighted}`);
  const annotation = slide.img_annotations ?? slide.annotation_png;
  if (annotation) lines.push(`    - RAW ANNOTATION (the marks alone, transparent): ${annotation}`);
  if (reverse === undefined) return lines;
  lines.push(`    - EXPORTED SASHA HTML today (read it — structure matters): ${reverse.sasha_html}`);
  if (reverse.fixture_html !== null) lines.push(`    - ORIGINAL FIXTURE HTML the forward deck was made from: ${reverse.fixture_html}`);
  lines.push(`    - IMPORT (snapshot.json = the engine document, losses.json = what the import dropped, presentation.json = Google's answer): ${reverse.import_directory}`);
  for (const crop of reverse.zoom_crops) lines.push(`    - ZOOM CROP of a marked region: ${crop}`);
  const metrics = reverse.baseline_metrics;
  if (metrics !== null) {
    lines.push(`    - METRICS today: reverse mismatch ${metrics.reverseMismatchPercent ?? "n/a"}%, round trip ${metrics.roundTripMismatchPercent ?? "n/a"}%, text match ${metrics.textMatch ?? "n/a"}; notes: ${metrics.notes || "(none)"}`);
  }
  return lines;
}

function reverseFixPrompt(task: Task): string {
  return [
    `Your only task right now:`,
    `  1. Open EVERY image listed for each slide (TARGET, ATTEMPT, HIGHLIGHTED ATTEMPT, zoom crops) and read the exported Sasha HTML.`,
    `  2. Write (or UPDATE) ${task.analysis_dir}/analysis.md with one H2 section per slide.`,
    `  3. Apply the MINIMAL code fix in the importer / engine renderer / HTML export (see the header).`,
    `  4. Do NOT run git commit, git stash, git checkout. Leave changes uncommitted.`,
    `  5. Do NOT run the reverse pipeline into .sxs-reverse/ and never write goldens — the orchestrator re-records`,
    `     the slides and runs the regression gate next. You MAY run the unit tests named in the header.`,
    ``,
    `When analysis.md is written and the code edits are in place, reply with exactly the line: FIX_APPLIED.`,
    `If something blocks you, reply with "FAILED: <one-line reason>" and stop.`,
  ].join("\n");
}

function highlightCommands(options: Readonly<{ task: Task; settings: ReverseTaskSettings; attempt: string }>): readonly string[] {
  const commands = options.task.slides.flatMap((slide) => {
    const render = reverseRenderOf({ resultsDirectory: options.attempt, slideId: slide.slide_id });
    const annotation = slide.img_annotations ?? slide.annotation_png;
    if (render === null || annotation === undefined) return [];
    const outputDirectory = `${options.task.shared_dir}/images`;
    return [
      `npx tsx "$ROOT/${options.settings.compositeScript}" refresh "${render.png}" "${outputDirectory}/${slide.slide_id}_after.png" ` +
        `"${annotation}" "${outputDirectory}/${slide.slide_id}_highlighted_after.png" || true`,
    ];
  });
  return commands.length > 0 ? commands : [`echo "[reverse] no annotation to re-composite"`];
}

function reverseVerdictHeader(options: Readonly<{ task: Task; slide: SlideTask; attemptDirectory: string; gateResult: string }>): string {
  const { task, slide } = options;
  const after = reverseRenderOf({ resultsDirectory: options.attemptDirectory, slideId: slide.slide_id });
  const highlightedAfter = `${task.shared_dir}/images/${slide.slide_id}_highlighted_after.png`;
  return [
    `You are verifying the REVERSE-direction fix (Google Slides -> Sasha HTML) for ${slide.slide_id}.`,
    `Analysis: ${task.analysis_dir}/analysis.md.`,
    `TARGET (Google Slides thumbnail, what it SHOULD look like): ${slide.img_original ?? slide.original_png}.`,
    `BEFORE (the Sasha render the user rated BAD): ${slide.img_attempt ?? slide.rendered_png}.`,
    `AFTER (the Sasha render with this fix): ${after?.png ?? "(unknown)"}.`,
    `Exported HTML BEFORE: ${slide.reverse?.sasha_html ?? "(unknown)"}. AFTER: ${after?.html ?? "(unknown)"}.`,
    (slide.img_highlighted ?? slide.composite_png) ? `HIGHLIGHTED BEFORE (the user's marks over the old render): ${slide.img_highlighted ?? slide.composite_png}.` : ``,
    (slide.img_annotations ?? slide.annotation_png) ? `HIGHLIGHTED AFTER (the same marks over the new render): ${highlightedAfter}.` : ``,
    ...(slide.reverse?.zoom_crops ?? []).map((crop) => `Zoom crop of a marked region: ${crop}.`),
    `Mismatch numbers: the fork's metrics ${after?.metrics ?? "(unknown)"} (reverseMismatchPercent, roundTripMismatchPercent, textMatch) ` +
      `against before: reverse ${slide.reverse?.baseline_metrics?.reverseMismatchPercent ?? "n/a"}%, round trip ${slide.reverse?.baseline_metrics?.roundTripMismatchPercent ?? "n/a"}%, text ${slide.reverse?.baseline_metrics?.textMatch ?? "n/a"}. ` +
      `The whole-deck regression gate's result (other slides vs the user's goldens): ${options.gateResult}.`,
    `User's original comment (verbatim): "${slide.user_comment}".`,
  ].filter((line) => line.length > 0).join(" ");
}

function reverseVerdictPrompt(slideId: string): string {
  return [
    `Read analysis.md (the H2 section for ${slideId}). Open the TARGET, BEFORE and AFTER images and, when listed, both HIGHLIGHTED images and the zoom crops (the Read tool renders PNGs).`,
    `Read the exported HTML BEFORE and AFTER: when the user's comment is about the HTML's STRUCTURE (editability, absolute positions vs padding, one span vs many), judge it from the AFTER HTML — a pixel-identical render does not solve a structural complaint, and a structural fix must still render like the TARGET.`,
    `Judge the MARKED REGION first, then the whole slide. Use the mismatch numbers as supporting evidence; a lower reverse mismatch alone is not proof.`,
    `If the AFTER render or HTML is missing, the fix did not render: bugSolved=false and say so.`,
    `Respond with ONLY a single-line JSON object (no prose, no code fences) with these keys:`,
    `  slide_id (string, must equal "${slideId}"), rationale (string, <=500 chars), isRegression (boolean; true if the AFTER render or HTML introduces NEW problems),`,
    `  bugSolved (boolean; true ONLY if what the user marked and wrote is visibly / structurally fixed in AFTER and the render still matches the TARGET).`,
    `Example: {"slide_id":"${slideId}","rationale":"table cells now use padding; render matches the thumbnail","isRegression":false,"bugSolved":true}`,
  ].join(" ");
}

function verdictOf(options: Readonly<{ response: string; slide: SlideTask | undefined; settings: ReverseTaskSettings }>): SlideVerdict {
  const slideId = options.slide?.slide_id ?? "(unknown)";
  try {
    return options.settings.parseVerdict(options.response, slideId);
  } catch (cause) {
    // Every response already passed the parsing assert (with retries); this is the all-retries-failed
    // case, which counts as a regression so the attempt is retried rather than rated.
    return {
      slide_id: slideId,
      rationale: `(verdict unparseable after ${options.settings.verdictRetries} retries: ${cause instanceof Error ? cause.message : String(cause)}) raw=${options.response.slice(0, 200)}`,
      isRegression: true,
      bugSolved: false,
    };
  }
}

function ratingServerCommand(options: Readonly<{ task: Task; settings: ReverseTaskSettings; result: TaskResult; fork: ReturnType<typeof reverseForkPaths> }>): string {
  const { task, settings, result, fork } = options;
  const cd = settings.branchCdRenderer;
  if (settings.acceptDisabled) return `${cd} && echo "[rating-server] NO_ACCEPT → skipping ${task.task_id} reverse rating UI"`;
  const spec = result.sxs_server_spec;
  const log = `"${task.shared_dir}/reverse/rating-server.log"`;
  return (
    `${cd} && mkdir -p "${task.shared_dir}/reverse" && ` +
    `echo "[rating-server] ${task.task_id} (reverse) → http://localhost:${spec.port} (log ${task.shared_dir}/reverse/rating-server.log)" && ` +
    `npx tsx "$ROOT/${REVERSE_SCRIPTS.ratingServer}" ` +
    reverseRatingServerArguments({
      attemptDirectory: fork.attempt,
      port: spec.port,
      slides: spec.slides,
      analysisPath: `$ROOT/${spec.analysis_md}`,
      taskTitle: spec.task_title,
      forkGoldensDirectory: fork.forkGoldens,
      historyDirectory: settings.paths.historyDirectory,
    }).map((argument) => `"${argument}"`).join(" ") +
    ` 2> ${log}`
  );
}

/**
 * bug_solving — structured prompt for resolving a clustered batch of
 * html2slides rendering bugs across one or more slides.
 *
 * ## How to use
 *   1. cd /workspaces/sashaslides
 *   2. Create a sibling `./clusters.ts` that exports `CLUSTERS` of type
 *      `Cluster[]` (see `workspace-setup.ts`). Example:
 *        export const CLUSTERS = [
 *          { task_id: "clipping", cluster_description: "...",
 *            slide_ids: ["slide_11", "slide_12", "slide_14", "slide_28"] },
 *        ];
 *      main-scaffolding.ts imports CLUSTERS from that file by default and
 *      refuses to build until you create it. This is intentional — it
 *      prevents accidental smoke runs.
 *   3. Build:  `npx tsx structured-prompting/build.ts renderer/structured-prompts/bug_solving/main-scaffolding.ts`
 *   4. Run:    `node structured-prompting/dist/main-scaffolding.mjs`
 *   5. The engine monitor URL is printed on the first lines of stderr
 *      (look for `┌── structured-prompting monitor`). Scaffolding prints
 *      it again at the end along with per-task SxS server URLs.
 *   6. Separately, start the port-range notifier ONCE per session so
 *      per-task SxS servers surface in chat as they come up:
 *        Monitor({
 *          command: "bash renderer/structured-prompts/bug_solving/scripts/notify-new-servers.sh",
 *          persistent: true, timeout_ms: 3600000,
 *          description: "bug_solving SxS servers",
 *        })
 *      Each task that successfully finishes will produce one
 *      `NEW http://localhost:<port>` line in the chat. The notifier
 *      also re-announces a port when an old listener dies and a new
 *      one binds — convenient when restarting a server.
 *
 * ## Scaffolding lifecycle (detached servers, clean exit)
 *   main-scaffolding.ts launches one rating server per successful
 *   TaskResult as a `detached: true` child with `child.unref()`. That
 *   means:
 *     * When `main()` (this structured prompt) returns and
 *       engine.execute resolves, the scaffolding prints a summary
 *       and EXITS. It does not wait for servers.
 *     * The servers survive the scaffolding — they're in their own
 *       process group with no parent refcount. They stay up until the
 *       user kills them manually:
 *         lsof -ti:4720-4800 | xargs -r kill
 *     * Ctrl-C on the scaffolding does NOT reach the servers.
 *   The earlier "wait on children" design was removed — a zombie
 *   scaffolding holding open references to servers after the work
 *   graph was done served no purpose.
 *
 * ## Per-task pipeline (retryable up to task.retry_budget times)
 *   1. record-pptx.sh → one .pptx per slide, parallel, --no-upload (BEFORE)
 *   2. worker writes analysis.md + applies code fix
 *   3. record-pptx.sh → AFTER
 *   4. diff-pptx-pairs.ts → OOXML-level diff + summary.json per slide
 *   5. parallelFork per slide: sub-session emits a typed JSON verdict
 *      {slide_id, rationale, isRegression, bugSolved}
 *   6. aggregate verdicts — throw if any isRegression || !bugSolved;
 *      analysis.md is kept so the next attempt refines rather than
 *      restarts
 *   7. upload-and-scrape.ts → uploads a combined pptx under a
 *      fork-unique title, scrapes per-slide PNG thumbnails
 *   8. (NOT booted here — see note below) emits a SxsServerSpec in the
 *      TaskResult so main-scaffolding.ts can spawn the filtered rating
 *      server as a tracked child process AFTER this prompt resolves
 *
 * ## Return type & subprocess lifetime
 *   Returns `SessionWithResult<Array<Result<TaskResult>>>`. Each
 *   TaskResult carries an `sxs_server_spec`, NOT a running URL. The
 *   scaffolding is responsible for spawning the rating servers as
 *   tracked children so they die with the Node process on Ctrl-C /
 *   SIGTERM / exit. main.ts intentionally does not shell out to
 *   `nohup … & disown` — that would orphan the servers past the parent's
 *   death.
 */

import {
  Session,
  SessionWithResult,
  describeError,
} from "../../../structured-prompting/src/index.js";
import type { Result } from "../../../structured-prompting/src/types.js";
import { writeFileSync, readFileSync, readdirSync, copyFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

/**
 * Write the sxs-meta.json sidecar consumed by rating-server.ts so each SxS card
 * can show the round-1 provenance the user complained was missing: the original
 * source HTML, the live presentation URL, the original annotation they drew, and
 * the original comment they typed. The harness COPIES the html fixture + the
 * annotation PNG into resultsDir (source/ and orig-annotations/) so the rating
 * server's existing static routes can reach them (it cannot serve arbitrary
 * absolute /tmp paths via /html). Best-effort and fully non-fatal — a throw here
 * must NEVER convert an already-PASSED fix into a retry.
 *
 * @param resultsDir  the rating-server resultsDir (= <scratch>/thumbnails)
 * @param slides      per-slide round-1 records (html_file, user_comment, annotation_png)
 */
function writeSxsMeta(resultsDir: string, slides: SlideTask[]): void {
  try {
    // Read the STRUCTURED manifest record-rendering --mode full wrote
    // (<thumbs>/manifest.json = { presentation_id, slides, ... }) rather than
    // regex-scraping the upload's stdout. The presentation URL is derived from
    // the typed presentation_id field.
    let presentationUrl: string | undefined;
    const manifestPath = join(resultsDir, "thumbs", "manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { presentation_id?: string };
        if (typeof manifest.presentation_id === "string" && manifest.presentation_id) {
          presentationUrl = `https://docs.google.com/presentation/d/${manifest.presentation_id}/edit`;
        }
      } catch { /* malformed manifest → no URL */ }
    }

    const sourceDir = join(resultsDir, "source");
    const annotDir = join(resultsDir, "orig-annotations");
    mkdirSync(resultsDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(annotDir, { recursive: true });

    const meta: Record<string, {
      html_file?: string;
      presentation_url?: string;
      original_comment?: string;
      original_annotation?: string;
      original_png?: string;
    }> = {};

    for (const s of slides) {
      const entry: (typeof meta)[string] = {};
      // Copy the source HTML into resultsDir/source/<id>.html (served via /html,
      // which resolves relative to resultsDir).
      if (s.html_file && existsSync(s.html_file)) {
        const dst = join(sourceDir, `${s.slide_id}.html`);
        try { copyFileSync(s.html_file, dst); entry.html_file = `source/${s.slide_id}.html`; } catch {}
      }
      if (presentationUrl) entry.presentation_url = presentationUrl;
      if (s.user_comment) entry.original_comment = s.user_comment;
      // Copy the original annotation PNG (served via /img by absolute path, but
      // copy into resultsDir so it survives a /tmp wipe of the source).
      if (s.annotation_png && existsSync(s.annotation_png)) {
        const dst = join(annotDir, `${s.slide_id}.png`);
        try { copyFileSync(s.annotation_png, dst); entry.original_annotation = `orig-annotations/${s.slide_id}.png`; } catch {}
      }
      if (s.original_png && existsSync(s.original_png)) entry.original_png = s.original_png;
      meta[s.slide_id] = entry;
    }

    writeFileSync(join(resultsDir, "sxs-meta.json"), JSON.stringify(meta, null, 2));
  } catch (e) {
    console.error(`[writeSxsMeta] non-fatal: ${(e as Error).message}`);
  }
}

// ---------- Types ----------

export interface SlideTask {
  slide_id: string;                  // "slide_11"
  html_file: string;                 // absolute path to the fixture HTML
  user_comment: string;              // text pulled from ratings.json
  annotation_png?: string;           // absolute path if present
  rendered_png: string;              // absolute path in /tmp/sxs-complex/slides
  original_png: string;              // absolute path in /tmp/sxs-complex/originals
}

export interface Task {
  task_id: string;                   // stable slug, e.g. "clipping-curves"
  workspace_dir: string;             // git worktree created for this task
  scratch_dir: string;               // per-task scratch (under workspace_dir, GITIGNORED — binary pptx/diff artifacts)
  analysis_dir: string;              // per-task model docs (under workspace_dir, NOT ignored — visible in the per-node diff)
  fixtures_dir: string;              // repo-relative fixtures dir for this cluster's slides (e.g. fixtures-basic)
  server_port: number;               // unique port for the filtered rating server
  presentation_title: string;        // fork-unique, e.g. "bug_solving-clipping-curves-1713512345"
  slides: SlideTask[];
  cluster_description: string;       // root-cause hypothesis for the wave
  retry_budget: number;              // e.g. 3
}

export interface SlideVerdict {
  slide_id: string;
  rationale: string;
  isRegression: boolean;
  bugSolved: boolean;
}

/** How many times to re-prompt a single-slide verdict whose response doesn't
 *  parse/validate into a SlideVerdict. */
const VERDICT_RETRIES = 3;

/**
 * Typed, validated parse of a per-slide verdict response. Throws on malformed
 * JSON or wrong field types — used as the verdict step's `assert` so a bad
 * response is RETRIED (instead of the old "manual regex + silent fallback to
 * isRegression=true"). The thrown message tells the retry what was wrong.
 */
function parseSlideVerdict(raw: string, expectedSlideId: string): SlideVerdict {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("verdict response contained no JSON object");
  let o: Record<string, unknown>;
  try { o = JSON.parse(m[0]) as Record<string, unknown>; }
  catch (e) { throw new Error(`verdict JSON did not parse: ${(e as Error).message}`); }
  if (typeof o.rationale !== "string") throw new Error("verdict.rationale must be a string");
  if (typeof o.isRegression !== "boolean") throw new Error("verdict.isRegression must be a boolean");
  if (typeof o.bugSolved !== "boolean") throw new Error("verdict.bugSolved must be a boolean");
  const slide_id = typeof o.slide_id === "string" && o.slide_id ? o.slide_id : expectedSlideId;
  return { slide_id, rationale: o.rationale, isRegression: o.isRegression, bugSolved: o.bugSolved };
}

/**
 * C2 off-target regression detection. Reads the whole-deck diff produced by
 * step 4b (<scratch>/reg-diffs/<slide>.diff) and returns any slide NOT in this
 * cluster whose pptx changed between HEAD and the worker's fix (its diff is not
 * "(no structural differences detected)"). Those are unexpected regressions the
 * fix introduced on unrelated slides and must fail the attempt.
 */
function detectOffTargetRegressions(task: Task): string[] {
  const regDir = `${task.scratch_dir}/reg-diffs`;
  if (!existsSync(regDir)) return [];
  const clusterIds = new Set(task.slides.map(s => s.slide_id));
  const out: string[] = [];
  for (const f of readdirSync(regDir)) {
    if (!f.endsWith(".diff")) continue;
    const sid = f.replace(/\.diff$/, "");
    if (clusterIds.has(sid)) continue; // cluster slides are EXPECTED to change
    let txt = "";
    try { txt = readFileSync(join(regDir, f), "utf-8"); } catch { continue; }
    if (!/no structural differences/i.test(txt)) out.push(sid);
  }
  return out.sort();
}

/** Off-target regressions to FAIL on. Prefers the visual gate's verdict
 *  (<scratch>/offtarget-gate.json `regressions` = slides the image verifier
 *  judged visibly WORSE after the fix). Falls back to the conservative binary
 *  structural check (detectOffTargetRegressions) if the gate file is missing or
 *  corrupt, so a gate-script failure can never silently drop the off-target
 *  safety net. */
function readOffTargetRegressions(task: Task): string[] {
  const f = join(task.scratch_dir, "offtarget-gate.json");
  if (existsSync(f)) {
    try {
      const o = JSON.parse(readFileSync(f, "utf-8")) as { regressions?: unknown };
      if (Array.isArray(o.regressions)) return o.regressions.filter((s): s is string => typeof s === "string");
    } catch { /* fall through to the structural check */ }
  }
  return detectOffTargetRegressions(task);
}

/** Spec for a post-run rating server that main-scaffolding.ts will boot as
 *  a tracked child process. main.ts returns this spec; it does NOT launch
 *  the server itself (see header: subprocess lifetime). */
export interface SxsServerSpec {
  port: number;
  slides: string[];                  // slide ids to show in the filtered UI
  analysis_md: string;               // path to task-level analysis.md
  diffs_dir: string;                 // per-slide .diff files live here
  thumbnails_dir: string;            // slide_<id>.png live here
  task_title: string;                // header displayed in the UI
}

export interface TaskResult {
  task_id: string;
  workspace_dir: string;
  analysis_md: string;               // path to analysis.md written by the worker
  verdicts: SlideVerdict[];
  sxs_server_spec: SxsServerSpec;    // scaffolding boots the server, not main.ts
  fix_summary: string;               // one-paragraph summary emitted by the worker
}

// ---------- Helpers ----------

/** Path to the shell/ts helper scripts that live alongside main.ts. */
const SCRIPTS = {
  // record-pptx.sh was inlined into record-rendering.ts (a tsx CLI). It must
  // run with cwd = <workspace>/renderer so tsx + convert-pptx's node_modules
  // resolve, and it writes per-slide pptx to <out>/pptx/<slide_id>.pptx.
  record: "renderer/structured-prompts/bug_solving/scripts/record-rendering.ts",
  diff: "renderer/structured-prompts/bug_solving/scripts/diff-pptx-pairs.ts",
  filteredServer: "renderer/structured-prompts/bug_solving/scripts/filtered-rating-server.ts",
  // Visual off-target gate: renders changed non-cluster slides BEFORE/AFTER and
  // image-verifies whether the change is a VISIBLE regression (vs the old binary
  // structural fail). Writes <scratch>/offtarget-gate.json.
  offtargetGate: "renderer/structured-prompts/bug_solving/scripts/offtarget-gate.ts",
};

const slideIdsCsv = (t: Task) => t.slides.map(s => s.slide_id).join(",");

/** Build the per-slide analysis prompt text. Included in the first-round
 *  prompt so the worker knows exactly how to treat user SxS comments. */
function analysisPromptFor(task: Task): string {
  return [
    `Task: ${task.task_id}`,
    `Workspace: ${task.workspace_dir}`,
    `Scratch (binary artifacts, gitignored): ${task.scratch_dir}`,
    `Analysis dir (write analysis.md / fix-summary.md HERE — it is tracked + shows in the diff): ${task.analysis_dir}`,
    `Cluster hypothesis: ${task.cluster_description}`,
    ``,
    `Slides in this task and the user's SxS comments for each:`,
    ...task.slides.map(s =>
      `  - ${s.slide_id}: "${s.user_comment}"` +
      (s.annotation_png ? ` (annotation: ${s.annotation_png})` : ``)
    ),
    ``,
    `How to incorporate the user's comments into your analysis:`,
    `  * The user's words are ground truth — do not argue with them. Your job is`,
    `    to explain the WHY and propose the minimal fix.`,
    `  * For each slide, open the annotation PNG if it exists. The red strokes`,
    `    mark exactly where the user says the rendering is wrong.`,
    `  * Always disambiguate TEXT-vs-BOX when the comment is about alignment.`,
    `  * Write your findings into ${task.analysis_dir}/analysis.md. Use one H2`,
    `    section per slide. Each section must have: "User comment" (verbatim),`,
    `    "Observed in current render" (what you see), "Root cause" (file:line),`,
    `    "Fix strategy" (what you'll change), "Expected diff" (what the pptx`,
    `    XML change will look like). analysis.md is retry-persistent — on`,
    `    subsequent attempts, UPDATE existing sections rather than rewriting.`,
    ``,
    `After writing analysis.md, apply the fix. Do NOT commit.`,
  ].join("\n");
}

// ---------- Main ----------

export function main(args: {
  session: Session;
  tasks: Task[];
}): SessionWithResult<Array<Result<TaskResult>>> {

  // --- inner per-task attempt body ----------------------------------------
  const runTask = (s: Session, task: Task): SessionWithResult<TaskResult> => {
    const ids = slideIdsCsv(task);
    return s
      // Steps 1–4 combined: the worker runs the record/analyze/fix/
      // diff loop itself via its bash tool. We fold it into one `send`
      // for two reasons:
      //   (a) `executeShell` only exists on SessionWithResult — we need
      //       a result-producing op (send) before we can chain shells.
      //   (b) The worker already has the full context (annotations,
      //       user comments, scratch dir layout) from
      //       `analysisPromptFor(task)` — asking it to drive its own
      //       shell loop is cheaper and more natural than bouncing
      //       between our shell and its model calls.
      // Step 1 (record BEFORE pptx) runs in the scaffolding, not here —
      // it's a side-effect-only script with no model judgement, and
      // lifting it out keeps this graph clean. See main-scaffolding.ts.
      //
      // Steps 2, 3, 4 below: one model-driven step (analyze+fix) then
      // two script-only steps (record-after, diff) invoked via
      // executeShell now that we have a SessionWithResult from step 2.
      //
      // NOTE on typed responses: we deliberately use `.send({prompt})`
      // (returns `SessionWithResult<string>`) and JSON.parse in
      // `combine` callbacks instead of `.send<T>({prompt})`. Reason:
      // typia's `json.schema<T>()` transform only inlines when the
      // source file is in typia's internal TS program. We hit a silent-
      // no-op case for files outside `structured-prompting/src/` — the
      // generic call survived to runtime and threw ("no transform has
      // been configured"). Plain string responses + manual JSON parsing
      // are robust to that.

      // Step 2 — model: write/update analysis.md + apply the code fix.
      .prependToNextPrompt(analysisPromptFor(task))
      .send({
        prompt: [
          `The BEFORE-state pptx files are already at ${task.scratch_dir}/before/pptx/<slide_id>.pptx — the scaffolding recorded them before you started. Use them as reference if helpful.`,
          ``,
          `Your only task right now:`,
          `  1. Inspect the annotation PNGs listed in the header.`,
          `  2. Write (or UPDATE if it exists) ${task.analysis_dir}/analysis.md with one H2 section per slide using the template you were given.`,
          `  3. Apply the MINIMAL code fix in renderer/html2slides/extract-dom.ts and/or convert-pptx.ts.`,
          `  4. Do NOT run git commit, git stash, git checkout. Leave changes uncommitted.`,
          `  5. Do NOT record the AFTER pptx, do NOT run the diff script — the orchestrator runs those next.`,
          ``,
          `When analysis.md is written and the code edits are in place, reply with exactly the line: FIX_APPLIED.`,
          `If something blocks you, reply with "FAILED: <one-line reason>" and stop.`,
        ].join("\n"),
      })
      .assert((ack: string) => {
        if (!/FIX_APPLIED/.test(ack)) {
          throw new Error(`Worker did not confirm fix applied. Response: ${ack.slice(0, 300)}`);
        }
      })

      // Step 3 — record AFTER pptx via shell (one file per slide). Runs from
      // the WORKTREE's renderer/ so it picks up the worker's just-applied fix
      // (record-rendering.ts → <out>/pptx/<slide_id>.pptx).
      .executeShell(() =>
        `cd ${task.workspace_dir}/renderer && npx tsx ${task.workspace_dir}/${SCRIPTS.record} ` +
        `--mode pptx --fixtures ${task.workspace_dir}/${task.fixtures_dir} ` +
        `--slides ${ids} --out ${task.scratch_dir}/after`
      )

      // Step 4 — pairwise diffs via shell. before/after pptx live under the
      // `pptx/` subdir that record-rendering writes; diff-pptx-pairs needs
      // JSZip so it also runs from renderer/ for node_modules resolution.
      .executeShell(() =>
        `cd ${task.workspace_dir}/renderer && npx tsx ${task.workspace_dir}/${SCRIPTS.diff} ` +
        `--before ${task.scratch_dir}/before/pptx --after ${task.scratch_dir}/after/pptx ` +
        `--out ${task.scratch_dir}/diffs`
      )

      // Step 4b — REGRESSION SCAN across the WHOLE fixture deck (not just this
      // cluster's slides). Render every fixture WITH the worker's fix
      // (after-all) and WITHOUT it (baseline — the fix git-stashed, then
      // restored), then diff. Step 6b fails the attempt if any NON-cluster
      // slide changed (an off-target regression). Dirs are cleared first so a
      // retry never diffs stale pptx (the round-2 idempotent-cache trap).
      .executeShell(() => {
        const wt = task.workspace_dir;
        const fx = `${wt}/${task.fixtures_dir}`;
        const sc = task.scratch_dir;
        const rec = `${wt}/${SCRIPTS.record}`;
        const dif = `${wt}/${SCRIPTS.diff}`;
        return [
          `cd ${wt}/renderer`,
          `rm -rf ${sc}/after-all ${sc}/before-all ${sc}/reg-diffs`,
          `ALL=$(ls ${fx}/slide_*.html | xargs -n1 basename | sed 's/[.]html$//' | sort -V | paste -sd,)`,
          // RECORD_CONCURRENCY=1 forces SEQUENTIAL rendering of the whole-deck
          // before/after passes. Concurrent Chrome tabs race on web-font load,
          // shifting text metrics → nondeterministic pptx → PHANTOM off-target
          // regressions (this is what falsely failed flex-panel-width: a no-op
          // fix drew a disjoint set of "changed" slides each run). Sequential
          // rendering is empirically byte-deterministic (full-deck HEAD-vs-HEAD
          // = 0 structural drift), so the off-target diff reflects ONLY the fix.
          `RECORD_CONCURRENCY=1 npx tsx ${rec} --mode pptx --fixtures ${fx} --slides "$ALL" --out ${sc}/after-all`,
          // baseline: stash the worker's tracked fix, render HEAD, restore.
          `git -C ${wt} stash push -m bs-regbase >/dev/null 2>&1 || true`,
          `RECORD_CONCURRENCY=1 npx tsx ${rec} --mode pptx --fixtures ${fx} --slides "$ALL" --out ${sc}/before-all`,
          `git -C ${wt} stash list | grep -q bs-regbase && git -C ${wt} stash pop >/dev/null 2>&1 || true`,
          `npx tsx ${dif} --before ${sc}/before-all/pptx --after ${sc}/after-all/pptx --out ${sc}/reg-diffs`,
        ].join(" && ");
      })

      // Step 4c — render the AFTER state to Google Slides BEFORE the verdict so
      // each per-slide verifier can VISUALLY compare the target vs the post-fix
      // render. This is what lets the verdict judge PIXEL-ONLY fixes the OOXML
      // structural diff is blind to (e.g. a rounded-corner image mask whose
      // <p:pic> XML is unchanged). The thumbnails dir is cleared first so every
      // retry attempt re-renders the NEW fix (uploadAndScrape is idempotent on a
      // present manifest and would otherwise reuse a stale render). Best-effort
      // (`|| true`): a flaky Google upload must not block the verdict — the
      // verifier falls back to the diff when the AFTER image is missing.
      .executeShell(() =>
        `rm -rf ${task.scratch_dir}/thumbnails && ` +
        `cd ${task.workspace_dir}/renderer && npx tsx ${task.workspace_dir}/${SCRIPTS.record} ` +
        `--mode full --fixtures ${task.workspace_dir}/${task.fixtures_dir} ` +
        `--slides ${ids} --title "${task.presentation_title}" ` +
        `--out ${task.scratch_dir}/thumbnails || true`,
      )

      // Step 4d — VISUAL off-target gate. Reads step 4b's reg-diffs, and for any
      // NON-cluster slide the fix changed structurally, renders it BEFORE/AFTER
      // to Slides and asks an image-aware verifier whether the change is a
      // VISIBLE regression (a benign reflow passes). Writes
      // <scratch>/offtarget-gate.json, which step 6b reads. Best-effort
      // (`|| true`): the helper always writes the file + exits 0, and step 6b
      // falls back to the conservative binary structural check if it's missing.
      .executeShell(() =>
        `cd ${task.workspace_dir}/renderer && npx tsx ${task.workspace_dir}/${SCRIPTS.offtargetGate} ` +
        `--scratch ${task.scratch_dir} --cluster ${ids} --workdir ${task.workspace_dir} ` +
        `--fixtures ${task.workspace_dir}/${task.fixtures_dir} ` +
        `--record ${task.workspace_dir}/${SCRIPTS.record} ` +
        `--title "${task.presentation_title}-offtarget" || true`,
      )

      // Step 5 — per-slide verdict fork. Each slide gets its own sub-
      // session that reads the diff + analysis + comment, emits a JSON
      // object as plain text, and we parse it in the combineWith below.
      // parallelFork already creates independent child sessions — no
      // explicit fork()/compact() needed; the children inherit the
      // parent chain's conversation state directly, which helps them
      // know what happened in steps 1–4 without extra prompting.
      .parallelFork(task.slides, (child, slide) =>
        // Retry the verdict prompt (up to VERDICT_RETRIES) until the response
        // parses + validates into a SlideVerdict. The `assert` runs the typed
        // parser; a throw triggers a re-send rather than accepting garbage.
        child.tryMultipleTimes<string>(VERDICT_RETRIES, (c) =>
          c
            .prependToNextPrompt(
              `You are verifying the fix for ${slide.slide_id}. ` +
              `Analysis: ${task.analysis_dir}/analysis.md. ` +
              `Diff (OOXML structural): ${task.scratch_dir}/diffs/${slide.slide_id}.diff. ` +
              `TARGET render (what it SHOULD look like): ${slide.original_png}. ` +
              `AFTER render (the post-fix Google-Slides output): ${task.scratch_dir}/thumbnails/thumbs/${slide.slide_id}.png. ` +
              (slide.annotation_png ? `User annotation (red marks the defect): ${slide.annotation_png}. ` : ``) +
              `User's original comment: "${slide.user_comment}".`,
            )
            .send({
              prompt: [
                `Read analysis.md (the H2 section for ${slide.slide_id}) and the diff file.`,
                `Then use the Read tool to VIEW (open as images — the Read tool renders a PNG visually) ALL of these from the header: the TARGET render, the AFTER render, AND — if a "User annotation" path is listed — the ANNOTATION image. You MUST open the annotation when one is provided.`,
                `The annotation's red marks show EXACTLY where the user says the defect is. FOCUS your judgement on that MARKED REGION: locate the same region in the AFTER render and the TARGET, and decide whether the specific defect the user circled is gone — not whether the slide merely looks broadly okay.`,
                `Compare TARGET vs AFTER (within the marked region first, then overall) against the user's comment to judge whether the defect is fixed and nothing new broke.`,
                `IMPORTANT: the OOXML diff can be EMPTY for a correct PIXEL-ONLY fix (e.g. a rasterized rounded-corner image mask). In that case judge from the IMAGES, not the diff — an empty diff is NOT evidence of failure.`,
                `If the AFTER render file is missing/unreadable, judge from the diff + analysis alone and say so in the rationale.`,
                `Respond with ONLY a single-line JSON object (no prose, no code fences, no trailing commentary) with these keys:`,
                `  slide_id     (string, must equal "${slide.slide_id}"),`,
                `  rationale    (string, <=500 chars; what changed visually and/or structurally, and why),`,
                `  isRegression (boolean; true if the diff OR the AFTER image introduces NEW rendering problems not mentioned in analysis.md's Expected-diff section),`,
                `  bugSolved    (boolean; true ONLY if the user's MARKED REGION (from the annotation) in the AFTER render now matches the TARGET — the circled defect is visibly GONE — AND the user's comment is addressed AND it matches the Expected-diff claim. A pixel-only fix with an empty diff still counts as solved when the AFTER image's marked region is correct. If an annotation was provided but you could not open it, set bugSolved=false and say so in the rationale).`,
                `Example:`,
                `{"slide_id":"${slide.slide_id}","rationale":"device corners now rounded in the AFTER render; target and after match","isRegression":false,"bugSolved":true}`,
              ].join(" "),
            })
            .assert((raw: string) => { parseSlideVerdict(raw, slide.slide_id); }),
        ),
      )

      // Step 6 — aggregate verdicts. Parse each slide's JSON response,
      // throw if any regression or unsolved. Since we no longer rely on
      // typia to emit a typed TaskResult, we synthesize it ourselves from
      // the ground-truth fields the orchestrator controls.
      .combineWith<string, TaskResult>(
        (branch) => branch.send({
          prompt: [
            `All per-slide verdicts are now in. Write ${task.analysis_dir}/fix-summary.md —`,
            `one paragraph covering the root cause and what you changed, with file:line`,
            `references. After writing the file, reply with its contents verbatim (just`,
            `the text, no JSON, no code fence).`,
          ].join(" "),
        }),
        (verdictStrings, fixSummary) => {
          // Each response already passed the validating `assert` (with retries),
          // so parseSlideVerdict won't normally throw here. Keep a defensive
          // fallback for the rare all-retries-failed case.
          const verdicts: SlideVerdict[] = verdictStrings.map((s, i) => {
            try {
              return parseSlideVerdict(s, task.slides[i].slide_id);
            } catch (e) {
              return {
                slide_id: task.slides[i].slide_id,
                rationale: `(verdict unparseable after ${VERDICT_RETRIES} retries: ${(e as Error).message}) raw=${s.slice(0, 200)}`,
                isRegression: true,  // conservatively treat an unparseable verdict as a regression
                bugSolved: false,
              };
            }
          });
          const aggregate: TaskResult = {
            task_id: task.task_id,
            workspace_dir: task.workspace_dir,
            analysis_md: `${task.analysis_dir}/analysis.md`,
            verdicts,
            sxs_server_spec: {
              port: task.server_port,
              slides: task.slides.map(s => s.slide_id),
              analysis_md: `${task.analysis_dir}/analysis.md`,
              diffs_dir: `${task.scratch_dir}/diffs`,
              // record-rendering --mode full writes the Slides thumbnail to
              // <out>/thumbs/<id>.png, so the SxS slides-dir must be that
              // subdir (not the bare out dir) or the rating UI shows no render.
              thumbnails_dir: `${task.scratch_dir}/thumbnails/thumbs`,
              task_title: `bug_solving: ${task.task_id}`,
            },
            fix_summary: fixSummary.trim(),
          };
          return aggregate;
        },
      )
      // Step 6b — throw if any verdict is a regression or not solved.
      // assert() rejects the upstream on throw, which the surrounding
      // tryMultipleTimes then catches and routes to a retry attempt.
      .assert((tr: TaskResult) => {
        const lines: string[] = [];
        const regressions = tr.verdicts.filter(v => v.isRegression);
        const unsolved = tr.verdicts.filter(v => !v.bugSolved);
        if (regressions.length)
          lines.push(`REGRESSIONS (${regressions.length}):`,
            ...regressions.map(r => `  - ${r.slide_id}: ${r.rationale}`));
        if (unsolved.length)
          lines.push(`UNSOLVED (${unsolved.length}):`,
            ...unsolved.map(r => `  - ${r.slide_id}: ${r.rationale}`));
        // C2: fail on off-target regressions — but ONLY ones the step-4d visual
        // gate confirmed are VISIBLY worse (not any structural change). Falls
        // back to the binary structural check if the gate file is absent.
        const offTarget = readOffTargetRegressions(task);
        if (offTarget.length)
          lines.push(`OFF-TARGET VISIBLE REGRESSIONS (${offTarget.length}) — non-cluster slides the image verifier judged visibly worse after this fix: ${offTarget.join(", ")}`);
        if (lines.length) throw new Error(lines.join("\n"));
      })

      // Step 7 — upload consolidated pptx + scrape thumbnails.
      //   This is our only Google-side effect in main.ts and it's
      //   short-lived (finishes before the result is returned).
      //   `combineWith` preserves the upstream TaskResult across the
      //   executeShell side effect.
      //
      // Step 8 — no action needed here. The TaskResult already carries
      //   `sxs_server_spec` from step 6. main-scaffolding.ts reads it
      //   after engine.execute resolves and spawns the filtered rating
      //   server as a tracked child process (see file header:
      //   "subprocess lifetime").
      .combineWith<string, TaskResult>(
        // upload-and-scrape.ts was inlined into record-rendering.ts (commit
        // 346965d), so `--mode full` (pptx + Slides upload + thumb scrape) is
        // the replacement. Runs from the worktree's renderer/ for node_modules.
        // `|| true` makes it NON-FATAL: this is post-verdict productization for
        // the SxS review — a flaky Google upload must NOT throw away an
        // already-PASSED fix (which is exactly what the dead script was doing).
        (branch) => branch.executeShell(() =>
          `cd ${task.workspace_dir}/renderer && npx tsx ${task.workspace_dir}/${SCRIPTS.record} ` +
          `--mode full --fixtures ${task.workspace_dir}/${task.fixtures_dir} ` +
          `--slides ${ids} --title "${task.presentation_title}" ` +
          `--out ${task.scratch_dir}/thumbnails || true`
        ),
        (taskResult) => {
          // Best-effort: write the sxs-meta.json provenance sidecar into the
          // rating-server resultsDir (= <scratch>/thumbnails) so every SxS card
          // shows the original HTML link, the presentation URL (read from the
          // structured manifest.json the upload wrote — not scraped from stdout),
          // the original annotation, and the original comment. A throw here must
          // not lose an already-PASSED fix → writeSxsMeta swallows its own errors.
          writeSxsMeta(`${task.scratch_dir}/thumbnails`, task.slides);
          return taskResult;
        },
      );
  };

  // --- outer parallel fork, opus all the way --------------------------------
  // parallelFork spawns independent child sessions per task; explicit
  // fork()/compact() on the outer session isn't needed — the scaffolding
  // root carries no real prior conversation, and compact() would just
  // strip its (empty) context.
  return args.session.parallelFork(args.tasks, (child, task) =>
    child
      // Point this task's whole chain (worker model `send`s + record/diff
      // shells) at its OWN git worktree, not the scaffolding's main repo.
      // Without this the worker's codex/claude --cd is the main checkout, so
      // its edits never land in the worktree and record-after sees no change
      // ("UNSOLVED: no structural differences").
      .switchCwd(task.workspace_dir)
      .try<Result<TaskResult>>(
        (s) => s.tryMultipleTimes<TaskResult>(
          task.retry_budget,
          (s2) => runTask(s2, task),
        ),
        // Don't cancel sibling tasks when one task fails outright.
        (s, e) => s.materializeError(describeError(e)),
      ),
  );
}

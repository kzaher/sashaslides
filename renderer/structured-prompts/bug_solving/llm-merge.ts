/**
 * llm-merge.ts — the 3-way-merge-FIRST, LLM-verified merge engine for bug_solving.
 *
 * Folds the converter fixes from every GREEN (user-approved) fork into one
 * accepted working tree using the generic copy-on-write workspace library
 * (`cow-workspace.ts`).
 *
 * ## Default is a MECHANICAL 3-way merge — the LLM only edits + verifies
 *
 * The old design asked the model to REGENERATE the whole merged file ("return
 * ONLY the merged contents"). For a ~5k-line converter the model cannot reproduce
 * every line verbatim, so it drifted globally → the render of EVERY slide changed
 * → the gate correctly rejected the merge (and each call cost ~$15 / ~9 min).
 *
 * The fix: DON'T regenerate. Per file we do a real `git merge-file --diff3` 3-way
 * merge of the fork versions onto the base (`mergeThree`/`mergeN`). Non-conflicting
 * hunks — the common case, since independent bug fixes touch different regions —
 * are applied BYTE-EXACTLY, so untargeted slides render identically and the gate
 * passes. Only when two fixes touch the SAME region does git leave diff3 conflict
 * markers; then, and only then, does the model have real work.
 *
 * The model is invoked AGENTICALLY (it edits the file on disk with its own tools):
 * we write the 3-way result into the merge workspace's upper layer, write the base
 * / each fork's full file / each fork's unified diff-vs-base to a scratch dir, and
 * hand the model their PATHS (`mergeEditPrompt`) — NOT their inline contents. It is
 * told to EDIT the merged file in place: resolve any conflict markers (the prompt
 * explains diff3 marker anatomy) and verify each fix is intact, making the MINIMAL
 * edits (never a reformat/rewrite — that would re-introduce the global drift). A
 * clean 3-way merge means the model makes no edits at all. After the send we read
 * the (possibly edited) file back out of the upper.
 *
 * Every decision about WHICH files need merging, WHEN to retest, promote/demote,
 * and the all-at-once → sequential fallback is PLAIN CODE in this module.
 *
 * ## Flow (plain code)
 *
 *   1. Collect, per changed converter file, the set of fork versions: `base` =
 *      the real working tree, plus each green fork's version (read straight from
 *      its COW upper layer). A file changed by only ONE fork has no conflict → we
 *      take that fork's version verbatim, NO merge, NO LLM.
 *   2. ALL-AT-ONCE: one merge COW workspace over the repo. For each MULTI-fork
 *      file: `mergeN` 3-way-merges the forks → write into the workspace upper →
 *      ONE agentic `mergeEditPrompt` send (the model resolves/verifies the file in
 *      place) → read it back. Single-fork files: write their version directly.
 *      Then `ops.retest(mergeWs, allIntendedSlides)`.
 *   3. Retest clean (nothing OUTSIDE the intended slide set changed) →
 *      `mergeWs.promote(mergedFiles)` copies the merged files onto the REAL tree
 *      (the user commits). Report accepted. Done.
 *   4. Retest ripples (or a merge send failed) → SEQUENTIAL fallback: a fresh
 *      merge workspace; fold forks one at a time. For each fork, for each of its
 *      files, 3-way-merge that fork's version into the CURRENT accepted file (which
 *      already includes the forks folded before it — the target MUTATES), let the
 *      model edit/verify it, read back, `ops.retest`. Keep the fork if clean;
 *      otherwise roll its writes back to the pre-fork accepted content and
 *      `ops.demote(slides, task, reason)`. Promote the final accepted set.
 *
 * ## Testability seam (`ops`)
 *
 * The only side-effects the orchestration performs beyond the workspace fs are
 * `retest` / `promote` / `demote`, bundled on an injectable `MergeOps`. Tests
 * mock ONLY the LLM (via MockIO) + the recording; the workspace, filesystem, git
 * 3-way merge, and ledger run for real. The LLM mock stands in for the model's
 * agentic edit — it reads EDIT_TARGET from the prompt and resolves markers on
 * disk. Production wires `realLlmMergeOps(...)`.
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session, SessionWithResult } from "../../../structured-prompting/src/index.js";
import {
  createCowWorkspace,
  cleanupCowWorkspace,
  type CowWorkspace,
} from "../../../cow-workspace/cow-workspace.js";
import { makeRegressionRetest } from "./regression-gate.js";
import {
  type RenderRecord,
  type StabilityClassification,
  STABILITY_JSON,
  loadStability,
  extractSlideXml,
  extractRenderedPartsHash,
} from "./stability.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A GREEN (already user-approved) cluster to fold. Its converter change lives
 *  in its COW fork's upper layer, addressed by `branch_id`. */
export interface GreenCluster {
  /** stable task slug, e.g. "clipping-curves". */
  task: string;
  /** the fork's COW workspace id (= Task.branch_id). Its upper layer holds the
   *  fork's changed converter files. */
  branch_id: string;
  /** the cluster's own targeted (already-approved) slides. Changes to THESE are
   *  intended; a change to any OTHER slide is a ripple regression. */
  slides: string[];
  /** ABSOLUTE path to the fork's shared dir (`/overlays/shared/<run>/<task>`)
   *  holding its rating-outcome.json. Reaped ONLY when this cluster is
   *  successfully merged + promoted (cleanup-on-success). Optional — when unset,
   *  only the solve overlay is reaped. */
  shared_dir?: string;
}

/**
 * Cleanup-ON-SUCCESS: a green cluster whose fix has been merged + promoted onto
 * the REAL working tree no longer needs its solve overlay — reap it (and its
 * shared dir). A demoted/rejected cluster is NEVER passed here: its overlay is
 * LEFT on disk so it can be inspected / re-merged. Best-effort + never-throws.
 */
function reapAcceptedCluster(cluster: GreenCluster, upperRoot?: string): void {
  try { cleanupCowWorkspace(cluster.branch_id, upperRoot); } catch { /* best-effort */ }
  if (cluster.shared_dir) {
    try { rmSync(cluster.shared_dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/** The final report. */
export interface MergeReport {
  /** how the merge landed. */
  mode: "all-at-once" | "sequential" | "noop";
  /** task slugs whose fix was folded into the promoted tree. */
  accepted: string[];
  /** clusters dropped during the sequential fallback (rippled / could not fold).
   *  `demotedSlides` = the slide ids fed back to the ledger for re-solve. */
  rejected: Array<{ task: string; reason: string; demotedSlides: string[] }>;
  /** repo-relative converter files written onto the real tree by the promote. */
  mergedFiles: string[];
}

/** The (small) injectable side-effect surface. */
export interface MergeOps {
  /** Render the deck at the workspace's CURRENT state and structural-diff it
   *  against the base tree; return the slide ids that CHANGED. A merge is clean
   *  iff every changed slide is in `intendedSlides`. */
  retest(ws: CowWorkspace, intendedSlides: string[]): { changed: string[] };
  /** Copy the given merged files from the workspace upper onto the base tree. */
  promote(ws: CowWorkspace, files: string[]): void;
  /** Feed a dropped cluster's slides back to the ledger for re-solve. Must be
   *  idempotent + non-throwing. */
  demote(slides: string[], task: string, reason: string): void;
}

export interface LlmMergeArgs {
  /** repo root (the base tree every workspace overlays + promotes onto). */
  repo: string;
  /** the GREEN clusters to fold, each addressing its fork by branch_id. */
  greenClusters: GreenCluster[];
  /** injectable side-effects. Default `realLlmMergeOps({ repo, fixturesDir })`. */
  ops?: MergeOps;
  /** predicate for which changed files are converter files the merge folds.
   *  Default: top-level `renderer/html2slides/*.ts`. */
  converterFilter?: (rel: string) => boolean;
  /** ext4 root for the merge workspaces. Default cow-workspace's own default. */
  upperRoot?: string;
}

// ---------------------------------------------------------------------------
// The minimal LLM prompt
// ---------------------------------------------------------------------------

const PROPOSAL_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];

/** A fork's fix for one file: its owning task + its full file content. */
interface ForkVersion { task: string; content: string; }

// ── The mechanical 3-way merge (git merge-file --diff3) — the DEFAULT ────────

/**
 * One `git merge-file --diff3` 3-way merge: fold `other`'s (base→other) change
 * into `cur`, using `base` as the common ancestor. Non-overlapping hunks are
 * applied byte-exactly; an overlapping change is left as a diff3 conflict block
 * (`<<<<<<< / ||||||| / ======= / >>>>>>>`). NEVER throws — on a git spawn error
 * it returns `cur` flagged conflicted so the LLM pass is forced to look.
 */
export function mergeThree(base: string, cur: string, other: string, labels: { cur: string; base: string; other: string }): { content: string; conflicted: boolean } {
  if (cur === other) return { content: cur, conflicted: false };
  if (base === cur) return { content: other, conflicted: false };   // cur unchanged → take other's diff verbatim
  if (base === other) return { content: cur, conflicted: false };   // other unchanged → keep cur
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "sp-3way-"));
    const curF = join(dir, "cur"), baseF = join(dir, "base"), otherF = join(dir, "other");
    writeFileSync(curF, cur); writeFileSync(baseF, base); writeFileSync(otherF, other);
    const r = spawnSync("git", ["merge-file", "-p", "--diff3", "-L", labels.cur, "-L", labels.base, "-L", labels.other, curF, baseF, otherF], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    // status: 0 clean, >0 conflict count, null on spawn failure.
    if (r.status == null || typeof r.stdout !== "string") return { content: cur, conflicted: true };
    return { content: r.stdout, conflicted: /^<<<<<<< /m.test(r.stdout) };
  } catch {
    return { content: cur, conflicted: true };
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
  }
}

/**
 * Fold N fork versions onto `base` by iterating `mergeThree` (base is the shared
 * ancestor at every step). Returns the combined content + whether ANY conflict
 * markers remain. One fork → its content verbatim (no merge).
 */
export function mergeN(base: string, forks: ForkVersion[]): { content: string; conflicted: boolean } {
  if (forks.length === 0) return { content: base, conflicted: false };
  let cur = forks[0].content;
  let conflicted = false;
  for (let i = 1; i < forks.length; i++) {
    const r = mergeThree(base, cur, forks[i].content, {
      cur: i === 1 ? `fix: ${forks[0].task}` : "merged so far",
      base: "base",
      other: `fix: ${forks[i].task}`,
    });
    cur = r.content;
    conflicted = conflicted || r.conflicted;
  }
  return { content: cur, conflicted };
}

/** Unified diff of `other` vs `base` (via coreutils `diff -u`, so it scales to
 *  large source files). Returns a friendly note when identical / on error —
 *  never throws (a merge must not die on a diff). */
function diffVsBase(base: string, other: string, label: string): string {
  if (base === other) return "(identical to base — this fork changed nothing in this file)";
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "sp-mdiff-"));
    const baseF = join(dir, "base"), otherF = join(dir, "other");
    writeFileSync(baseF, base);
    writeFileSync(otherF, other);
    try {
      // diff exits 0 when identical (handled above), 1 when they differ (throws
      // with the diff on .stdout), ≥2 on a real error.
      execSync(`diff -u --label base --label ${JSON.stringify(label)} ${JSON.stringify(baseF)} ${JSON.stringify(otherF)}`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return "(identical to base)";
    } catch (e) {
      const err = e as { status?: number; stdout?: string; message?: string };
      if (err.status === 1 && typeof err.stdout === "string") return err.stdout.replace(/\n+$/, "");
      return `(diff unavailable: ${err.message ?? "error"})`;
    }
  } catch (e) {
    return `(diff unavailable: ${(e as Error).message})`;
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
  }
}

// ── The agentic edit-and-verify prompt (PATHS, not inline contents) ──────────

/** Absolute paths to the reference material the model reads to review a merge. */
interface MergeInputPaths {
  basePath: string;
  forks: Array<{ label: string; task: string; fullPath: string; diffPath: string }>;
}

/**
 * Write the reference material the model reads to REVIEW a merge — the base
 * version, and each fork's FULL file + its unified diff vs base — into `dir`,
 * returning their absolute paths. (The merged file the model EDITS lives in the
 * workspace upper, addressed separately as EDIT_TARGET.)
 */
function writeMergeInputs(dir: string, rel: string, base: string, forks: ForkVersion[]): MergeInputPaths {
  mkdirSync(dir, { recursive: true });
  const flat = rel.replace(/\//g, "__");
  const basePath = join(dir, `base--${flat}`);
  writeFileSync(basePath, base);
  const out = forks.map((f, i) => {
    const label = PROPOSAL_LABELS[i] ?? String(i + 1);
    const fullPath = join(dir, `fix-${label}-${f.task}--${flat}`);
    const diffPath = join(dir, `fix-${label}-${f.task}--${flat}.diff`);
    writeFileSync(fullPath, f.content);
    writeFileSync(diffPath, diffVsBase(base, f.content, `fix-${f.task}`));
    return { label, task: f.task, fullPath, diffPath };
  });
  return { basePath, forks: out };
}

/**
 * The agentic edit-and-verify prompt. The model gets FILE PATHS (not inline
 * contents) and edits the already-3-way-merged file IN PLACE with its tools —
 * never regenerating it. Explains diff3 conflict-marker anatomy. Exported so
 * tests can assert what the model was told.
 */
export function mergeEditPrompt(opts: { rel: string; editTarget: string; inputs: MergeInputPaths; conflicted: boolean }): string {
  const { rel, editTarget, inputs, conflicted } = opts;
  const n = inputs.forks.length;
  const lines: string[] = [];
  lines.push(`You are integrating ${n} independent, already-approved bug fix(es) into a single copy of \`${rel}\`.`);
  lines.push("");
  lines.push("A 3-way merge has ALREADY been produced for you. EDIT THAT FILE IN PLACE using your Read + Edit tools — do NOT print it, do NOT regenerate it:");
  lines.push(`  EDIT_TARGET: ${editTarget}`);
  lines.push("");
  lines.push("Reference material (read as needed; do NOT edit these):");
  lines.push(`  base (the common ancestor both fixes started from): ${inputs.basePath}`);
  for (const f of inputs.forks) {
    lines.push(`  fix ${f.label} [${f.task}] — full file:            ${f.fullPath}`);
    lines.push(`  fix ${f.label} [${f.task}] — unified diff vs base: ${f.diffPath}`);
  }
  lines.push("");
  if (conflicted) {
    lines.push("The merged file CONTAINS CONFLICT MARKERS: two fixes changed the same region and git could not combine them. A diff3 conflict block looks EXACTLY like this:");
    lines.push("");
    lines.push("    <<<<<<< <label of one side>");
    lines.push("        ...lines from ONE fix...");
    lines.push("    ||||||| base");
    lines.push("        ...the ORIGINAL base lines both fixes diverged from...");
    lines.push("    =======");
    lines.push("        ...lines from the OTHER fix...");
    lines.push("    >>>>>>> <label of the other side>");
    lines.push("");
    lines.push("Resolve EVERY such block by writing the code that preserves BOTH fixes' intent (reconcile the two sides using the base section and each fix's diff to see what each was doing — usually you keep both changes), then DELETE all four marker lines (<<<<<<<, |||||||, =======, >>>>>>>).");
  } else {
    lines.push("The 3-way merge was CLEAN (no conflict markers). Your job is only to VERIFY: confirm each fix's change (per its diff) is present and correct and the file is valid TypeScript. If it is already correct — which is expected for a clean merge — make NO edits at all.");
  }
  lines.push("");
  lines.push("Rules:");
  lines.push("- Make the MINIMAL edits necessary. Do NOT reformat, reorder, or rewrite unrelated code — any incidental change re-renders other slides and fails the merge gate.");
  lines.push("- When you finish there must be ZERO conflict markers left in the file.");
  lines.push("- Your text reply is ignored; the ONLY thing that matters is the edited file on disk.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Default converter-file filter
// ---------------------------------------------------------------------------

/** Top-level `renderer/html2slides/*.ts` — the converter payload the worker
 *  edits (convert-pptx.ts / extract-dom.ts / …). */
export function defaultConverterFilter(rel: string): boolean {
  return /^renderer\/html2slides\/[^/]+\.ts$/.test(rel);
}

// ---------------------------------------------------------------------------
// Small graph helper (a real, monitor-visible no-op node carrying a value)
// ---------------------------------------------------------------------------

function installValue<T>(session: Session, value: T): SessionWithResult<T> {
  return session
    .executeShell(() => `echo llm-merge:value`)
    .combineWith<string, T>(
      (branch) => branch.executeShell(() => `echo llm-merge:leaf`),
      () => value,
    );
}

/** shell-quote a path for an echo marker. */
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

// ---------------------------------------------------------------------------
// The merge graph
// ---------------------------------------------------------------------------

/** Sentinel: the all-at-once merge rippled → route to the sequential fallback. */
class AllAtOnceRippled extends Error {
  constructor(public readonly ripple: string[]) {
    super(`all-at-once merge rippled to non-intended slides [${ripple.join(", ")}]`);
    this.name = "AllAtOnceRippled";
  }
}

/**
 * Build the LLM merge graph. Call this at EXEC time (the green forks' upper
 * layers must already be populated) — bug_solving invokes it from inside
 * `finalMergePhase`'s pipe body, after the parallelFork barrier.
 */
export function llmMerge(session: Session, args: LlmMergeArgs): SessionWithResult<MergeReport> {
  const repo = args.repo;
  const green = args.greenClusters;
  const isConverter = args.converterFilter ?? defaultConverterFilter;
  const ops = args.ops ?? realLlmMergeOps({ repo });

  const report: MergeReport = { mode: "noop", accepted: [], rejected: [], mergedFiles: [] };

  // ── (1) Collect fork versions per changed converter file (synchronous) ──────
  // A bug_solving fork already IS a CowWorkspace over the repo; its changed
  // converter files live in its upper, readable via a handle over its branch id.
  const forkHandles = green.map((g) => ({
    cluster: g,
    ws: createCowWorkspace({ base: repo, id: g.branch_id, upperRoot: args.upperRoot }),
  }));
  // file (repo-relative) → [{ cluster, content }]
  const fileForks = new Map<string, Array<{ cluster: GreenCluster; content: string }>>();
  for (const { cluster, ws } of forkHandles) {
    for (const rel of ws.changed().filter(isConverter)) {
      const content = ws.readUpperFile(rel);
      if (content == null) continue;
      if (!fileForks.has(rel)) fileForks.set(rel, []);
      fileForks.get(rel)!.push({ cluster, content });
    }
  }

  const baseContent = (rel: string): string => {
    try { return readFileSync(join(repo, rel), "utf8"); } catch { return ""; }
  };

  const allFiles = [...fileForks.keys()].sort();
  const multiForkFiles = allFiles.filter((f) => fileForks.get(f)!.length > 1);
  const singleForkFiles = allFiles.filter((f) => fileForks.get(f)!.length === 1);
  const allIntendedSlides = [...new Set(green.flatMap((g) => g.slides))].sort();
  const intendedSet = new Set(allIntendedSlides);

  // Nothing to merge (no green forks, or none touched a converter file).
  if (allFiles.length === 0) {
    return installValue(session, report);
  }

  // ── (2) ALL-AT-ONCE, wrapped in a try that falls back to SEQUENTIAL ─────────
  const allWs = createCowWorkspace({ base: repo, id: `llm-merge-all-${process.pid}-${Date.now()}`, upperRoot: args.upperRoot });
  const allState = { merged: {} as Record<string, string> };

  return session.try<MergeReport>(
    (s) => {
      // Per multi-fork file: 3-way merge → write the result into the merge
      // workspace upper → ONE agentic edit/verify send (the model resolves any
      // conflict markers + verifies in place) → read it back. The file set is
      // known now (forks are done), so the chain shape is fixed.
      const inputsRoot = mkdtempSync(join(tmpdir(), "sp-merge-inputs-all-"));
      let chain: SessionWithResult<unknown> = installValue(s, "all-at-once:start");
      for (const rel of multiForkFiles) {
        chain = chain.pipe((sc) => {
          const forks: ForkVersion[] = fileForks.get(rel)!.map((f) => ({ task: f.cluster.task, content: f.content }));
          const bc = baseContent(rel);
          const { content: merged, conflicted } = mergeN(bc, forks);
          allWs.writeUpperFile(rel, merged);                       // 3-way result → upper (the model edits it in place)
          const editTarget = join(allWs.upperDir(), rel);
          const inputs = writeMergeInputs(join(inputsRoot, rel.replace(/\//g, "__")), rel, bc, forks);
          // The model edits the ABSOLUTE editTarget (an overlay-upper path) with
          // its tools — no switchCwd (a sticky cwd into a to-be-deleted overlay
          // would leave later nodes spawning in a vanished dir → setpriv ENOENT).
          return sc
            .send({ prompt: mergeEditPrompt({ rel, editTarget, inputs, conflicted }) })
            .combineWith<string, string>(
              (b) => b.executeShell(() => `echo llm-merge:all-edited ${shq(rel)} conflicted=${conflicted}`),
              () => { allState.merged[rel] = allWs.readUpperFile(rel) ?? merged; return allState.merged[rel]; },
            );
        });
      }

      // Write the single-fork files verbatim + retest ONCE; stash the ripple set
      // on allState so the following assert can throw on it (a throw routes the
      // try to the sequential fallback). Multi-fork files are already written +
      // model-edited in the upper by the loop above.
      const allRipple: { set: string[] } = { set: [] };
      const retested = chain.pipe((sc) =>
        sc.executeShell(() => {
          for (const rel of singleForkFiles) allWs.writeUpperFile(rel, fileForks.get(rel)![0].content);
          const { changed } = ops.retest(allWs, allIntendedSlides);
          allRipple.set = changed.filter((sid) => !intendedSet.has(sid));
          return `echo llm-merge:all-retest changed=[${changed.join(",")}] ripple=[${allRipple.set.join(",")}]`;
        }),
      );

      return retested
        .assert(() => {
          if (allRipple.set.length > 0) throw new AllAtOnceRippled(allRipple.set);
        })
        .executeShell(() => {
          // Clean: promote the merged set onto the real tree.
          const files = [...multiForkFiles, ...singleForkFiles];
          ops.promote(allWs, files);
          report.mode = "all-at-once";
          report.accepted = green.map((g) => g.task);
          report.mergedFiles = files;
          try { allWs.cleanup(); } catch { /* best-effort */ }
          // Cleanup-ON-SUCCESS: every green cluster was promoted → reap each
          // cluster's solve overlay + shared dir (the throwaway merge ws above).
          for (const g of green) reapAcceptedCluster(g, args.upperRoot);
          return `echo llm-merge:all-promoted [${files.join(",")}]`;
        })
        .pipe((sp) => installValue(sp, report));
    },
    // Fallback: all-at-once failed (ripple or a merge send error) → SEQUENTIAL.
    (s) => {
      try { allWs.cleanup(); } catch { /* */ }
      return sequentialFold(s, {
        repo, green, fileForks, baseContent, intendedSet, allIntendedSlides, ops, report, upperRoot: args.upperRoot,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Sequential fallback — fold one fork at a time; the target file MUTATES.
// ---------------------------------------------------------------------------

interface SeqCtx {
  repo: string;
  green: GreenCluster[];
  fileForks: Map<string, Array<{ cluster: GreenCluster; content: string }>>;
  baseContent: (rel: string) => string;
  intendedSet: Set<string>;
  allIntendedSlides: string[];
  ops: MergeOps;
  report: MergeReport;
  upperRoot?: string;
}

function sequentialFold(session: Session, ctx: SeqCtx): SessionWithResult<MergeReport> {
  const { green, fileForks, baseContent, ops, report } = ctx;
  report.mode = "sequential";

  const seqWs = createCowWorkspace({ base: ctx.repo, id: `llm-merge-seq-${process.pid}-${Date.now()}`, upperRoot: ctx.upperRoot });
  const seqInputsRoot = mkdtempSync(join(tmpdir(), "sp-merge-inputs-seq-"));

  // The CURRENT accepted contents per file (starts empty = base; mutates as
  // forks fold in). `keptFiles` = files owned by a kept fork (what we promote).
  const accepted: Record<string, string> = {};
  const keptFiles = new Set<string>();
  // Clusters kept (clean) — reaped ONLY after the final promote (cleanup-on-
  // success). Rejected clusters are demoted + LEFT for inspection/re-merge.
  const keptClusters: GreenCluster[] = [];

  // Which files each fork changed (rel → this fork's version), computed now.
  const forkFilesOf = (cluster: GreenCluster): Array<{ rel: string; content: string }> => {
    const out: Array<{ rel: string; content: string }> = [];
    for (const [rel, forks] of fileForks) {
      const mine = forks.find((f) => f.cluster.task === cluster.task);
      if (mine) out.push({ rel, content: mine.content });
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  };

  const cur = (rel: string): string => (rel in accepted ? accepted[rel] : baseContent(rel));

  let chain: SessionWithResult<unknown> = installValue(session, "sequential:start");

  for (const cluster of green) {
    const forkFiles = forkFilesOf(cluster);
    const perForkState = { pre: {} as Record<string, string>, ripple: [] as string[] };

    // Snapshot the pre-fork accepted content for rollback.
    chain = chain.pipe((sc) =>
      sc.executeShell(() => {
        perForkState.pre = {};
        for (const { rel } of forkFiles) perForkState.pre[rel] = cur(rel);
        return `echo llm-merge:seq-begin ${cluster.task}`;
      }),
    );

    // Per file: 3-way merge THIS fork's version into the CURRENT accepted content
    // (original base as the shared ancestor) → write into the seq workspace upper
    // → one agentic edit/verify send → read it back. Doing this INSIDE the pipe
    // body captures the exec-time accepted state, so a later fork folds onto the
    // forks kept before it (the target MUTATES).
    for (const { rel, content } of forkFiles) {
      chain = chain.pipe((sc) => {
        const current = cur(rel);            // includes prior folded forks
        const bc = baseContent(rel);
        const { content: merged, conflicted } = mergeThree(bc, current, content, { cur: "merged so far", base: "base", other: `fix: ${cluster.task}` });
        seqWs.writeUpperFile(rel, merged);
        const editTarget = join(seqWs.upperDir(), rel);
        const inputs = writeMergeInputs(join(seqInputsRoot, `${cluster.task}--${rel.replace(/\//g, "__")}`), rel, bc, [{ task: cluster.task, content }]);
        return sc
          .send({ prompt: mergeEditPrompt({ rel, editTarget, inputs, conflicted }) })
          .combineWith<string, string>(
            (b) => b.executeShell(() => `echo llm-merge:seq-edited ${cluster.task} ${shq(rel)} conflicted=${conflicted}`),
            () => {
              accepted[rel] = seqWs.readUpperFile(rel) ?? merged;
              return accepted[rel];
            },
          );
      });
    }

    // Retest at the post-fold state. SCOPE the stability-checked ("green") set to
    // the greens IN PLAY at THIS fold: the ALREADY-KEPT forks (they must not
    // regress — a kept green is now the reference) PLUS this fork (it must keep
    // its own stability). NOT-yet-folded forks are deliberately EXCLUDED — their
    // slides sit at base (unfixed) here, so checking them against their fixed LGTM
    // would falsely fail this fork and couple every fork's fate to every other's.
    // With this scoping the fold CONTINUES past a fork that fails to keep
    // stability, keeping each fork that does.
    chain = chain.pipe((sc) =>
      sc.executeShell(() => {
        const greenInPlay = [...new Set([...keptClusters.flatMap((c) => c.slides), ...cluster.slides])];
        const greenSet = new Set(greenInPlay);
        const { changed } = ops.retest(seqWs, greenInPlay);
        perForkState.ripple = changed.filter((sid) => !greenSet.has(sid));
        return `echo llm-merge:seq-retest ${cluster.task} green=[${greenInPlay.join(",")}] changed=[${changed.join(",")}]`;
      }),
    );

    // Keep (clean) or roll back + demote (rippled).
    chain = chain.pipe((sc) =>
      sc.executeShell(() => {
        if (perForkState.ripple.length === 0) {
          report.accepted.push(cluster.task);
          keptClusters.push(cluster);
          for (const { rel } of forkFiles) keptFiles.add(rel);
          return `echo llm-merge:seq-keep ${cluster.task}`;
        }
        // Roll each of this fork's files back to the pre-fork accepted content.
        for (const { rel } of forkFiles) {
          accepted[rel] = perForkState.pre[rel];
          seqWs.writeUpperFile(rel, perForkState.pre[rel]);
        }
        const reason = `rippled to non-intended slide(s) [${perForkState.ripple.join(", ")}]`;
        report.rejected.push({ task: cluster.task, reason, demotedSlides: cluster.slides });
        try { ops.demote(cluster.slides, cluster.task, reason); } catch { /* non-fatal */ }
        return `echo llm-merge:seq-rollback ${cluster.task}`;
      }),
    );
  }

  // Promote the final accepted set (files owned by kept forks).
  chain = chain.pipe((sc) =>
    sc.executeShell(() => {
      const files = [...keptFiles].sort();
      for (const rel of files) seqWs.writeUpperFile(rel, accepted[rel]);
      if (files.length) ops.promote(seqWs, files);
      report.mergedFiles = files;
      try { seqWs.cleanup(); } catch { /* best-effort */ }
      // Cleanup-ON-SUCCESS: reap the kept clusters' solve overlays + shared dirs
      // now that their fix is promoted. Rejected clusters were left untouched.
      for (const g of keptClusters) reapAcceptedCluster(g, ctx.upperRoot);
      return `echo llm-merge:seq-promoted [${files.join(",")}]`;
    }),
  );

  return chain.pipe((sc) => installValue(sc, report));
}

// ---------------------------------------------------------------------------
// realLlmMergeOps — production wiring (render+diff retest, promote, ledger demote)
// ---------------------------------------------------------------------------

export interface RealLlmMergeOpsDeps {
  repo: string;
  /** fixture deck dir (absolute). Default renderer/html2slides/e2e/fixtures. */
  fixturesDir?: string;
  /** persistent per-slide ledger dir the NEXT clustering round reads. Default
   *  `<repo>/.bug-solving-history`. */
  historyDir?: string;
  /** stability.json the 3× classifier wrote at solve start. Default STABILITY_JSON
   *  (`/overlays/shared/stability.json`). Missing → every slide treated xml-stable. */
  stabilityPath?: string;
  /** SxS results dir whose `thumbs/`|`slides/` hold the user-approved (LGTM'd)
   *  renders. When a green slide's LGTM render isn't on disk, the gate falls back
   *  to that slide's PRE-MERGE (base) render. Default: BUG_SOLVING_SXS_DIR env. */
  sxsDir?: string;
  /** render timeout per whole-deck record (ms). Default 20 min. */
  timeoutMs?: number;
  /** TEST SEAM — override the Google-Slides recording (record-rendering --mode
   *  full). Production leaves this UNSET (real render). Injecting it lets the FULL
   *  merge run E2E without Google: real gate, real overlays, real promote, real
   *  ledger demote — the ONLY mocked pieces become the LLM (via MockIO) and this
   *  recording. When set, its functions REPLACE the three record-rendering
   *  shell-outs; everything else (deckIds, stability load, promote, demote) is
   *  unchanged and real. */
  render?: MergeRenderSeam;
}

/** The three render points realLlmMergeOps feeds to the regression gate. In
 *  production each shells `record-rendering --mode full` (Google upload + thumb
 *  scrape); a test injects deterministic RenderRecords instead. */
export interface MergeRenderSeam {
  /** pre-merge (base tree) render of a slide. */
  baseRecord(slideId: string): RenderRecord;
  /** user-approved (LGTM) render of a green slide. */
  lgtmRecord(slideId: string): RenderRecord;
  /** render the merged deck INSIDE a workspace overlay → per-slide lookup. */
  renderMergeDeck(ws: CowWorkspace): (slideId: string) => RenderRecord;
}

const REC_REL = "renderer/structured-prompts/bug_solving/scripts/record-rendering.ts";

/**
 * Build the in-overlay merge-render command + the HOST path its output lands at.
 * Exported so a test can pin the two path-handshake invariants that silently
 * broke every merge (empty renders → total ripple):
 *   1. NO doubled `renderer/`: the command `cd renderer` first, so the script
 *      path must be relative to `renderer/` — REC_REL's leading `renderer/` is
 *      stripped (else `renderer/renderer/...` → ERR_MODULE_NOT_FOUND).
 *   2. Output is written to `../<outRel>` — i.e. the overlay's repo root — which
 *      copies-up into the overlay UPPER, so it's HOST-visible at
 *      `<upperDir>/<outRel>`, which is exactly where we read it. (Writing to an
 *      absolute /tmp path from inside the overlay lands in the namespace-local
 *      tree that is torn down when runShell returns → nothing to read.)
 */
export function mergeRenderCommand(
  ws: CowWorkspace,
  opts: { recRel: string; fixturesDir: string; slidesCsv: string; outRel: string; title: string; mode?: string },
): { cmd: string; outDir: string } {
  const recFromRenderer = opts.recRel.replace(/^renderer\//, "");
  const mode = opts.mode ?? "full";
  const cmd =
    `cd renderer && RECORD_CONCURRENCY=1 npx tsx ${JSON.stringify(recFromRenderer)} ` +
    `--mode ${mode} --fixtures ${JSON.stringify(opts.fixturesDir)} --slides ${JSON.stringify(opts.slidesCsv)} ` +
    `--title ${JSON.stringify(opts.title)} --out ${JSON.stringify("../" + opts.outRel)}`;
  return { cmd, outDir: join(ws.upperDir(), opts.outRel) };
}

/** Read a single slide's render record out of a record-rendering `--out` dir:
 *  Google thumbnail (pixel), slide XML, and embedded rendered-parts hash. */
function recordFromDir(dir: string, slideId: string): RenderRecord {
  const png = join(dir, "thumbs", `${slideId}.png`);
  const pptx = join(dir, "pptx", `${slideId}.pptx`);
  const rec: RenderRecord = {};
  if (existsSync(png)) rec.pngPath = png;
  const xml = extractSlideXml(pptx);
  if (xml != null) rec.xml = xml;
  const parts = extractRenderedPartsHash(pptx);
  if (parts != null) rec.renderedPartsHash = parts;
  return rec;
}

/**
 * Production `MergeOps`. `retest` is the DUAL-CLASS regression gate
 * (regression-gate.ts): it renders the whole deck in the merge workspace and
 * compares GREEN slides against their LGTM'd render (pixel-identical for the
 * pixel-perfect stability class, xml+rendered-parts otherwise) and NON-TARGETED
 * slides against the accepted base (any change = ripple). It carries the accepted
 * base across sequential folds so a previously-merged fork's change isn't
 * re-flagged as the next fork's ripple. `promote` copies the merged files onto
 * the base; `demote` writes the candidates/ratings ledger.
 */
export function realLlmMergeOps(deps: RealLlmMergeOpsDeps): MergeOps {
  const repo = deps.repo;
  const fixturesDir = deps.fixturesDir ?? join(repo, "renderer/html2slides/e2e/fixtures");
  const stabilityPath = deps.stabilityPath ?? STABILITY_JSON;
  const sxsDir = deps.sxsDir ?? process.env.BUG_SOLVING_SXS_DIR;
  const timeoutMs = deps.timeoutMs ?? 20 * 60 * 1000;

  const deckIds = (): string[] =>
    readdirSync(fixturesDir)
      .filter((f) => /^slide_\d+\.html$/.test(f))
      .map((f) => f.replace(/\.html$/, ""))
      .sort();

  const scratch = join("/tmp", `llm-merge-gate-${process.pid}`);
  const csv = (): string => deckIds().join(",");

  // Base render (the pre-merge tree) is stable across a merge phase → render once.
  let baselineDir: string | null = null;
  const baseRecord = (slideId: string): RenderRecord => {
    if (baselineDir === null) {
      baselineDir = join(scratch, "baseline");
      mkdirSync(baselineDir, { recursive: true });
      execRepo(
        `cd "${join(repo, "renderer")}" && RECORD_CONCURRENCY=1 npx tsx "${join(repo, REC_REL)}" ` +
          `--mode full --fixtures "${fixturesDir}" --slides "${csv()}" --title "llm-merge-base-${Date.now()}" --out "${baselineDir}"`,
        timeoutMs,
      );
    }
    return recordFromDir(baselineDir, slideId);
  };

  // LGTM render: the user-approved thumbnail from the SxS dir if present; else
  // the pre-merge base render of that slide.
  const lgtmRecord = (slideId: string): RenderRecord => {
    if (sxsDir) {
      for (const sub of ["thumbs", "slides", "originals"]) {
        const png = join(sxsDir, sub, `${slideId}.png`);
        if (existsSync(png)) {
          const rec: RenderRecord = { pngPath: png };
          // pair with the base render's xml/parts so xml-stable class can compare.
          const b = baseRecord(slideId);
          if (b.xml != null) rec.xml = b.xml;
          if (b.renderedPartsHash != null) rec.renderedPartsHash = b.renderedPartsHash;
          return rec;
        }
      }
    }
    return baseRecord(slideId);
  };

  // Render the merged deck INSIDE the workspace overlay, once per retest call.
  let mergeSeq = 0;
  const renderMergeDeck = (ws: CowWorkspace): ((slideId: string) => RenderRecord) => {
    const { cmd, outDir } = mergeRenderCommand(ws, {
      recRel: REC_REL, fixturesDir, slidesCsv: csv(), outRel: `.gate-render-${mergeSeq++}`, title: `llm-merge-post-${Date.now()}`,
    });
    const r = ws.runShell(cmd);
    // Non-fatal but loud: an empty render means the gate compares base against
    // NOTHING and rips every slide. This is exactly the bug that silently made
    // every merge fail — surface it instead of returning empty records.
    if (r.code !== 0 || !existsSync(join(outDir, "pptx"))) {
      console.error(`[llm-merge] merge render produced NO output (exit ${r.code}); read dir=${outDir}\n${(r.stderr || "").split("\n").slice(-8).join("\n")}`);
    }
    return (slideId: string) => recordFromDir(outDir, slideId);
  };

  const loadStabilityOrFallback = (): StabilityClassification => {
    const s = loadStability(stabilityPath);
    if (s) return s;
    // Degrade: no stability.json → treat the whole deck as xml-stable (the weaker
    // gate) so a missing classifier never over-fails a merge.
    const ids = deckIds();
    return { pixelPerfect: [], xmlStable: ids, unstable: [], warning: `[stability] no ${stabilityPath} — defaulting all ${ids.length} slide(s) to xml-stable`, attempts: 0 };
  };

  // The render seam (Google recording) is the ONLY injectable-for-tests point;
  // when unset, the real record-rendering shell-outs above are used.
  const seam = deps.render;
  const retest = makeRegressionRetest({
    loadStability: loadStabilityOrFallback,
    renderMergeDeck: seam?.renderMergeDeck ?? renderMergeDeck,
    baseRecord: seam?.baseRecord ?? baseRecord,
    lgtmRecord: seam?.lgtmRecord ?? lgtmRecord,
    log: (m) => console.error(m),
  });

  return {
    retest(ws, intendedSlides) {
      if (deckIds().length === 0) return { changed: [] };
      return retest(ws, intendedSlides);
    },
    promote(ws, files) {
      ws.promote(files);
    },
    demote(slides, task, reason) {
      ledgerDemote(deps.historyDir ?? join(repo, ".bug-solving-history"), slides, task, reason);
    },
  };
}

function execRepo(cmd: string, timeoutMs = 20 * 60 * 1000): void {
  execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
}

// ---------------------------------------------------------------------------
// ledgerDemote — feed a dropped cluster's slides back for re-solve.
// ---------------------------------------------------------------------------

/**
 * Mark a dropped cluster's slides as a loss the NEXT clustering round re-solves.
 * Idempotent + NON-throwing (a demote failure must never crash the merge).
 *   - candidates.json: flip each slide to status:"bad" (the green-gate the next
 *     round reads) with the merge-failure meta.
 *   - ratings.json: annotate the issue (WITHOUT clobbering the user's comment).
 * Ported verbatim from the removed merge-phase.ts `demoteForResolve`.
 */
export function ledgerDemote(historyDir: string, slides: string[], cluster: string, reason: string): void {
  if (!slides.length) return;
  const now = new Date().toISOString();
  try { mkdirSync(historyDir, { recursive: true }); } catch { /* */ }

  try {
    const candFile = join(historyDir, "candidates.json");
    const cand: Record<string, Record<string, unknown>> =
      existsSync(candFile) ? JSON.parse(readFileSync(candFile, "utf8")) : {};
    for (const sid of slides) {
      const prev = (cand[sid] as Record<string, unknown> | undefined) ?? {};
      if (prev.status === "bad" && prev.mergeFailed === true && prev.mergeFailedCluster === cluster) continue;
      cand[sid] = { ...prev, status: "bad", mergeFailed: true, mergeFailedCluster: cluster, mergeFailedReason: reason, mergeFailedAt: now };
    }
    writeFileSync(candFile, JSON.stringify(cand, null, 2));
  } catch (e) {
    console.error(`[llm-merge] ledgerDemote(candidates) best-effort failure for ${cluster}: ${(e as Error).message}`);
  }

  try {
    const ledgerFile = join(historyDir, "ratings.json");
    const ledger: Record<string, Record<string, unknown>> =
      existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) : {};
    for (const sid of slides) {
      const prev = (ledger[sid] as Record<string, unknown> | undefined) ?? {};
      if (prev.mergeFailed === true && prev.mergeFailedCluster === cluster) continue;
      ledger[sid] = { ...prev, mergeFailed: true, mergeFailedCluster: cluster, mergeFailedReason: reason, mergeFailedAt: now };
    }
    writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  } catch (e) {
    console.error(`[llm-merge] ledgerDemote(ratings) best-effort failure for ${cluster}: ${(e as Error).message}`);
  }
}

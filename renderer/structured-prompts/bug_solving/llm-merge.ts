/**
 * llm-merge.ts — the SIMPLE, LLM-performed merge engine for bug_solving.
 *
 * Replaces the old git/patcher `merge-phase.ts`. It folds the converter fixes
 * from every GREEN (user-approved) fork into one accepted working tree using the
 * generic copy-on-write workspace library (`cow-workspace.ts`) — NO git, NO
 * 3-way patcher, NO conflict markers.
 *
 * ## The LLM's role is MINIMAL
 *
 * The model is only ever asked ONE thing, per file, with no bug-solving state
 * baked in:
 *
 *     Base version of <file>:
 *     ```
 *     <base contents>
 *     ```
 *     Proposed version A:
 *     ```
 *     <fork A's contents>
 *     ```
 *     Proposed version B:
 *     ```
 *     <fork B's contents>
 *     ```
 *     Return ONLY the merged file contents that incorporates all fixes.
 *
 * That is the WHOLE prompt (`buildMergePrompt`). No conflict markers, no retest
 * instructions, no "keep both sides" protocol, no state machine. Every decision
 * about WHICH files need the LLM, WHEN to retest, whether to promote/demote, and
 * the all-at-once → sequential fallback is PLAIN CODE in this module, around the
 * `send` calls.
 *
 * ## Flow (plain code)
 *
 *   1. Collect, per changed converter file, the set of fork versions: `base` =
 *      the real working tree, plus each green fork's version (read straight from
 *      its COW upper layer). A file changed by only ONE fork has no conflict → we
 *      take that fork's version verbatim, NO LLM.
 *   2. ALL-AT-ONCE: one merge COW workspace over the repo. For each MULTI-fork
 *      file, ONE `buildMergePrompt` send → write the returned contents into the
 *      workspace upper. Single-fork files: write their version directly. Then
 *      `ops.retest(mergeWs, allIntendedSlides)`.
 *   3. Retest clean (nothing OUTSIDE the intended slide set changed) →
 *      `mergeWs.promote(mergedFiles)` copies the merged files onto the REAL tree
 *      (the user commits). Report accepted. Done.
 *   4. Retest ripples (or a merge send failed) → SEQUENTIAL fallback: a fresh
 *      merge workspace; fold forks one at a time. For each fork, for each of its
 *      files, LLM-merge that fork's version into the CURRENT accepted file (which
 *      already includes the forks folded before it — the target MUTATES), write
 *      it, `ops.retest`. Keep the fork if clean; otherwise roll its writes back
 *      to the pre-fork accepted content and `ops.demote(slides, task, reason)`.
 *      Promote the final accepted set.
 *
 * ## Testability seam (`ops`)
 *
 * The only side-effects the orchestration performs beyond the workspace fs are
 * `retest` / `promote` / `demote`, bundled on an injectable `MergeOps`. Tests
 * mock ONLY the LLM (via MockIO) + `retest`; the workspace, filesystem, and
 * ledger run for real. Production wires `realLlmMergeOps(...)`.
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { Session, SessionWithResult } from "../../../structured-prompting/src/index.js";
import {
  createCowWorkspace,
  type CowWorkspace,
} from "../../../structured-prompting/src/workspace/cow-workspace.js";

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

/**
 * The WHOLE LLM prompt: base + N proposed versions → the single merged file.
 * Deliberately carries NO bug-solving context, NO markers, NO retest/state
 * instructions. Exported so tests can assert exactly what the model saw.
 */
export function buildMergePrompt(relPath: string, base: string, proposals: string[]): string {
  const parts: string[] = [`Base version of ${relPath}:`, "```", base, "```", ""];
  proposals.forEach((p, i) => {
    parts.push(`Proposed version ${PROPOSAL_LABELS[i] ?? String(i + 1)}:`, "```", p, "```", "");
  });
  parts.push("Return ONLY the merged file contents that incorporates all fixes. No explanation, no code fences.");
  return parts.join("\n");
}

/** Strip a single wrapping ``` fence (with optional language tag) if the model
 *  ignored "no code fences". Leaves fence-free content untouched. */
function stripFence(s: string): string {
  const m = s.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  return m ? m[1] : s;
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
      // One minimal send per multi-fork file. The file set is known now
      // (forks are done), so the chain shape is fixed.
      let chain: SessionWithResult<unknown> = installValue(s, "all-at-once:start");
      for (const rel of multiForkFiles) {
        const proposals = fileForks.get(rel)!.map((f) => f.content);
        const bc = baseContent(rel);
        chain = chain.pipe((sc) =>
          sc
            .send({ prompt: buildMergePrompt(rel, bc, proposals) })
            .combineWith<string, string>(
              (b) => b.executeShell(() => `echo llm-merge:all-merged ${shq(rel)}`),
              (resp) => { allState.merged[rel] = stripFence(resp); return resp; },
            ),
        );
      }

      // Write everything into the merge workspace + retest ONCE; stash the
      // ripple set on allState so the following assert can throw on it (a throw
      // routes the try to the sequential fallback).
      const allRipple: { set: string[] } = { set: [] };
      const retested = chain.pipe((sc) =>
        sc.executeShell(() => {
          for (const rel of multiForkFiles) allWs.writeUpperFile(rel, allState.merged[rel]);
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
  const { green, fileForks, baseContent, intendedSet, allIntendedSlides, ops, report } = ctx;
  report.mode = "sequential";

  const seqWs = createCowWorkspace({ base: ctx.repo, id: `llm-merge-seq-${process.pid}-${Date.now()}`, upperRoot: ctx.upperRoot });

  // The CURRENT accepted contents per file (starts empty = base; mutates as
  // forks fold in). `keptFiles` = files owned by a kept fork (what we promote).
  const accepted: Record<string, string> = {};
  const keptFiles = new Set<string>();

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

    // One minimal send per file, folding THIS fork's version into the CURRENT
    // accepted content. Building the prompt INSIDE the pipe body captures the
    // exec-time accepted state — so a later fork sees earlier forks' folds.
    for (const { rel, content } of forkFiles) {
      chain = chain.pipe((sc) => {
        const current = cur(rel);            // includes prior folded forks
        return sc
          .send({ prompt: buildMergePrompt(rel, current, [content]) })
          .combineWith<string, string>(
            (b) => b.executeShell(() => `echo llm-merge:seq-merged ${cluster.task} ${shq(rel)}`),
            (resp) => {
              accepted[rel] = stripFence(resp);
              seqWs.writeUpperFile(rel, accepted[rel]);
              return resp;
            },
          );
      });
    }

    // Retest the deck at the post-fold workspace state.
    chain = chain.pipe((sc) =>
      sc.executeShell(() => {
        const { changed } = ops.retest(seqWs, allIntendedSlides);
        perForkState.ripple = changed.filter((sid) => !intendedSet.has(sid));
        return `echo llm-merge:seq-retest ${cluster.task} changed=[${changed.join(",")}]`;
      }),
    );

    // Keep (clean) or roll back + demote (rippled).
    chain = chain.pipe((sc) =>
      sc.executeShell(() => {
        if (perForkState.ripple.length === 0) {
          report.accepted.push(cluster.task);
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
}

/**
 * Production `MergeOps`. `retest` renders the whole deck at the workspace state
 * (inside its overlay, so it sees the merged files) and at the base tree, then
 * structural-diffs — returning the changed slide ids. `promote` copies the merged
 * files onto the base. `demote` writes the candidates/ratings ledger. (Task 10
 * refines the retest's stability/pixel gating; this is the straightforward
 * whole-deck structural diff.)
 */
export function realLlmMergeOps(deps: RealLlmMergeOpsDeps): MergeOps {
  const repo = deps.repo;
  const fixturesDir = deps.fixturesDir ?? join(repo, "renderer/html2slides/e2e/fixtures");
  const REC = "renderer/structured-prompts/bug_solving/scripts/record-rendering.ts";
  const DIFF = "renderer/structured-prompts/bug_solving/scripts/diff-pptx-pairs.ts";

  const deckIds = (): string[] =>
    readdirSync(fixturesDir)
      .filter((f) => /^slide_\d+\.html$/.test(f))
      .map((f) => f.replace(/\.html$/, ""))
      .sort();

  // Base render is stable across a merge phase (base tree does not change), so
  // render it once and reuse.
  let baselineDir: string | null = null;

  return {
    retest(ws, _intendedSlides) {
      const ids = deckIds();
      if (ids.length === 0) return { changed: [] };
      const csv = ids.join(",");
      const scratch = `/tmp/llm-merge-${ws.id}`;
      const postOut = join(scratch, "post");

      if (baselineDir === null) {
        baselineDir = join(scratch, "baseline");
        mkdirSync(baselineDir, { recursive: true });
        execRepo(`cd "${join(repo, "renderer")}" && RECORD_CONCURRENCY=1 npx tsx "${join(repo, REC)}" --mode pptx --fixtures "${fixturesDir}" --slides "${csv}" --out "${baselineDir}"`);
      }
      // Render the merged state INSIDE the workspace overlay.
      mkdirSync(postOut, { recursive: true });
      ws.runShell(`cd renderer && RECORD_CONCURRENCY=1 npx tsx "${REC}" --mode pptx --fixtures "${fixturesDir}" --slides "${csv}" --out "${postOut}"`);

      const diffOut = join(scratch, "diff");
      execRepo(`npx tsx "${join(repo, DIFF)}" --before "${join(baselineDir, "pptx")}" --after "${join(postOut, "pptx")}" --out "${diffOut}"`);
      const changed: string[] = [];
      try {
        for (const f of readdirSync(diffOut)) {
          if (!f.endsWith(".diff")) continue;
          const txt = readFileSync(join(diffOut, f), "utf8");
          if (!/no structural differences/i.test(txt)) changed.push(f.replace(/\.diff$/, ""));
        }
      } catch { /* no diffs dir → nothing changed */ }
      return { changed: changed.sort() };
    },
    promote(ws, files) {
      ws.promote(files);
    },
    demote(slides, task, reason) {
      ledgerDemote(deps.historyDir ?? join(repo, ".bug-solving-history"), slides, task, reason);
    },
  };
}

function execRepo(cmd: string): void {
  execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
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

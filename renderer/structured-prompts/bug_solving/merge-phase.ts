/**
 * merge-phase.ts — the FINAL MERGE PHASE of bug_solving, as a structured-prompting
 * GRAPH that runs on the engine (monitor-visible) instead of a procedural script.
 *
 * This is the graph twin of scripts/accept-solved-bugs.ts. That script drives the
 * accept/merge as an imperative loop; here the SAME logic is expressed as engine
 * NODES so the monitor shows the compose → conflict-resolution → retest for every
 * cluster, and so the whole thing is unit-testable with a MOCKED LLM (see
 * merge-phase.test.ts).
 *
 * ## Graph shape (per accepted / GREEN cluster, in a deterministic order)
 *
 *   mergePhase builds ONE `pipe` chain, folding the clusters left-to-right so the
 *   "accepted state" accumulates deterministically (cluster N composes onto the
 *   staging state that already carries clusters 0..N-1). Each cluster is one
 *   `pipe` sub-chain (`mergeCluster`) of the form:
 *
 *     pipe(cluster)
 *       └─ executeShell  COMPOSE   — apply THIS cluster's converter change onto the
 *       │                            accepted staging state via the patcher
 *       │                            (applyChanges). Emits a JSON envelope on stdout:
 *       │                            { conflict, conflictFiles, ... }.
 *       ├─ [conflict only]
 *       │    switchCwd(staging)              — resolve IN the staging worktree
 *       │    send  RESOLVE                   — the AGENT: merge the conflicted
 *       │                                       file(s) preserving BOTH sides,
 *       │                                       remove markers, reply RESOLVED/FAILED
 *       │    assert MARKERS-GONE + tsc-clean — verify the resolution; a FAILED /
 *       │                                       markers-remaining THROWS → revert.
 *       ├─ executeShell  RETEST    — render the WHOLE deck at the post-merge state
 *       │                            and structural-diff it against the pre-merge
 *       │                            baseline. Emits { changedSlides } on stdout.
 *       ├─ assert  PIXEL-PERFECT-OUTSIDE-ACCEPTED — every slide NOT in this run's
 *       │                            accepted (intended) set must be byte-identical
 *       │                            to the baseline (unchanged pptx ⇒ pixel-
 *       │                            identical). A changed non-accepted slide = a
 *       │                            RIPPLE regression → assert THROWS → revert.
 *       └─ executeShell  CAPTURE   — capture each just-accepted slide's screenshot
 *                                    (thumbnail) + pptx XML into the report.
 *
 *     The whole cluster sub-chain is wrapped in a `try(...)`: a thrown assert
 *     (unresolved conflict, or ripple regression) is caught and turns into a
 *     `revert` (compose helper rolls the staging state back), and the cluster is
 *     recorded as rejected — the accumulated accepted state is left untouched.
 *     A clean pass `promote`s the cluster onto the accepted state.
 *
 * ## Testability seam
 *
 *   Every side-effect the merge needs — composing the diff, rendering the deck,
 *   structural-diffing, tsc, reading/writing files, promoting/reverting — is a
 *   METHOD on a `MergeOps` object passed in. Production wires `realMergeOps`
 *   (patcher + record-rendering + diff-pptx-pairs + git). Tests pass a fake
 *   `MergeOps` (no Chrome / Google / git) AND a MockIO with canned `send`
 *   replies, so the resolver `send` node is a genuine engine node exercising the
 *   mocked LLM. See merge-phase.test.ts.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import {
  Session,
  SessionWithResult,
} from "../../../structured-prompting/src/index.js";
import type { ClaudeModel } from "../../../structured-prompting/src/index.js";
import { computeChanges, applyChanges, type Conflict } from "./scripts/patcher.js";

// Converter payload globs the patcher composes over (top-level converter .ts),
// mirroring accept-solved-bugs' CONVERTER_GLOBS.
export const CONVERTER_GLOBS = ["renderer/html2slides/*.ts"];

// Conflict markers the resolver assert scans for.
const MARKER_RE = /^(<{7}|={7}|>{7})/m;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A GREEN (already user-approved) cluster to fold into the accepted state. */
export interface MergeCluster {
  /** stable task slug, e.g. "clipping-curves". */
  task: string;
  /** worktree dir that carries this cluster's converter change (the "modified" side). */
  dir: string;
  /** the cluster's own targeted slides (already approved). Changes to THESE are
   *  intended; changes to any OTHER slide are a ripple regression. */
  slides: string[];
}

/** Per-slide verification artifact captured for an accepted cluster. */
export interface PerSlideCapture {
  /** absolute path to the just-accepted slide's rendered thumbnail (best-effort). */
  screenshotPath: string | null;
  /** the accepted slide's pptx XML (slideN.xml body), for verification. */
  xml: string | null;
}

/** The final report accumulated across all clusters. */
export interface MergeReport {
  accepted: string[];
  /** rejected clusters. `demotedSlides` = the slide ids fed back to the NEXT
   *  clustering round as losses (via ops.demoteForResolve) so re-clustering
   *  re-solves them; empty if the demote itself failed. */
  rejected: Array<{ task: string; reason: string; demotedSlides: string[] }>;
  conflicts: Array<{ task: string; files: string[]; resolved: boolean }>;
  perSlide: Record<string, PerSlideCapture>;
}

export interface MergePhaseArgs {
  clusters: MergeCluster[];
  /** clean base ref/dir the workers forked from (compose base). */
  base: string;
  /** the staging dir = the accumulating accepted state (workers compose onto this). */
  staging: string;
  /** fixture deck dir. */
  fixturesDir: string;
  /** model for the conflict-resolver agent. Default "opus". */
  resolveModel?: ClaudeModel;
  /** injectable side-effects. Default `realMergeOps(...)`. */
  ops?: MergeOps;
  /** scratch dir root for render/diff artifacts. Default /tmp/merge-phase. */
  scratchRoot?: string;
}

// ---------------------------------------------------------------------------
// MergeOps — the injectable side-effect surface (the test seam)
// ---------------------------------------------------------------------------

/** Result of composing one cluster's converter change onto the staging state. */
export interface ComposeResult {
  /** true iff the 3-way compose left genuine conflicts. */
  conflict: boolean;
  /** conflicted file paths (repo-relative), empty when clean. */
  conflictFiles: string[];
  /** for each conflicted file: its current on-disk contents WITH markers, so the
   *  resolver agent's prompt can show both sides. */
  markedFiles: Array<{ path: string; markedContents: string }>;
  /** staging HEAD/snapshot ref BEFORE this compose — the revert target. */
  preMergeRef: string;
}

/**
 * Every side-effect the merge graph performs. Production = `realMergeOps`;
 * tests inject a fake so no git / Chrome / Google is touched. All methods are
 * SYNC (the graph's executeShell/assert callbacks are sync-friendly, and the
 * heavy async work — model sends — goes through the engine, not here).
 */
export interface MergeOps {
  /** Compose `cluster`'s base→cluster converter change onto the staging state.
   *  On a clean 3-way merge the change is applied on disk and conflict=false.
   *  On a genuine conflict the marked bodies are written to disk (mirroring git)
   *  and conflict=true. */
  compose(cluster: MergeCluster): ComposeResult;
  /** Roll the staging state back to `ref` (drop this cluster's compose). */
  revert(ref: string): void;
  /** Promote (commit/record) the currently-composed staging state as accepted. */
  promote(cluster: MergeCluster): void;
  /** tsc-check the staging tree, scoped to the converter dir. Returns the number
   *  of converter-scoped `error TS` lines (0 = clean). */
  tscConverterErrors(): number;
  /** Render the WHOLE deck at the staging state's CURRENT tree into `outDir` and
   *  structural-diff it against `baselineDir`; return the set of slide_ids that
   *  changed. `baselineDir===null` means "render the baseline into outDir and
   *  return []" (used once, before the first compose). */
  renderAndDiff(baselineDir: string | null, outDir: string): string[];
  /** Capture an accepted slide's thumbnail path + pptx XML for the report. */
  captureSlide(slideId: string): PerSlideCapture;
  /** Read a staging-relative file (for the markers-gone assert). null if absent. */
  readStagingFile(relPath: string): string | null;
  /**
   * DEMOTE a rejected cluster's slides back to "loss" state so the NEXT
   * clustering round picks them up and re-solves them. Called from the merge
   * phase's REJECT paths (unresolved conflict / ripple regression) IN ADDITION
   * to the revert: the revert only rolls back the accepted state; this feedback
   * marks the ledger the next round reads.
   *
   * The next round classifies a cluster GREEN only if EVERY slide is `good` in
   * `.bug-solving-history/candidates.json` (merge-phase-runner.ts:86-88,
   * accept-solved-bugs.ts:255-257). So demotion flips each slide's candidates
   * status to `bad` — which makes the cluster RED (not green) next time, i.e. a
   * loss to re-solve. It also annotates the canonical `ratings.json` issue
   * (workspace-setup.ts readLedger, consumed by the worker prompt) with a
   * `mergeFailed`/`reason` note WITHOUT clobbering the user's original comment.
   *
   * MUST be idempotent (calling twice is a no-op beyond the first) and
   * NON-throwing (a demote failure must not crash the merge phase).
   */
  demoteForResolve(slides: string[], cluster: string, reason: string): void;
}

// ---------------------------------------------------------------------------
// realMergeOps — production wiring (patcher + git + record/diff scripts)
// ---------------------------------------------------------------------------

export interface RealMergeOpsDeps {
  repo: string;
  base: string;
  staging: string;
  fixturesDir: string;
  /** run a shell command in `cwd`, returning stdout; throws on non-zero. */
  sh: (cmd: string, cwd: string) => string;
  /** persistent per-slide ledger dir the NEXT clustering round reads
   *  (candidates.json for green-detection + ratings.json for the issue text).
   *  Default `<repo>/.bug-solving-history`. */
  historyDir?: string;
}

/**
 * Production MergeOps. The COMPOSE goes through the git-agnostic patcher
 * (computeChanges base→cluster + applyChanges onto staging) exactly like
 * accept-solved-bugs' `--compose patcher` path; promote/revert/render use git +
 * the record-rendering / diff-pptx-pairs scripts. Kept out of the graph so the
 * graph stays deterministic + testable.
 */
export function realMergeOps(deps: RealMergeOpsDeps): MergeOps {
  const { repo, base, staging, fixturesDir, sh } = deps;
  const historyDir = deps.historyDir ?? join(repo, ".bug-solving-history");
  const REC = join(repo, "renderer/structured-prompts/bug_solving/scripts/record-rendering.ts");
  const DIFF = join(repo, "renderer/structured-prompts/bug_solving/scripts/diff-pptx-pairs.ts");

  const deckIds = (): string[] =>
    readdirSync(fixturesDir)
      .filter((f) => /^slide_\d+\.html$/.test(f))
      .map((f) => f.replace(/\.html$/, ""))
      .sort();

  return {
    compose(cluster) {
      const preMergeRef = sh(`git -C "${staging}" rev-parse HEAD`, repo).trim();
      // materialise the clean base as a throwaway dir to diff against.
      const tmp = join(deps.repo, ".claude/worktrees", `merge-base-${cluster.task}-${Date.now()}`);
      sh(`git worktree add -b sp/merge-base-${cluster.task}-${Date.now()} "${tmp}" ${base}`, repo);
      let changes;
      try {
        changes = computeChanges(tmp, cluster.dir, CONVERTER_GLOBS);
      } finally {
        try { sh(`git worktree remove --force "${tmp}"`, repo); } catch { /* */ }
      }
      const res = applyChanges(staging, changes);
      if (res.ok) return { conflict: false, conflictFiles: [], markedFiles: [], preMergeRef };
      // materialise marker bodies on disk (mirror git cherry-pick) for the agent.
      for (const cf of res.conflicts) {
        try { writeFileSync(join(staging, cf.path), cf.merged); } catch { /* */ }
      }
      const markedFiles = res.conflicts.map((cf: Conflict) => ({
        path: cf.path,
        markedContents: (() => { try { return readFileSync(join(staging, cf.path), "utf8"); } catch { return ""; } })(),
      }));
      return { conflict: true, conflictFiles: res.conflicts.map((c: Conflict) => c.path), markedFiles, preMergeRef };
    },
    revert(ref) {
      try { sh(`git -C "${staging}" restore --source ${ref} --staged --worktree -- renderer/html2slides`, repo); } catch { /* */ }
    },
    promote(cluster) {
      sh(`git -C "${staging}" add -- renderer/html2slides`, repo);
      sh(`git -C "${staging}" -c user.email=merge@bug-solving -c user.name=merge-phase commit -q -m "SashaSlides: accept solved bug (${cluster.task})" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`, repo);
    },
    tscConverterErrors() {
      try { sh("npx tsc --noEmit", staging); return 0; }
      catch (e) {
        const out = (e as { stdout?: Buffer }).stdout?.toString() || (e as Error).message || "";
        return out.split("\n").filter((l) => /error TS/.test(l) && l.includes("renderer/html2slides/")).length;
      }
    },
    renderAndDiff(baselineDir, outDir) {
      const ids = deckIds();
      mkdirSync(outDir, { recursive: true });
      const postPptx = join(outDir, "pptx");
      sh(`cd "${join(staging, "renderer")}" && RECORD_CONCURRENCY=1 npx tsx "${REC}" --mode pptx --fixtures "${fixturesDir}" --slides "${ids.join(",")}" --out "${outDir}"`, repo);
      if (baselineDir === null) return [];
      const diffOut = join(outDir, "diff");
      sh(`npx tsx "${DIFF}" --before "${join(baselineDir, "pptx")}" --after "${postPptx}" --out "${diffOut}"`, join(repo, "renderer/structured-prompts/bug_solving/scripts"));
      const out: string[] = [];
      for (const f of readdirSync(diffOut)) {
        if (!f.endsWith(".diff")) continue;
        const txt = readFileSync(join(diffOut, f), "utf8");
        if (!/no structural differences/i.test(txt)) out.push(f.replace(/\.diff$/, ""));
      }
      return out.sort();
    },
    captureSlide(slideId) {
      // best-effort thumbnail path (populated by a --mode full render elsewhere)
      // and the slide's pptx XML unzipped from the just-rendered pptx.
      let xml: string | null = null;
      const pptx = join(staging, "renderer", ".merge-capture", "pptx", `${slideId}.pptx`);
      try {
        if (existsSync(pptx)) {
          xml = sh(`unzip -p "${pptx}" ppt/slides/slide1.xml`, repo);
        }
      } catch { /* */ }
      const thumb = join(staging, "renderer", ".merge-capture", "thumbs", `${slideId}.png`);
      return { screenshotPath: existsSync(thumb) ? thumb : null, xml };
    },
    readStagingFile(relPath) {
      try { return readFileSync(join(staging, relPath), "utf8"); } catch { return null; }
    },
    demoteForResolve(slides, cluster, reason) {
      // Feed a merge-rejected cluster BACK to the next clustering round as a
      // loss. NON-throwing + idempotent: any failure is logged and swallowed so
      // it can never crash the merge phase (the revert already ran).
      if (!slides.length) return;
      const now = new Date().toISOString();
      try { mkdirSync(historyDir, { recursive: true }); } catch { /* */ }

      // (1) candidates.json — the GATE the next round's green-detection reads
      // (merge-phase-runner.ts:86-88 / accept-solved-bugs.ts:255-257: a cluster
      // is green ONLY if every slide is `good` here). Flip each demoted slide to
      // `bad` so the cluster is classified RED next time = a loss to re-solve.
      try {
        const candFile = join(historyDir, "candidates.json");
        const cand: Record<string, Record<string, unknown>> =
          existsSync(candFile) ? JSON.parse(readFileSync(candFile, "utf8")) : {};
        for (const sid of slides) {
          const prev = (cand[sid] as Record<string, unknown> | undefined) ?? {};
          // Idempotent: if already demoted for this exact cluster, leave it.
          if (prev.status === "bad" && prev.mergeFailed === true && prev.mergeFailedCluster === cluster) continue;
          cand[sid] = {
            ...prev,
            status: "bad",
            mergeFailed: true,
            mergeFailedCluster: cluster,
            mergeFailedReason: reason,
            mergeFailedAt: now,
          };
        }
        writeFileSync(candFile, JSON.stringify(cand, null, 2));
      } catch (e) {
        console.error(`[merge-phase] demoteForResolve(candidates) best-effort failure for ${cluster}: ${(e as Error).message}`);
      }

      // (2) ratings.json — the canonical issue the worker prompt reads
      // (workspace-setup.ts readLedger → buildSlideTasks user_comment). ANNOTATE
      // it (don't clobber the user's original comment) so the re-solve carries
      // the merge-failure context.
      try {
        const ledgerFile = join(historyDir, "ratings.json");
        const ledger: Record<string, Record<string, unknown>> =
          existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) : {};
        for (const sid of slides) {
          const prev = (ledger[sid] as Record<string, unknown> | undefined) ?? {};
          if (prev.mergeFailed === true && prev.mergeFailedCluster === cluster) continue; // idempotent
          ledger[sid] = {
            ...prev,
            // preserve the user's original comment verbatim; record failure meta
            // in dedicated fields so the next round can surface it.
            mergeFailed: true,
            mergeFailedCluster: cluster,
            mergeFailedReason: reason,
            mergeFailedAt: now,
          };
        }
        writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
      } catch (e) {
        console.error(`[merge-phase] demoteForResolve(ratings) best-effort failure for ${cluster}: ${(e as Error).message}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Conflict-resolver prompt (mirrors accept-solved-bugs.buildResolvePrompt)
// ---------------------------------------------------------------------------

/** Build the RESOLVE prompt the agent runs (in the staging cwd) to merge a
 *  genuine conflict, preserving BOTH sides. Exported so tests can assert the
 *  mock send was called with the conflict context (files + markers). */
export function buildResolvePrompt(cluster: MergeCluster, marked: Array<{ path: string; markedContents: string }>): string {
  const fileList = marked.map((f) => `  - ${f.path}`).join("\n");
  const markerBlocks = marked
    .map((f) => `### ${f.path}\n\`\`\`\n${f.markedContents.slice(0, 8000)}\n\`\`\``)
    .join("\n\n");
  return [
    `You are resolving a MERGE CONFLICT in THIS worktree (your cwd). The bug-fix pipeline is composing the converter fix from cluster "${cluster.task}" (targets slides ${cluster.slides.join(", ")}) onto a stack of ALREADY-ACCEPTED converter fixes, and the 3-way merge could not auto-merge these file(s):`,
    fileList,
    ``,
    `Each conflicted file currently contains conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`). Both sides are INTENTIONAL, INDEPENDENTLY-REVIEWED fixes — you MUST preserve BOTH sides' changes, not pick one.`,
    ``,
    `## The conflicted file(s) (with markers):`,
    markerBlocks,
    ``,
    `## Your job`,
    `1. EDIT the conflicted file(s) to a clean, correct merge that keeps BOTH sides' changes.`,
    `2. REMOVE every conflict marker — none may remain.`,
    `3. Keep the code COMPILING (TypeScript under renderer/html2slides).`,
    `4. Do NOT run git commit/add — just leave the files edited on disk.`,
    ``,
    `When done, reply with EXACTLY the single word RESOLVED. If you genuinely cannot produce a correct both-sides merge, reply "FAILED: <one-line reason>".`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The graph builder
// ---------------------------------------------------------------------------

/** Mutable accumulator threaded through the pipe fold. Carried as the pipe's
 *  upstream value so each cluster sees the running report. */
interface Accum {
  report: MergeReport;
}

function freshReport(): MergeReport {
  return { accepted: [], rejected: [], conflicts: [], perSlide: {} };
}

/** Sentinel error the cluster try/catch uses to distinguish a controlled
 *  reject (revert + record) from a genuine engine failure. */
class ClusterRejected extends Error {
  constructor(public readonly cluster: string, public readonly why: string) {
    super(`cluster ${cluster} rejected: ${why}`);
    this.name = "ClusterRejected";
  }
}

/**
 * Build the merge phase graph. Returns a SessionWithResult<MergeReport> that,
 * when executed by the engine, folds every cluster into the accepted state as
 * engine nodes (monitor-visible). Deterministic order = the `clusters` array
 * order; the pipe fold makes cluster N compose onto the state carrying 0..N-1.
 */
export function mergePhase(
  session: Session,
  args: MergePhaseArgs,
): SessionWithResult<MergeReport> {
  const ops = args.ops ?? mustProvideOps();
  const resolveModel: ClaudeModel = args.resolveModel ?? "opus";
  const scratchRoot = args.scratchRoot ?? "/tmp/merge-phase";
  // Fresh shared report for this phase run (the shared map is the single source
  // of truth every node mutates; see currentReport).
  _resetReport(scratchRoot);
  const report = () => currentReport(scratchRoot);

  // Seed the pipe fold with a baseline render (no diff — establishes the
  // pre-merge deck the first cluster's retest diffs against).
  let chain: SessionWithResult<Accum> = session
    .executeShell(() => {
      ops.renderAndDiff(null, join(scratchRoot, "baseline"));
      return `echo merge-phase:baseline-rendered`;
    })
    .combineWith<string, Accum>(
      (branch) => branch.executeShell(() => `echo merge-phase:baseline-leaf`),
      () => ({ report: report() }),
    );

  // Fold each cluster into the chain, in order.
  for (const cluster of args.clusters) {
    chain = chain.pipe((s) => mergeCluster(s, cluster, args, ops, resolveModel, scratchRoot));
  }

  // Final node: surface the accumulated report as the phase result.
  return chain.pipe((s) => installValue(s, report()));
}

/**
 * One cluster's sub-chain. Wrapped in `try(...)` so a thrown assert (unresolved
 * conflict / ripple regression) is caught → revert + record rejected, and the
 * accepted state is left untouched. A clean pass promotes the cluster.
 */
function mergeCluster(
  session: Session,
  cluster: MergeCluster,
  args: MergePhaseArgs,
  ops: MergeOps,
  resolveModel: ClaudeModel,
  scratchRoot: string,
): SessionWithResult<Accum> {
  const report = () => currentReport(scratchRoot);
  // Per-cluster mutable compose state, populated by the COMPOSE node and read by
  // later nodes in the same cluster sub-chain.
  // NB: an executeShell node's RESULT is the shell command's stdout, NOT what
  // its buildCommand callback returns. So every value a later node needs from a
  // shell step (compose result, retest changed-set) is stashed here in a plain
  // JS closure and read directly — the shell echo is only a monitor marker.
  const state: {
    preMergeRef: string;
    conflict: boolean;
    conflictFiles: string[];
    marked: Array<{ path: string; markedContents: string }>;
    changed: string[];
  } = { preMergeRef: "", conflict: false, conflictFiles: [], marked: [], changed: [] };

  return session.try<Accum>(
    (s) => {
      // ── (1) COMPOSE ───────────────────────────────────────────────────────
      let c: SessionWithResult<unknown> = s.executeShell(() => {
        const res = ops.compose(cluster);
        state.preMergeRef = res.preMergeRef;
        state.conflict = res.conflict;
        state.conflictFiles = res.conflictFiles;
        state.marked = res.markedFiles;
        return `echo merge-phase:compose ${cluster.task} conflict=${res.conflict} files=[${res.conflictFiles.join(",")}]`;
      });

      // ── (2) CONFLICT → resolver agent (send) + verify asserts ─────────────
      // The send node ALWAYS exists in the graph (deterministic shape); the
      // resolver prompt only carries real content when a conflict was detected.
      // On the no-conflict path the send is skipped by a guard prompt so the
      // model isn't invoked. To keep the LLM genuinely conditional we branch:
      // only build the send sub-chain when compose reported a conflict at BUILD
      // time is impossible (compose runs at exec time), so we make the send's
      // firing conditional via a pipe that inspects `state` at exec time.
      c = c.pipe((sc) => {
        // At the moment this pipe body executes, COMPOSE has already run and
        // populated `state`. If there's no conflict, short-circuit (no send).
        if (!state.conflict) {
          return installValue(sc, "no-conflict");
        }
        // CONFLICT: switch into the staging worktree and hand the marked files
        // to the resolver agent. This `send` IS the LLM merge resolver.
        return sc
          .switchCwd(args.staging)
          .switchModel(resolveModel)
          .send({ prompt: buildResolvePrompt(cluster, state.marked) })
          .assert((reply: string) => {
            // Trust the FILES, not just the word: no markers may remain in ANY
            // conflicted file, and the agent must not have said FAILED.
            const saidFailed = /^FAILED\b/i.test(reply.trim());
            const markersRemain = state.conflictFiles.some((f) => {
              const txt = ops.readStagingFile(f);
              return txt == null || MARKER_RE.test(txt);
            });
            if (saidFailed || markersRemain) {
              throw new ClusterRejected(
                cluster.task,
                saidFailed ? `resolver replied FAILED: ${reply.trim().slice(0, 120)}`
                           : `conflict markers still present in [${state.conflictFiles.join(", ")}]`,
              );
            }
            // record the resolved conflict in the report.
            report().conflicts.push({ task: cluster.task, files: state.conflictFiles, resolved: true });
            // converter-scoped tsc gate — a broken merge is a reject.
            const tscErr = ops.tscConverterErrors();
            if (tscErr > 0) {
              throw new ClusterRejected(cluster.task, `resolver left ${tscErr} converter tsc error(s)`);
            }
          });
      });

      // ── (3) RETEST: render whole deck post-merge + structural-diff ────────
      const retested = c.executeShell(() => {
        state.changed = ops.renderAndDiff(join(scratchRoot, "baseline"), join(scratchRoot, `post-${cluster.task}`));
        return `echo merge-phase:retest changed=[${state.changed.join(",")}]`;
      });

      // ── (4) ASSERT pixel-perfect OUTSIDE the accepted (intended) set ──────
      const gated = retested.assert(() => {
        const changed = state.changed;
        const intendedSet = new Set(cluster.slides);
        const ripple = changed.filter((sid) => !intendedSet.has(sid));
        if (ripple.length > 0) {
          // A non-accepted slide changed = its pptx differs from baseline =
          // NOT byte-identical = a regression. Revert this cluster.
          throw new ClusterRejected(cluster.task, `rippled to non-accepted slides [${ripple.join(", ")}] (not pixel-perfect vs baseline)`);
        }
      });

      // ── (5) CAPTURE accepted slides' screenshot + XML, then PROMOTE ───────
      return gated.executeShell(() => {
        for (const sid of cluster.slides) {
          report().perSlide[sid] = ops.captureSlide(sid);
        }
        ops.promote(cluster);
        report().accepted.push(cluster.task);
        return `echo merge-phase:promote ${cluster.task}`;
      }).pipe((sp) => installValue(sp, { report: report() } as Accum));
    },
    // Fallback: a ClusterRejected (or any assert throw) → revert + record.
    // In ADDITION to the revert, DEMOTE the cluster's slides back to "loss" in
    // the ledger so the NEXT clustering round re-solves them (both reject
    // reasons: unresolved merge conflict, and ripple regression). The demote is
    // idempotent + non-throwing; a demote failure must NOT convert this
    // controlled reject into an engine crash.
    (s, err) => {
      const why = err instanceof ClusterRejected ? err.why : (err as Error)?.message ?? String(err);
      ops.revert(state.preMergeRef);
      const rep = report();
      // The slides to feed back: the cluster's intended (targeted) set. These
      // were user-approved once but the fix could not land cleanly, so they must
      // be re-solved. `cluster.slides` IS the intended set on MergeCluster.
      const demoteSlides = cluster.slides;
      let demotedSlides: string[] = [];
      try {
        ops.demoteForResolve(demoteSlides, cluster.task, why);
        demotedSlides = demoteSlides;
      } catch (de) {
        // Idempotent+non-throwing is the ops contract, but belt-and-suspenders:
        // never let a demote failure crash the (already-controlled) reject.
        console.error(`[merge-phase] demoteForResolve threw for ${cluster.task} (continuing): ${(de as Error)?.message ?? String(de)}`);
      }
      rep.rejected.push({ task: cluster.task, reason: why, demotedSlides });
      // If a conflict was detected but not resolved, record it as unresolved.
      if (state.conflict && !rep.conflicts.some((cf) => cf.task === cluster.task)) {
        rep.conflicts.push({ task: cluster.task, files: state.conflictFiles, resolved: false });
      }
      return installValue(s, { report: rep } as Accum);
    },
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A per-scratchRoot singleton report, so every node in the phase mutates the
 *  SAME MergeReport regardless of which sub-session it runs in. (The engine
 *  clones RunCtx per branch, but plain JS closures over this map are shared.) */
const _reports = new Map<string, MergeReport>();
function currentReport(scratchRoot: string): MergeReport {
  let r = _reports.get(scratchRoot);
  if (!r) { r = freshReport(); _reports.set(scratchRoot, r); }
  return r;
}

/** Reset the shared report for a scratchRoot (call before a fresh phase run). */
export function _resetReport(scratchRoot: string): void {
  _reports.set(scratchRoot, freshReport());
}

/**
 * Install a constant value `value` as the chain's result at a real graph node.
 * The report/accumulator is the shared source of truth (see currentReport), so
 * the threaded value is only a type carrier — but it must ride on an ACTUAL
 * node so the chain stays a valid description. We use one `executeShell` (a
 * no-op `echo`, monitor-visible) and remap its string result to `value` via a
 * `combineWith` whose combine fn ignores both sides and returns `value`. The
 * execution branch is itself a trivial echo (combineWith requires a
 * SessionWithResult from its execution callback).
 */
function installValue<T>(session: Session, value: T): SessionWithResult<T> {
  return session
    .executeShell(() => `echo merge-phase:value`)
    .combineWith<string, T>(
      (branch) => branch.executeShell(() => `echo merge-phase:leaf`),
      (_left, _right) => value,
    );
}

/** Guard for the no-ops-provided case. Throwing here (build time) is correct —
 *  a production run MUST wire realMergeOps; only tests inject a fake. */
function mustProvideOps(): never {
  throw new Error(
    "mergePhase: `ops` is required. Wire realMergeOps({repo, base, staging, fixturesDir, sh}) " +
    "for a production run, or a fake MergeOps in tests.",
  );
}

export { ClusterRejected };

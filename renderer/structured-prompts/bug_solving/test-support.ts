/**
 * test-support.ts — the ONE sanctioned mock kit for the bug_solving tests.
 *
 * ██ MOCK POLICY — tests may mock ONLY these THREE things, and NOTHING else ██
 *   (H) HUMAN rating (green/red)      → greenCluster / writeRatingOutcome
 *   (L) the LLM call                  → mockLlm  (real IO; intercepts ONLY claude/codex)
 *   (R) the Google-Slides recording   → recordingFromContent / recordingSeam (MergeRenderSeam)
 * Everything else runs FOR REAL: COW overlays, the filesystem, git, the clock,
 * shells, the regression gate, promote, and the demote ledger. Each mock takes an
 * optional `tag` so a test can identify WHERE the mocked call comes from.
 *
 * The key to "mock only the LLM" is `mockLlm`: it returns a real `IO` that
 * delegates every effect to `realIO` (real bash/git/fs/clock/log) EXCEPT a
 * `claude`/`codex` spawn, which it answers with the injected reply. This is why
 * tests no longer need a wall of MockIO matchers for now/log/bash/git/fs — those
 * are not mocked at all anymore.
 */
import { realIO, type IO, type SpawnCaptureArgs, type SpawnCaptureResult } from "../../../structured-prompting/src/server/io.js";
import { ClaudeEngine, Session } from "../../../structured-prompting/src/index.js";
import type { CowWorkspace } from "../../../cow-workspace/cow-workspace.js";
import { llmMerge, type GreenCluster, type MergeOps, type MergeRatingArgs, type MergeRatingVerdict, type MergeRenderSeam, type MergeReport } from "./llm-merge.js";
import type { RenderRecord } from "./stability.js";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ───────────────────────── (L) the LLM call ─────────────────────────────────
export interface LlmMock {
  /** a REAL IO that mocks ONLY claude/codex spawns; all else delegates to realIO. */
  io: IO;
  /** every intercepted LLM call, tagged by call-site (the "location identifier"). */
  seen: Array<{ tag: string; prompt: string; reply: string }>;
}

/**
 * Build an IO that runs everything for real and mocks ONLY the LLM spawn.
 * `reply(prompt)` produces the model's result text. `tag` labels the call-site.
 */
export function mockLlm(reply: (prompt: string) => string, opts: { tag?: string } = {}): LlmMock {
  const tag = opts.tag ?? "llm";
  const seen: LlmMock["seen"] = [];
  const io: IO = {
    spawnCapture(args: SpawnCaptureArgs): Promise<SpawnCaptureResult> {
      if (args.command === "claude" || args.command === "codex") {
        const pi = args.args.indexOf("-p");
        const prompt = pi >= 0 ? (args.args[pi + 1] ?? "") : "";
        const out = reply(prompt);
        seen.push({ tag, prompt, reply: out });
        return Promise.resolve(claudeResult(out));
      }
      return realIO.spawnCapture(args); // REAL bash / git / everything else
    },
    mkdtempSync: (p) => realIO.mkdtempSync(p),
    writeFileSync: (p, d) => realIO.writeFileSync(p, d),
    rmSync: (p, o) => realIO.rmSync(p, o),
    now: () => realIO.now(),
    log: (l, ...parts) => realIO.log(l, ...parts),
  };
  return { io, seen };
}

function claudeResult(result: string): SpawnCaptureResult {
  return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "mock", duration_ms: 1, total_cost_usd: 0 }), stderr: "", exitCode: 0, signal: null, timedOut: false, spawnError: null };
}

/** A record of one agentic merge-edit the mock model performed on disk. */
export interface MergeEdit { target: string; before: string; after: string; conflicted: boolean; }

/**
 * The mock stand-in for the model's AGENTIC edit-and-verify pass. The real model
 * would Read + Edit the merged file at EDIT_TARGET in place; the mock does the
 * same file effect: it reads EDIT_TARGET from the prompt, and if the 3-way merge
 * left diff3 conflict markers it resolves them (default: keep BOTH sides — the
 * union of ours+theirs), writing the result back. A CLEAN merge is left untouched
 * (byte-exact), exactly as a good model leaves a clean merge alone.
 *
 * Returns `{ reply, edits }`: pass `reply` to `mockLlm`, and assert on `edits`
 * (each has the pre/post content + whether it was a conflict) — e.g. to prove a
 * clean disjoint merge made NO edit, or that a serial fold's target already
 * carried the prior fork's fix.
 */
export function mergeEditor(opts: { resolve?: (block: ConflictBlock) => string } = {}): { reply: (prompt: string) => string; edits: MergeEdit[] } {
  const edits: MergeEdit[] = [];
  const resolve = opts.resolve ?? ((b) => [...b.ours, ...b.theirs].join("\n"));
  const reply = (prompt: string): string => {
    const m = prompt.match(/EDIT_TARGET:\s*(\S+)/);
    if (!m) return "no EDIT_TARGET in prompt";
    const target = m[1];
    let before: string;
    try { before = readFileSync(target, "utf8"); } catch { return `EDIT_TARGET unreadable: ${target}`; }
    const conflicted = /^<<<<<<< /m.test(before);
    const after = conflicted ? resolveConflicts(before, resolve) : before;
    if (after !== before) writeFileSync(target, after);
    edits.push({ target, before, after, conflicted });
    return conflicted ? "resolved conflict markers (kept both fixes)" : "verified clean merge; no edits";
  };
  return { reply, edits };
}

/** The three regions of one diff3 conflict block. */
export interface ConflictBlock { ours: string[]; base: string[]; theirs: string[]; }

/** Replace every diff3 conflict block (<<<<<<< / ||||||| / ======= / >>>>>>>)
 *  with `resolve(block)`; pass non-conflict lines through unchanged. */
export function resolveConflicts(content: string, resolve: (b: ConflictBlock) => string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<< ")) {
      const ours: string[] = [], base: string[] = [], theirs: string[] = [];
      let bucket = ours;
      i++;
      while (i < lines.length && !lines[i].startsWith(">>>>>>> ")) {
        if (lines[i].startsWith("||||||| ")) { bucket = base; i++; continue; }
        if (lines[i] === "=======") { bucket = theirs; i++; continue; }
        bucket.push(lines[i]); i++;
      }
      i++; // skip the >>>>>>> line
      const resolved = resolve({ ours, base, theirs });
      if (resolved.length) out.push(...resolved.split("\n"));
    } else {
      out.push(lines[i]); i++;
    }
  }
  return out.join("\n");
}

// ─────────────────────── (R) the Slides recording ───────────────────────────
export interface RecordingMock extends MergeRenderSeam {
  /** every recording call, tagged + labelled by point (base/lgtm/merge). */
  calls: Array<{ tag: string; point: "base" | "lgtm" | "merge"; slide: string }>;
}

/**
 * A deterministic MergeRenderSeam driven by the converter CONTENT: a slide's
 * render key changes only when its mapped fix appears in the file. The merge
 * render reads the REAL overlay content (`ws.readUpperFile`) — only the render's
 * OUTPUT (what Google would produce) is synthesized. `lgtm` overrides per slide.
 */
export function recordingFromContent(opts: {
  converterRel: string;
  baseFileContent: string;
  fixMap: Record<string, string>;
  lgtm?: (sid: string) => RenderRecord | undefined;
  tag?: string;
}): RecordingMock {
  const tag = opts.tag ?? "recording";
  const calls: RecordingMock["calls"] = [];
  const rec = (sid: string, content: string) => contentRecord(sid, content, opts.fixMap);
  return {
    calls,
    baseRecord(sid) { calls.push({ tag, point: "base", slide: sid }); return rec(sid, opts.baseFileContent); },
    lgtmRecord(sid) { calls.push({ tag, point: "lgtm", slide: sid }); return opts.lgtm?.(sid) ?? rec(sid, `${opts.baseFileContent}export const ${opts.fixMap[sid] ?? "NONE"} = "x";\n`); },
    renderMergeDeck(ws) {
      return (sid) => { calls.push({ tag, point: "merge", slide: sid }); return rec(sid, ws.readUpperFile(opts.converterRel) ?? opts.baseFileContent); };
    },
  };
}

/** The deterministic render of a slide for a given converter content: its key
 *  changes only when its mapped fix is present. Exported so tests can craft
 *  custom LGTM/base records (e.g. the SxS-absent "LGTM falls back to base"). */
export function contentRecord(sid: string, content: string, fixMap: Record<string, string>): RenderRecord {
  const fix = fixMap[sid];
  const active = fix && new RegExp(fix).test(content) ? fix : "";
  const key = sha1(`${sid}|${active}`);
  return { pixelHash: key, xmlHash: key, renderedPartsHash: key };
}

/** A fully hand-specified recording seam (for cases that don't derive from
 *  content, e.g. an xml-stable rendered-parts change). Records tagged calls. */
export function recordingSeam(spec: {
  base: (sid: string) => RenderRecord;
  lgtm: (sid: string) => RenderRecord;
  merge: (ws: CowWorkspace, sid: string) => RenderRecord;
  tag?: string;
}): RecordingMock {
  const tag = spec.tag ?? "recording";
  const calls: RecordingMock["calls"] = [];
  return {
    calls,
    baseRecord(sid) { calls.push({ tag, point: "base", slide: sid }); return spec.base(sid); },
    lgtmRecord(sid) { calls.push({ tag, point: "lgtm", slide: sid }); return spec.lgtm(sid); },
    renderMergeDeck(ws) { return (sid) => { calls.push({ tag, point: "merge", slide: sid }); return spec.merge(ws, sid); }; },
  };
}

function sha1(s: string): string { return execSync(`printf '%s' ${JSON.stringify(s)} | sha1sum`).toString().slice(0, 12); }

// ─────────────────────────── (H) human rating ───────────────────────────────
/** A green cluster (the human marked its slides GOOD). */
export function greenCluster(task: string, ws: CowWorkspace, slides: string[], sharedDir?: string): GreenCluster {
  return { task, branch_id: ws.id, slides, ...(sharedDir ? { shared_dir: sharedDir } : {}) };
}

/** Write the fork's rating-outcome marker = the human's green/red verdict (what
 *  the rating UI would persist when you click Good/Bad). */
export function writeRatingOutcome(sharedDir: string, m: { task: string; green: boolean; good?: string[]; bad?: string[]; unrated?: string[]; slides?: string[] }): void {
  mkdirSync(sharedDir, { recursive: true });
  const payload = { task_id: m.task, green: m.green, rated: true, good: m.good ?? [], bad: m.bad ?? [], unrated: m.unrated ?? [], slides: m.slides ?? [] };
  writeFileSync(join(sharedDir, "rating-outcome.json"), JSON.stringify(payload));
}

// ───────── (H) human rating of a MERGE's changed slides ─────────────────────
/** A merge-rating mock = the (H) human in the 3-mock policy for the merge flow.
 *  `decide` returns the verdict over the changed slides shown at each rating
 *  round; every call is recorded so a test can assert the ratings the human saw
 *  (phase, label, changed set). */
export interface MergeRateMock {
  rate: (a: MergeRatingArgs) => MergeRatingVerdict;
  calls: Array<{ phase: "all-at-once" | "sequential"; label: string; changed: string[] }>;
}
export function mergeRateMock(decide: (c: { phase: "all-at-once" | "sequential"; label: string; changed: string[] }) => MergeRatingVerdict): MergeRateMock {
  const calls: MergeRateMock["calls"] = [];
  return {
    calls,
    rate: (a) => { const c = { phase: a.phase, label: a.label, changed: [...a.changed] }; calls.push(c); return decide(c); },
  };
}
/** Convenience verdicts (the human's per-slide good/bad). */
export const verdictGreenAll = (changed: string[]): MergeRatingVerdict => ({ green: [...changed], red: [] });
export const verdictRed = (red: string[], changed: string[]): MergeRatingVerdict => ({ green: changed.filter((s) => !red.includes(s)), red: [...red] });
/** The "Reject ALL" button = red every shown slide. */
export const verdictStopAll = (changed: string[]): MergeRatingVerdict => ({ green: [], red: [...changed] });

// ───────── run a merge with ONLY the LLM mocked at the engine level ──────────
/** Execute `llmMerge` on a REAL engine whose IO mocks only the LLM. `ops` should
 *  be the REAL `realLlmMergeOps` (real gate/promote/ledger) with a `render` seam. */
export async function runRealMerge(opts: { base: string; green: GreenCluster[]; ops: MergeOps; upperRoot: string; llm: LlmMock }): Promise<{ report?: MergeReport; threw: unknown }> {
  const engine = new ClaudeEngine({ io: opts.llm.io, persist: false, hookSignals: false, log: false, port: 0 });
  let report: MergeReport | undefined;
  let threw: unknown = null;
  try {
    report = await engine.execute(
      new Session({ sessionId: "merge", cwd: opts.base }),
      (s) => llmMerge(s, { repo: opts.base, greenClusters: opts.green, ops: opts.ops, upperRoot: opts.upperRoot }),
    );
  } catch (e) { threw = e; } finally { await engine.shutdown(); }
  return { report, threw };
}

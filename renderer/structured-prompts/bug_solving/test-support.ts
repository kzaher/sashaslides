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
import { llmMerge, type GreenCluster, type MergeOps, type MergeRenderSeam, type MergeReport } from "./llm-merge.js";
import type { RenderRecord } from "./stability.js";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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

/** Convenience LLM reply for the merge compose: base + every NEW `FIX_` line from
 *  the proposals (simulates "incorporate all the fixes"). */
export function mergeComposer(prompt: string): string {
  const [base, ...proposals] = fencedBlocks(prompt);
  const have = new Set((base ?? "").split("\n"));
  const extra: string[] = [];
  for (const p of proposals) for (const line of p.split("\n")) if (/FIX_/.test(line) && !have.has(line)) { have.add(line); extra.push(line); }
  return [...(base ?? "").split("\n"), ...extra].join("\n");
}
/** The ```-fenced blocks of a merge prompt; block 0 = the base version. */
export function fencedBlocks(prompt: string): string[] {
  return prompt.split("```").filter((_, i) => i % 2 === 1).map((b) => b.replace(/^\n/, "").replace(/\n$/, ""));
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

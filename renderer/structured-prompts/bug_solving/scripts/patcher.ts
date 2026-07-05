/**
 * patcher.ts — a BACKEND-NEUTRAL patch/compose engine for bug_solving.
 *
 * Today the compose logic in merge-worktrees.ts / merge-phase.ts is
 * git-specific (`git diff <base>`, `git apply --3way`, `git cherry-pick`). The
 * team is switching branching from git worktrees to FULL DISK COPIES (a
 * "worktree" becomes a plain directory copy, no git metadata). This module
 * abstracts the two operations those callers actually need — DIFF two states
 * and COMPOSE a set of changes onto a target — so they work for BOTH backends:
 *
 *   - computeChanges(baseDir, modifiedDir, globs)  ← replaces `git diff <base>`
 *   - applyChanges(targetDir, changes)             ← replaces `git apply --3way`
 *                                                     / `git cherry-pick`
 *
 * It is PURE in the sense that matters for testing: filesystem in, filesystem
 * out. No git, no network, no shelling out. `applyChanges` composes each change
 * onto whatever the target already has via a per-file 3-way LINE merge (base =
 * change.before, theirs = change.after, ours = the target's CURRENT content),
 * so two independent clusters editing the SAME file at DIFFERENT regions both
 * land, while an edit to the SAME lines is reported as a conflict instead of
 * silently clobbering.
 *
 * The git cherry-pick path in the callers can remain as an alternative, but the
 * PATCHING is now available git-free and disk-copy-ready.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join, dirname, relative, sep } from "node:path";

/**
 * A single file's change between two directory states. `null` on either side
 * encodes creation / deletion:
 *   before=null, after=string  → file was CREATED
 *   before=string, after=null  → file was DELETED
 *   before=string, after=string→ file was MODIFIED
 * `path` is always POSIX-style (forward slashes), relative to the dir root.
 */
export type FileChange = { path: string; before: string | null; after: string | null };

/** A file whose 3-way merge could not be applied cleanly. `merged` carries the
 *  conflicted body WITH `<<<<<<<`/`=======`/`>>>>>>>` markers so the caller can
 *  write it out for a human/agent to resolve, mirroring git's on-disk output. */
export interface Conflict {
  path: string;
  reason: string;
  merged: string; // the marker-annotated body (unified conflict view)
}

export type ApplyResult = { ok: true } | { ok: false; conflicts: Conflict[] };

// ───────────────────────────────────────────────────────────────────────────
// glob matching (tiny, dependency-free): supports the two forms the callers use
//   'renderer/html2slides/**/*.ts'  and  'renderer/html2slides/*.ts'
// plus a leading './'. `**` crosses '/'; a single `*` does not.
// ───────────────────────────────────────────────────────────────────────────
function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") {
        // `**` (optionally followed by a '/') matches any number of path
        // segments, including zero — so `a/**/b.ts` matches `a/b.ts`.
        i++;
        if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; }
        else re += ".*";
      } else {
        re += "[^/]*"; // single star: within a segment only.
      }
    } else if (".+?^${}()|[]\\".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp("^" + re + "$");
}

function matchesAny(relPath: string, globs: RegExp[]): boolean {
  return globs.some((g) => g.test(relPath));
}

/** POSIX-ify a path (forward slashes) so FileChange.path is platform-stable. */
function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/** Recursively list files under `dir` (relative, POSIX), skipping `.git` and
 *  node_modules — never part of the converter payload and expensive to walk. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const walk = (abs: string): void => {
    for (const name of readdirSync(abs)) {
      if (name === ".git" || name === "node_modules") continue;
      const full = join(abs, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(toPosix(relative(dir, full)));
    }
  };
  walk(dir);
  return out;
}

function readOrNull(dir: string, relPath: string): string | null {
  const p = join(dir, relPath);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

/**
 * Diff two DIRECTORIES file-by-file over the given globs. Git-agnostic: it just
 * reads files from each dir and compares. Returns one FileChange per differing
 * file (added / deleted / modified); identical files are omitted, so identical
 * dirs → []. `globs` scopes which files participate (both the union of paths in
 * either dir is considered, then filtered by glob).
 */
export function computeChanges(baseDir: string, modifiedDir: string, globs: string[]): FileChange[] {
  const res = globs.map(globToRegExp);
  const seen = new Set<string>();
  for (const f of listFiles(baseDir)) if (matchesAny(f, res)) seen.add(f);
  for (const f of listFiles(modifiedDir)) if (matchesAny(f, res)) seen.add(f);

  const out: FileChange[] = [];
  for (const rel of [...seen].sort()) {
    const before = readOrNull(baseDir, rel);
    const after = readOrNull(modifiedDir, rel);
    if (before === after) continue; // unchanged (both null can't happen — path came from one side)
    out.push({ path: rel, before, after });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 3-way line merge (diff3-style), hand-rolled — no git, no deps.
//
// Given base / ours / theirs as line arrays, we align ours↔base and theirs↔base
// via an LCS-based diff, then walk both alignments in lockstep over the base:
//   - a base region unchanged on ONE side takes the OTHER side's version.
//   - a base region changed on BOTH sides identically → that (shared) version.
//   - a base region changed on BOTH sides differently → CONFLICT.
// This is the classic diff3 merge; it composes non-overlapping edits and flags
// genuinely overlapping ones.
// ───────────────────────────────────────────────────────────────────────────

/** LCS of two line arrays → the aligned edit script as a list of ops. Each op is
 *  a run classified as "equal" | "delete" (in a only) | "insert" (in b only). */
type DiffOp = { tag: "equal" | "delete" | "insert"; a: string[]; b: string[] };

function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length, m = b.length;
  // LCS length table (O(n·m) — fine for source files at these sizes).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  const push = (tag: DiffOp["tag"], av: string[], bv: string[]) => {
    const last = ops[ops.length - 1];
    if (last && last.tag === tag) { last.a.push(...av); last.b.push(...bv); }
    else ops.push({ tag, a: av, b: bv });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push("equal", [a[i]], [b[j]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push("delete", [a[i]], []); i++; }
    else { push("insert", [], [b[j]]); j++; }
  }
  while (i < n) { push("delete", [a[i]], []); i++; }
  while (j < m) { push("insert", [], [b[j]]); j++; }
  return ops;
}

/** Split into lines while remembering whether the text ended with a newline, so
 *  we can round-trip exactly. Empty string → [] (no lines). */
function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === "") return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), trailingNewline };
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return "";
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/**
 * Per-base-line side-diffs, expressed as: for each base line index, what OURS /
 * THEIRS mapped it to, plus any pure-insertions anchored before a base index.
 * We reduce the two diffs to a per-base "hunk" walk.
 */
interface SideChange {
  // aligned to base: baseChunks[k] = the base lines of chunk k;
  // sideChunks[k]   = what this side replaced them with (equal ⇒ identical).
  // Insertions carry an empty base chunk anchored at a position.
  ops: DiffOp[];
}

function sideChange(base: string[], side: string[]): SideChange {
  return { ops: diffLines(base, side) };
}

const CONFLICT_START = "<<<<<<< ours";
const CONFLICT_MID = "=======";
const CONFLICT_END = ">>>>>>> theirs";

/**
 * diff3 merge of base/ours/theirs → { ok, body, conflict }. Non-overlapping
 * edits compose; overlapping edits emit git-style conflict markers and set
 * conflict=true.
 */
function merge3(baseText: string, oursText: string, theirsText: string): { conflict: boolean; body: string } {
  // Trivial fast-paths.
  if (oursText === theirsText) return { conflict: false, body: oursText };
  if (baseText === oursText) return { conflict: false, body: theirsText };
  if (baseText === theirsText) return { conflict: false, body: oursText };

  const b = splitLines(baseText);
  const o = splitLines(oursText);
  const t = splitLines(theirsText);
  const trailingNewline = o.trailingNewline || t.trailingNewline || b.trailingNewline;

  const ours = sideChange(b.lines, o.lines).ops;
  const theirs = sideChange(b.lines, t.lines).ops;

  // Convert each side's op list into a per-base-index view: for each base line,
  // the replacement lines emitted by that side, plus inserts that come BEFORE a
  // given base index. We build:
  //   sideRepl[i]  = ours/theirs lines that correspond to base line i (equal or
  //                  delete/replace), or [] if the base line was deleted.
  //   sideInsBefore[i] = extra lines this side inserted immediately before base
  //                  line i (i == base.length means "at end").
  const buildMap = (ops: DiffOp[], baseLen: number) => {
    const repl: (string[] | null)[] = new Array(baseLen).fill(null); // null = untouched-equal placeholder
    const insBefore: string[][] = Array.from({ length: baseLen + 1 }, () => []);
    let bi = 0;
    for (let k = 0; k < ops.length; k++) {
      const op = ops[k];
      if (op.tag === "equal") {
        for (let x = 0; x < op.a.length; x++) { repl[bi] = [op.b[x]]; bi++; }
      } else if (op.tag === "delete") {
        // These base lines were removed; look ahead for an adjacent insert to
        // treat delete+insert as a REPLACE of the whole run.
        const del = op.a;
        let ins: string[] = [];
        if (ops[k + 1]?.tag === "insert") { ins = ops[k + 1].b; k++; }
        // Distribute: first deleted base line carries the whole replacement, the
        // rest carry [] (fully consumed). This keeps replacements anchored.
        for (let x = 0; x < del.length; x++) { repl[bi] = x === 0 ? ins : []; bi++; }
      } else { // pure insert not preceded by a delete: anchor before current base index
        insBefore[bi].push(...op.b);
      }
    }
    return { repl, insBefore };
  };

  const O = buildMap(ours, b.lines.length);
  const T = buildMap(theirs, b.lines.length);

  const out: string[] = [];
  let conflict = false;

  const emitInsBefore = (i: number) => {
    const oi = O.insBefore[i], ti = T.insBefore[i];
    if (oi.length && ti.length) {
      if (oi.join("\n") === ti.join("\n")) out.push(...oi); // same insertion both sides
      else {
        conflict = true;
        out.push(CONFLICT_START, ...oi, CONFLICT_MID, ...ti, CONFLICT_END);
      }
    } else if (oi.length) out.push(...oi);
    else if (ti.length) out.push(...ti);
  };

  for (let i = 0; i < b.lines.length; i++) {
    emitInsBefore(i);
    const oRepl = O.repl[i]; // what ours mapped base line i to
    const tRepl = T.repl[i];
    const baseLine = [b.lines[i]];
    const oVal = oRepl ?? baseLine; // null ⇒ untouched (equals base)
    const tVal = tRepl ?? baseLine;
    const oChanged = oRepl !== null && oVal.join("\n") !== baseLine.join("\n");
    const tChanged = tRepl !== null && tVal.join("\n") !== baseLine.join("\n");

    if (!oChanged && !tChanged) out.push(...baseLine);
    else if (oChanged && !tChanged) out.push(...oVal);
    else if (!oChanged && tChanged) out.push(...tVal);
    else {
      // both changed this base line
      if (oVal.join("\n") === tVal.join("\n")) out.push(...oVal); // identical change
      else {
        conflict = true;
        out.push(CONFLICT_START, ...oVal, CONFLICT_MID, ...tVal, CONFLICT_END);
      }
    }
  }
  emitInsBefore(b.lines.length); // trailing inserts at EOF

  return { conflict, body: joinLines(out, trailingNewline) };
}

// ───────────────────────────────────────────────────────────────────────────
// applyChanges
// ───────────────────────────────────────────────────────────────────────────

function ensureDir(p: string): void {
  mkdirSync(dirname(p), { recursive: true });
}

/**
 * Apply a set of FileChanges onto `targetDir`, COMPOSING with whatever is
 * already there via a per-file 3-way merge:
 *   base   = change.before   (the state the change was computed against)
 *   theirs = change.after    (the change we want to land)
 *   ours   = targetDir/path's CURRENT content (may already carry a sibling
 *            cluster's edit)
 * A clean merge writes the file. A genuine line-conflict is collected and
 * returned; on ANY conflict the function reports ok:false and leaves the
 * conflicted files UNWRITTEN (callers decide whether to materialise markers) —
 * non-conflicting files ARE written, matching how git applies what it can.
 *
 * Creation / deletion handling:
 *   before=null (created)  → if target lacks the file, write after; if target
 *     already HAS it, 3-way merge with base="" so an identical create is a
 *     no-op and a divergent create conflicts.
 *   after=null  (deleted)  → delete from target if its current content matches
 *     `before`; if the target diverged from `before`, that's a modify/delete
 *     conflict (reported, file kept).
 */
export function applyChanges(targetDir: string, changes: FileChange[]): ApplyResult {
  const conflicts: Conflict[] = [];
  // Stage writes so a late conflict doesn't leave a half-applied file for a
  // change we're going to report as failed. Deletions staged separately.
  const writes: { path: string; body: string }[] = [];
  const deletes: string[] = [];

  for (const ch of changes) {
    const abs = join(targetDir, ch.path);
    const current = existsSync(abs) ? (() => { try { return readFileSync(abs, "utf8"); } catch { return null; } })() : null;

    // ── deletion ──
    if (ch.after === null) {
      if (current === null) continue; // already absent → nothing to do
      if (ch.before !== null && current === ch.before) { deletes.push(ch.path); continue; }
      if (ch.before === null) { deletes.push(ch.path); continue; } // best-effort delete of an unknown-base file
      // target diverged from the base we deleted against → modify/delete conflict.
      conflicts.push({
        path: ch.path,
        reason: "modify/delete conflict: target was modified but the change deletes the file",
        merged: `${CONFLICT_START}\n${current}${current.endsWith("\n") ? "" : "\n"}${CONFLICT_MID}\n${CONFLICT_END}\n`,
      });
      continue;
    }

    // ── creation / modification ──
    if (current === null) {
      // target lacks the file: just materialise `after` (base is irrelevant when
      // there's nothing to compose with).
      writes.push({ path: ch.path, body: ch.after });
      continue;
    }

    // target HAS the file → 3-way compose. base = change.before (may be null for
    // a create-on-create; treat null base as empty string).
    const base = ch.before ?? "";
    const merged = merge3(base, current, ch.after);
    if (merged.conflict) {
      conflicts.push({ path: ch.path, reason: "3-way merge conflict", merged: merged.body });
    } else {
      writes.push({ path: ch.path, body: merged.body });
    }
  }

  if (conflicts.length) return { ok: false, conflicts };

  // No conflicts → commit staged writes + deletes.
  for (const w of writes) { ensureDir(join(targetDir, w.path)); writeFileSync(join(targetDir, w.path), w.body); }
  for (const d of deletes) { try { rmSync(join(targetDir, d), { force: true }); } catch { /* best-effort */ } }
  return { ok: true };
}

// Exported for tests / callers that want just the merge primitive.
export const _internal = { merge3, diffLines, globToRegExp, splitLines, joinLines };

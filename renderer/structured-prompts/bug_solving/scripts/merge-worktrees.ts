#!/usr/bin/env npx tsx
/**
 * merge-worktrees.ts — programmatic merge of bug_solving worker worktrees.
 *
 * You name the worktrees to merge; everything else is automatic:
 *   1. Extract each worktree's converter diff (renderer/html2slides/*.ts only,
 *      vs the base ref the workers forked from — uncommitted worker edits).
 *   2. Apply them to the current working tree, resolving overlaps with a 3-way
 *      merge (two workers editing the same file at different points combine
 *      cleanly; a real line conflict aborts loudly).
 *   3. Derive the INTENDED slide set from each worktree's recorded
 *      before/pptx/<slide>.pptx filenames (ground truth of what it targeted).
 *   4. Typecheck (tsc --noEmit) the merged tree.
 *   5. Run the pixel-perfect merge gate (merge-gate.ts) with --intended = the
 *      union — renders the whole deck HEAD-vs-merged and BLOCKS if any slide
 *      outside the intended set changed.
 *   6. Report JSON; optionally --commit (only if gate PASS + tsc clean) or
 *      --rate (boot a filtered rating UI on the changed slides when BLOCKED).
 *
 * USAGE
 *   npx tsx merge-worktrees.ts <wt> [<wt> ...] [flags]
 *   <wt> = a worktree PATH, or a task name (globs .claude/worktrees/bs-<name>-*,
 *          newest match wins). e.g. `device-frame-ring` or the full dir.
 *
 * FLAGS
 *   --base <ref>   commit the workers forked from (default: current HEAD).
 *   --clean        reset renderer/html2slides/*.ts to <base> before applying
 *                  (reproducible; discards any pre-existing uncommitted converter
 *                  edits — asks nothing, so only pass when you mean it).
 *   --commit       git-commit the merge iff the gate PASSES and tsc is clean.
 *   --rate         on BLOCK, render the changed slides + boot a filtered rating UI.
 *   --port <n>     rating UI port (default 4731).
 *   --no-gate      apply + tsc only, skip the render gate (fast dry-run).
 *   --out <dir>    scratch dir (default /tmp/merge-worktrees).
 *   --repo <dir>   repo root (default process.cwd()).
 *
 * EXIT: 0 PASS (safe / committed) · 1 BLOCK (unexpected slide changed) ·
 *       2 setup / patch-conflict / tsc error.
 */
import { execSync, execFileSync } from "node:child_process";
import { existsSync, readdirSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from "node:fs";
import { resolve, basename, join } from "node:path";

type Args = {
  worktrees: string[]; base?: string; clean: boolean; commit: boolean;
  rate: boolean; port: number; gate: boolean; out: string; repo: string;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { worktrees: [], clean: false, commit: false, rate: false, port: 4731, gate: true, out: "/tmp/merge-worktrees", repo: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--base") a.base = argv[++i];
    else if (t === "--clean") a.clean = true;
    else if (t === "--commit") a.commit = true;
    else if (t === "--rate") a.rate = true;
    else if (t === "--port") a.port = Number(argv[++i]);
    else if (t === "--no-gate") a.gate = false;
    else if (t === "--out") a.out = argv[++i];
    else if (t === "--repo") a.repo = resolve(argv[++i]);
    else if (t.startsWith("--")) fail(`unknown flag: ${t}`);
    else a.worktrees.push(t);
  }
  if (!a.worktrees.length) fail("name at least one worktree (path or task name)");
  return a;
}

function fail(msg: string): never { console.error(`❌ ${msg}`); process.exit(2); }
function sh(cmd: string, cwd: string): string { return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }

/** Resolve a worktree spec to an absolute dir: a path, or newest bs-<name>-* match. */
function resolveWorktree(spec: string, repo: string): string {
  if (existsSync(spec) && statSync(spec).isDirectory()) return resolve(spec);
  const p = resolve(repo, spec);
  if (existsSync(p) && statSync(p).isDirectory()) return p;
  const wtRoot = resolve(repo, ".claude", "worktrees");
  if (!existsSync(wtRoot)) fail(`no .claude/worktrees and '${spec}' is not a dir`);
  const name = spec.replace(/^bs-/, "");
  const matches = readdirSync(wtRoot)
    .filter((d) => d === `bs-${name}` || d.startsWith(`bs-${name}-`))
    .map((d) => join(wtRoot, d))
    .sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs);
  if (!matches.length) fail(`no worktree matching '${spec}' under ${wtRoot}`);
  return matches[0];
}

/** Slides a worktree targeted = the before/pptx/<slide>.pptx it recorded. */
function intendedSlides(wt: string): string[] {
  const dir = join(wt, ".bug-solving-scratch", "before", "pptx");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".pptx")).map((f) => basename(f, ".pptx")).sort();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { repo } = args;
  const base = args.base ?? sh("git rev-parse HEAD", repo).trim();
  rmSync(args.out, { recursive: true, force: true });
  mkdirSync(join(args.out, "patches"), { recursive: true });

  const wts = args.worktrees.map((s) => resolveWorktree(s, repo));
  console.error(`Base: ${base.slice(0, 12)}   Worktrees (${wts.length}):`);
  const intended = new Set<string>();
  const plan: { wt: string; patch: string; slides: string[]; lines: number }[] = [];
  for (const wt of wts) {
    const patch = sh(`git -C "${wt}" diff ${base} -- 'renderer/html2slides/*.ts'`, repo);
    const slides = intendedSlides(wt);
    slides.forEach((s) => intended.add(s));
    const pfile = join(args.out, "patches", `${basename(wt)}.patch`);
    writeFileSync(pfile, patch);
    plan.push({ wt, patch: pfile, slides, lines: patch.split("\n").length });
    console.error(`  • ${basename(wt)}  →  slides=[${slides.join(",") || "?"}]  (${patch ? patch.split("\n").length : 0} diff lines)`);
    if (!patch.trim()) console.error(`    ⚠ empty converter diff — worker made no .ts change (skipped)`);
  }
  const intendedCsv = [...intended].sort().join(",");
  console.error(`Intended (allowed-to-change) slides: ${intendedCsv || "(none!)"}`);

  if (args.clean) {
    console.error("--clean: resetting renderer/html2slides/*.ts to base");
    sh(`git checkout ${base} -- renderer/html2slides`, repo);
  }

  // Apply each patch with a 3-way merge into the working tree + index, so
  // overlapping edits from sibling worktrees combine instead of clobbering.
  const conflicts: string[] = [];
  for (const p of plan) {
    if (!readFileSync(p.patch, "utf8").trim()) continue;
    try {
      // 3-way apply (composes overlapping-context hunks from sibling worktrees),
      // then stage so the index matches the tree — otherwise the NEXT patch's
      // --3way base-reconstruction fails with "does not match index".
      execFileSync("git", ["apply", "--3way", "--whitespace=nowarn", p.patch], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
      execFileSync("git", ["add", "--", "renderer/html2slides"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
      console.error(`  ✓ applied ${basename(p.wt)}`);
    } catch (e) {
      // --3way leaves conflict markers on a real conflict; surface which file.
      const msg = (e as { stderr?: Buffer }).stderr?.toString() || String(e);
      conflicts.push(`${basename(p.wt)}: ${msg.split("\n")[0]}`);
      console.error(`  ✗ CONFLICT applying ${basename(p.wt)} — ${msg.split("\n")[0]}`);
    }
  }
  if (conflicts.length) {
    writeResult(args, { base, plan: summ(plan), intended: [...intended], conflicts, applied: false });
    fail(`patch conflict(s): ${conflicts.length}. Working tree left with markers for manual resolve.`);
  }

  // Typecheck — but count ONLY converter errors. A fresh git worktree lacks the
  // full node_modules, so `tsc` reports spurious "cannot find module" errors in
  // unrelated packages (puppeteer/vitest etc.); those exist at base too and are
  // not our merge. The merge only touches renderer/html2slides, so scope there.
  let tscErrors = 0;
  try { execSync("npx tsc --noEmit", { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) {
    const outTxt = (e as { stdout?: Buffer }).stdout?.toString() || "";
    tscErrors = outTxt.split("\n").filter((l) => /error TS/.test(l) && l.includes("renderer/html2slides/")).length;
  }
  console.error(`tsc (converter-scoped): ${tscErrors} error(s)`);

  if (!args.gate) {
    writeResult(args, { base, plan: summ(plan), intended: [...intended], conflicts: [], applied: true, tscErrors, gate: null });
    console.error(tscErrors ? "⚠ applied but tsc has errors (gate skipped)" : "✓ applied, tsc clean (gate skipped)");
    process.exit(tscErrors ? 2 : 0);
  }

  // Pixel-perfect gate.
  const gateOut = join(args.out, "gate");
  const gateScript = "renderer/structured-prompts/bug_solving/scripts/merge-gate.ts";
  console.error(`Running merge gate (whole deck HEAD vs merged, intended=${intendedCsv}) …`);
  let gateRc = 0;
  try { execSync(`npx tsx ${gateScript} --intended "${intendedCsv}" --out "${gateOut}" --repo "${repo}"`, { cwd: repo, stdio: "inherit" }); }
  catch (e) { gateRc = (e as { status?: number }).status ?? 1; }
  const gateJson = join(gateOut, "merge-gate.json");
  const gate = existsSync(gateJson) ? JSON.parse(readFileSync(gateJson, "utf8")) : { pass: gateRc === 0 };

  writeResult(args, { base, plan: summ(plan), intended: [...intended], conflicts: [], applied: true, tscErrors, gate });

  if (gate.pass && tscErrors === 0) {
    console.error("✅ GATE PASS — only intended slides changed, tsc clean.");
    if (args.commit) {
      sh(`git add renderer/html2slides`, repo);
      const names = plan.map((p) => basename(p.wt).replace(/^bs-|-\d+$/g, "")).join(", ");
      const msg = `SashaSlides: merge worker fixes (${names}) — gate-clean, changed: ${(gate.changed || []).join(",")}`;
      execFileSync("git", ["commit", "-q", "-m", msg, "-m", "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"], { cwd: repo });
      console.error(`✓ committed: ${sh("git rev-parse --short HEAD", repo).trim()}`);
    } else {
      console.error("   (dry: re-run with --commit to land it.)");
    }
    process.exit(0);
  }

  console.error(`❌ GATE BLOCK — unexpected changed slides: ${(gate.unexpected || []).join(",") || "?"}${tscErrors ? ` | tsc errors: ${tscErrors}` : ""}`);
  if (args.rate && gate.unexpected?.length) bootRatingUi(args, gate.changed || []);
  process.exit(1);
}

function summ(plan: { wt: string; slides: string[]; lines: number }[]) {
  return plan.map((p) => ({ worktree: basename(p.wt), slides: p.slides, diffLines: p.lines }));
}
function writeResult(args: Args, obj: unknown) { writeFileSync(join(args.out, "merge-worktrees.json"), JSON.stringify(obj, null, 2)); }

function bootRatingUi(args: Args, changed: string[]) {
  const csv = changed.join(",");
  const rdir = resolve(args.repo, ".sxs-merge-anomaly");
  rmSync(rdir, { recursive: true, force: true }); mkdirSync(rdir, { recursive: true });
  console.error(`Rendering changed slides (${csv}) to Slides for review …`);
  try {
    execSync(`cd renderer && npx tsx structured-prompts/bug_solving/scripts/record-rendering.ts --mode full ` +
      `--fixtures "${args.repo}/renderer/html2slides/e2e/fixtures" --slides "${csv}" --title merge-anomaly --out "${rdir}"`,
      { cwd: args.repo, stdio: "inherit" });
  } catch { /* best-effort */ }
  try { execSync(`lsof -ti:${args.port} | xargs -r kill`, { stdio: "ignore" }); } catch { /* none */ }
  execSync(`setsid npx tsx renderer/html2slides/rating-server.ts "${rdir}" --port ${args.port} ` +
    `--filter-slides "${csv}" --slides-dir "${rdir}/thumbs" --originals-dir "${rdir}/originals" ` +
    `--history-dir "${args.repo}/.bug-solving-history" > /tmp/sxs-merge-anomaly.log 2>&1 < /dev/null & disown`,
    { cwd: args.repo, shell: "/bin/bash" });
  console.error(`   review changed slides at http://localhost:${args.port} (do NOT commit until resolved)`);
}

main();

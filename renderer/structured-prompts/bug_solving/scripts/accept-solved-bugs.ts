#!/usr/bin/env npx tsx
/**
 * accept-solved-bugs.ts — fully automatic acceptance of GREEN bug_solving fixes.
 *
 * The safety invariant the user asked for: green fixes land in an INTERMEDIATE
 * integration worktree, and that worktree is promoted to the target branch ONLY
 * if the pixel-perfect gate finds NO regression on any unrelated slide — else the
 * whole integration worktree is DISCARDED and the target branch is never touched.
 *
 * Flow:
 *   1. Classify every bs-* worker worktree from the candidate rating ledger:
 *        green   = EVERY slide it targeted is rated `good`  → MERGED
 *        red     = at least one slide rated `bad`           → NOT merged
 *        neutral = at least one slide unrated (no bad)      → IGNORED + WARNING
 *      Only green is merged; red is skipped; neutral is never merged and never
 *      auto-discarded — it's surfaced as a warning so it can be rated.
 *      (a worktree's slides = its recorded before/pptx/<slide>.pptx names).
 *   2. Create an intermediate worktree off <base>:  .claude/worktrees/accept-<ts>
 *      on branch  sp/accept-<ts>.
 *   3. Inside it, run merge-worktrees.ts on the GREEN worktrees (--clean --commit):
 *      it applies their diffs (3-way), typechecks, and runs the pixel gate with
 *      --intended = the union of green slides. Gate PASS ⇒ only intended slides
 *      changed. Gate BLOCK ⇒ an unrelated slide regressed.
 *   4. PASS + --yes  → promote: fast-forward/merge the integration branch into
 *      <target>, then remove the intermediate worktree. (--rerecord renders the
 *      just-merged slides on the target for the canonical re-rate.)
 *      BLOCK / conflict → DISCARD the intermediate worktree (git worktree remove
 *      --force) + delete its branch. Target branch untouched.
 *   5. --discard-red removes the red/unrated worktrees too.
 *
 * Without --yes it's a DRY RUN: it still builds + gates the intermediate worktree
 * (so you see the real verdict) but neither promotes nor discards — leaving the
 * worktree for inspection.
 *
 * FLAGS
 *   --base <ref>      workers' fork point / integration base (default HEAD)
 *   --target <ref>    branch to promote into on success (default: current branch)
 *   --ledger <file>   candidate ratings (default .bug-solving-history/candidates.json)
 *   --worktrees <dir> default .claude/worktrees
 *   --yes             actually promote-or-discard (default: dry run)
 *   --rerecord        after a successful promote, render the merged slides on target
 *   --discard-red     remove red/unrated worktrees at the end
 *   --out <dir>       scratch (default /tmp/accept-solved-bugs)
 *   --repo <dir>      repo root (default cwd)
 *   --ts <stamp>      integration id (default: unix seconds; scripts can't call Date.now safely in some hosts)
 *
 * EXIT: 0 promoted (or dry-run PASS) · 1 BLOCK/discarded · 2 setup/conflict · 3 nothing green.
 */
import { execSync, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { resolve, join, basename } from "node:path";

type Cls = "green" | "red" | "neutral";
interface WT { dir: string; task: string; slides: string[]; cls: Cls; bad: string[]; missing: string[]; }

function fail(m: string): never { console.error(`❌ ${m}`); process.exit(2); }
function sh(cmd: string, cwd: string): string { return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
function tryRun(file: string, a: string[], cwd: string): number {
  try { execFileSync(file, a, { cwd, stdio: "inherit" }); return 0; }
  catch (e) { return (e as { status?: number }).status ?? 1; }
}

const argv = process.argv.slice(2);
const opt: Record<string, string> = {}; const flags = new Set<string>();
for (let i = 0; i < argv.length; i++) {
  const t = argv[i];
  if (["--yes", "--rerecord", "--discard-red"].includes(t)) flags.add(t);
  else if (t.startsWith("--")) opt[t.slice(2)] = argv[++i];
  else fail(`unexpected arg ${t}`);
}
const repo = resolve(opt.repo ?? process.cwd());
const base = opt.base ?? sh("git rev-parse HEAD", repo).trim();
const target = opt.target ?? sh("git rev-parse --abbrev-ref HEAD", repo).trim();
const ledgerPath = resolve(repo, opt.ledger ?? ".bug-solving-history/candidates.json");
const wtRoot = resolve(repo, opt.worktrees ?? ".claude/worktrees");
const out = opt.out ?? "/tmp/accept-solved-bugs";
const ts = opt.ts ?? String(Math.floor(Number(sh("date +%s", repo).trim())));
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });

// --- 1. classify ------------------------------------------------------------
const ledger: Record<string, { status?: string }> = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : {};
function slidesOf(dir: string): string[] {
  const p = join(dir, ".bug-solving-scratch", "before", "pptx");
  return existsSync(p) ? readdirSync(p).filter((f) => f.endsWith(".pptx")).map((f) => basename(f, ".pptx")).sort() : [];
}
const wts: WT[] = existsSync(wtRoot) ? readdirSync(wtRoot).filter((d) => d.startsWith("bs-")).map((d) => {
  const dir = join(wtRoot, d); const slides = slidesOf(dir);
  const bad = slides.filter((s) => ledger[s]?.status === "bad");
  const missing = slides.filter((s) => !ledger[s]?.status);
  const cls: Cls = bad.length ? "red" : missing.length ? "neutral" : slides.length ? "green" : "neutral";
  return { dir, task: d.replace(/^bs-|-\d+$/g, ""), slides, cls, bad, missing };
}) : [];

console.error(`Ledger: ${ledgerPath}\nBase: ${base.slice(0, 12)}  Target: ${target}\n`);
for (const w of wts) console.error(`  [${w.cls.toUpperCase().padEnd(7)}] ${basename(w.dir)}  slides=[${w.slides.join(",") || "?"}]` +
  `${w.bad.length ? `  bad=${w.bad.join(",")}` : ""}${w.missing.length ? `  unrated=${w.missing.join(",")}` : ""}`);
const neutral = wts.filter((w) => w.cls === "neutral");
const red = wts.filter((w) => w.cls === "red");
if (neutral.length) console.error(`\n⚠  ${neutral.length} NEUTRAL (unrated) worktree(s) — IGNORED (not merged, not discarded). Rate their candidates, then re-run:\n` +
  neutral.map((w) => `     • ${w.task}  (unrated slides: ${w.missing.join(",") || "?"})`).join("\n"));
if (red.length) console.error(`\n⚠  ${red.length} RED worktree(s) — NOT merged: ${red.map((w) => `${w.task}(bad:${w.bad.join(",")})`).join(", ")}`);
const green = wts.filter((w) => w.cls === "green");
const greenSlides = [...new Set(green.flatMap((w) => w.slides))].sort();
writeFileSync(join(out, "classification.json"), JSON.stringify({ base, target, wts: wts.map((w) => ({ task: w.task, cls: w.cls, slides: w.slides })) }, null, 2));

if (!green.length) { console.error("\nNothing green to accept."); if (flags.has("--discard-red")) discardRed(); process.exit(3); }
console.error(`\nGreen worktrees (${green.length}): ${green.map((w) => w.task).join(", ")}\nGreen slides: ${greenSlides.join(",")}`);

// --- 2. intermediate worktree ----------------------------------------------
const intBranch = `sp/accept-${ts}`;
const intDir = join(wtRoot, `accept-${ts}`);
if (existsSync(intDir)) { try { sh(`git worktree remove --force "${intDir}"`, repo); } catch { /* stale */ } }
sh(`git worktree add -b ${intBranch} "${intDir}" ${base}`, repo);
console.error(`\nIntermediate worktree: ${intDir} (branch ${intBranch})`);

// --- 3. merge green fixes into it + gate ------------------------------------
const mwt = "renderer/structured-prompts/bug_solving/scripts/merge-worktrees.ts";
const rc = tryRun("npx", ["tsx", resolve(repo, mwt), "--repo", intDir, "--base", base, "--clean", "--commit",
  "--out", join(out, "merge"), ...green.map((w) => w.dir)], repo);
const mwtJson = join(out, "merge", "merge-worktrees.json");
const mwtRes = existsSync(mwtJson) ? JSON.parse(readFileSync(mwtJson, "utf8")) : {};
const gate = mwtRes.gate ?? null;

// --- 4. promote or discard --------------------------------------------------
function discardInt(why: string) {
  console.error(`\n🗑  DISCARD intermediate worktree — ${why}`);
  try { sh(`git worktree remove --force "${intDir}"`, repo); } catch { /* */ }
  try { sh(`git branch -D ${intBranch}`, repo); } catch { /* */ }
}
function discardRed() {
  // Only RED worktrees are removed. NEUTRAL (unrated) worktrees are left intact
  // so the user can still rate them — they were only warned about, never merged.
  for (const w of wts.filter((x) => x.cls === "red")) {
    try { sh(`git worktree remove --force "${w.dir}"`, repo); console.error(`  removed red ${basename(w.dir)}`); } catch { /* */ }
  }
}

const verdict = { ts, base, target, green: green.map((w) => w.task), greenSlides, gate, mergeRc: rc,
  promoted: false, discarded: false };

if (rc !== 0) {
  const why = rc === 1 ? `gate BLOCK — unexpected slides changed: ${(gate?.unexpected || []).join(",") || "?"}` : `merge failed (rc=${rc})`;
  if (flags.has("--yes")) { discardInt(why); verdict.discarded = true; }
  else console.error(`\n(dry run) ${why}. Intermediate worktree LEFT at ${intDir} for inspection — it would be DISCARDED with --yes.`);
  writeFileSync(join(out, "accept.json"), JSON.stringify(verdict, null, 2));
  if (flags.has("--discard-red")) discardRed();
  console.error(`\n❌ Not promoted. Target ${target} untouched.`);
  process.exit(1);
}

// gate PASSED (only intended slides changed).
console.error(`\n✅ Gate PASS — only intended green slides changed: ${(gate?.changed || greenSlides).join(",")}`);
if (!flags.has("--yes")) {
  console.error(`(dry run) Would promote ${intBranch} → ${target}. Re-run with --yes to land it. Intermediate worktree left at ${intDir}.`);
  writeFileSync(join(out, "accept.json"), JSON.stringify(verdict, null, 2));
  process.exit(0);
}

// promote: bring the integration commit onto target, then remove the worktree.
const cur = sh("git rev-parse --abbrev-ref HEAD", repo).trim();
if (cur !== target) sh(`git checkout ${target}`, repo);
let promoteMsg = "";
try { promoteMsg = sh(`git merge --ff-only ${intBranch}`, repo); }
catch { promoteMsg = sh(`git merge --no-ff -m "SashaSlides: accept solved bugs [${green.map((w) => w.task).join(", ")}] → ${target} (gate-clean: ${greenSlides.join(",")})" ${intBranch}`, repo); }
console.error(`\n🚀 Promoted to ${target}: ${sh("git rev-parse --short HEAD", repo).trim()}\n${promoteMsg.trim()}`);
verdict.promoted = true;
sh(`git worktree remove --force "${intDir}"`, repo);
try { sh(`git branch -d ${intBranch}`, repo); } catch { /* merged, ignore */ }
if (cur !== target) sh(`git checkout ${cur}`, repo);
if (flags.has("--discard-red")) discardRed();

if (flags.has("--rerecord")) {
  console.error(`\nRe-recording merged slides on ${target} for canonical re-rate: ${greenSlides.join(",")}`);
  tryRun("bash", ["-lc", `cd "${repo}/renderer" && npx tsx structured-prompts/bug_solving/scripts/record-rendering.ts ` +
    `--mode full --fixtures html2slides/e2e/fixtures --slides "${greenSlides.join(",")}" --title accept-${ts} --out /tmp/sxs-accept`], repo);
  console.error(`   rendered → /tmp/sxs-accept (boot rating-server.ts on it for the canonical good/bad re-rate)`);
}
writeFileSync(join(out, "accept.json"), JSON.stringify(verdict, null, 2));
console.error(`\n✅ Done. Result: ${join(out, "accept.json")}`);
process.exit(0);

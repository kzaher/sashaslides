#!/usr/bin/env npx tsx
/**
 * merge-gate.ts — pixel-perfect merge gate for html2slides converter changes.
 *
 * Enforces the merging protocol: a fix you merge to main may ONLY change the
 * render of the slides it was supposed to fix. ANY other slide whose render
 * changes is a regression and BLOCKS the merge.
 *
 * It renders the WHOLE fixture deck twice — once at HEAD (baseline) and once
 * with the working-tree changes (post) — both SEQUENTIALLY (RECORD_CONCURRENCY=1,
 * which is byte-deterministic; concurrent renders race on web-font load and
 * produce phantom diffs) — then structural-diffs them per slide. Because a
 * byte-identical pptx renders pixel-identically in Google Slides, an empty
 * structural diff IS a pixel-perfect guarantee; a non-empty diff on a slide
 * outside the intended set is a (potential) visible regression to review.
 *
 * USAGE
 *   # working tree currently holds ONLY the merge under test (uncommitted):
 *   npx tsx merge-gate.ts --intended slide_19,slide_21,slide_27,slide_30
 *
 * FLAGS
 *   --intended <csv>   slides the merge is EXPECTED to change (the green cluster
 *                      slides). Required. Changes here are allowed; everything
 *                      else must be byte-identical.
 *   --fixtures <dir>   default renderer/html2slides/e2e/fixtures
 *   --slides <csv>     limit the deck to these ids (default: every slide_*.html)
 *   --out <dir>        scratch for the two renders + diffs (default /tmp/merge-gate)
 *   --repo <dir>       repo root (default process.cwd())
 *
 * EXIT CODES
 *   0  PASS — every changed slide is in --intended (safe to commit).
 *   1  BLOCK — at least one UNEXPECTED slide changed (anomaly/regression).
 *   2  usage / setup error.
 *
 * OUTPUT
 *   <out>/merge-gate.json = { pass, intended, changed, unexpected, missingIntended }
 *   `unexpected` is the BLOCKING set; `missingIntended` warns that an intended
 *   slide did NOT change (the fix may be a no-op). Surface ONLY `changed` slides
 *   in any rating UI — never the whole deck.
 */
import { execSync } from "child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join, resolve } from "path";

type Args = { intended: string; fixtures: string; slides?: string; out: string; repo: string };

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = {
    fixtures: "renderer/html2slides/e2e/fixtures",
    out: "/tmp/merge-gate",
    repo: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--intended": a.intended = v; i++; break;
      case "--fixtures": a.fixtures = v; i++; break;
      case "--slides": a.slides = v; i++; break;
      case "--out": a.out = v; i++; break;
      case "--repo": a.repo = v; i++; break;
    }
  }
  if (a.intended === undefined) {
    console.error("merge-gate: --intended <csv> is required (the slides the merge is allowed to change)");
    process.exit(2);
  }
  return a as Args;
}

const REC = "renderer/structured-prompts/bug_solving/scripts/record-rendering.ts";
const DIFF = "renderer/structured-prompts/bug_solving/scripts/diff-pptx-pairs.ts";

function deckIds(repo: string, fixtures: string, slidesCsv?: string): string[] {
  if (slidesCsv) return slidesCsv.split(",").map(s => s.trim()).filter(Boolean);
  const dir = resolve(repo, fixtures);
  return readdirSync(dir)
    .filter(f => /^slide_\d+\.html$/.test(f))
    .map(f => f.replace(/\.html$/, ""))
    .sort();
}

/** Deterministic full-deck pptx render (sequential). */
function render(repo: string, fixtures: string, ids: string[], outDir: string): void {
  rmSync(outDir, { recursive: true, force: true });
  const fx = resolve(repo, fixtures);
  execSync(
    `cd ${resolve(repo, "renderer")} && RECORD_CONCURRENCY=1 npx tsx ${resolve(repo, REC)} ` +
    `--mode pptx --fixtures ${fx} --slides "${ids.join(",")}" --out ${outDir}`,
    { stdio: "inherit", maxBuffer: 64 * 1024 * 1024 },
  );
}

function changedSlides(repo: string, baselinePptx: string, postPptx: string, diffOut: string): string[] {
  rmSync(diffOut, { recursive: true, force: true });
  execSync(
    `npx tsx ${resolve(repo, DIFF)} --before ${baselinePptx} --after ${postPptx} --out ${diffOut}`,
    { stdio: "inherit", maxBuffer: 64 * 1024 * 1024, cwd: resolve(repo, "renderer/structured-prompts/bug_solving/scripts") },
  );
  const out: string[] = [];
  for (const f of readdirSync(diffOut)) {
    if (!f.endsWith(".diff")) continue;
    const sid = f.replace(/\.diff$/, "");
    const txt = readFileSync(join(diffOut, f), "utf-8");
    if (!/no structural differences/i.test(txt)) out.push(sid);
  }
  return out.sort();
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  mkdirSync(a.out, { recursive: true });
  const intended = new Set(a.intended.split(",").map(s => s.trim()).filter(Boolean));
  const ids = deckIds(a.repo, a.fixtures, a.slides);
  console.log(`[merge-gate] deck=${ids.length} slides, intended-to-change=${[...intended].join(",") || "(none)"}`);

  // 1) POST = working tree (the merge under test).
  console.log("[merge-gate] rendering POST (working tree) …");
  render(a.repo, a.fixtures, ids, join(a.out, "post"));

  // 2) BASELINE = HEAD. Stash the working tree, render, restore. Only stash if
  //    the tree is dirty; use a unique label so we only pop our own stash.
  const dirty = execSync(`git -C ${a.repo} status --porcelain`, { encoding: "utf-8" }).trim().length > 0;
  let stashed = false;
  if (dirty) {
    // Tracked-only stash (NOT -u): the converter render depends only on tracked
    // source; stashing untracked files would move render outputs / live SxS dirs.
    execSync(`git -C ${a.repo} stash push -m merge-gate-baseline`, { stdio: "inherit" });
    stashed = /merge-gate-baseline/.test(execSync(`git -C ${a.repo} stash list`, { encoding: "utf-8" }));
  }
  try {
    console.log("[merge-gate] rendering BASELINE (HEAD) …");
    render(a.repo, a.fixtures, ids, join(a.out, "baseline"));
  } finally {
    if (stashed) execSync(`git -C ${a.repo} stash pop`, { stdio: "inherit" });
  }

  // 3) Structural diff → changed slides → classify.
  const changed = changedSlides(a.repo, join(a.out, "baseline/pptx"), join(a.out, "post/pptx"), join(a.out, "diff"));
  const unexpected = changed.filter(s => !intended.has(s));
  const missingIntended = [...intended].filter(s => !changed.includes(s)).sort();
  const pass = unexpected.length === 0;

  writeFileSync(join(a.out, "merge-gate.json"),
    JSON.stringify({ pass, intended: [...intended], changed, unexpected, missingIntended }, null, 2));

  console.log("\n================ MERGE GATE ================");
  console.log(`changed slides         : ${changed.join(", ") || "(none)"}`);
  console.log(`intended (allowed)     : ${[...intended].join(", ") || "(none)"}`);
  if (missingIntended.length)
    console.log(`⚠ intended but UNCHANGED: ${missingIntended.join(", ")}  (fix may be a no-op on these)`);
  if (unexpected.length) {
    console.log(`❌ UNEXPECTED changes   : ${unexpected.join(", ")}`);
    console.log(`\nBLOCKED — do NOT merge. Render ONLY these slides to Slides and review in a`);
    console.log(`rating UI filtered to the changed set, e.g.:`);
    console.log(`  rating-server.ts <dir> --filter-slides ${changed.join(",")}`);
    console.log("===========================================");
    process.exit(1);
  }
  console.log(`✅ PASS — only intended slides changed. Safe to commit.`);
  console.log("===========================================");
  process.exit(0);
}

try { main(); }
catch (e) {
  console.error(`[merge-gate] error: ${(e as Error).message}`);
  process.exit(2);
}

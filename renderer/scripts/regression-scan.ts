#!/usr/bin/env npx tsx
/**
 * regression-scan.ts — walk a git revision range, rebuild a set of
 * fixture slides at each commit, and report where per-shape properties
 * change. Answers: "this slide used to render correctly — which commit
 * broke it?"
 *
 * Works by creating a short-lived git worktree at each commit, running
 * record-pptx.sh inside it (so the pptx is built from the code at THAT
 * commit), then parsing the resulting pptx and diffing per-shape
 * snapshots commit-to-commit.
 *
 * Usage:
 *   npx tsx renderer/scripts/regression-scan.ts \
 *     --from <commit-sha-or-ref> --to <commit-sha-or-ref> \
 *     --slides slide_17,slide_25 \
 *     [--fixtures renderer/html2slides/e2e/fixtures] \
 *     [--out /tmp/regression-scan]
 *
 * Output:
 *   <out>/snapshots/<sha>/<slide_id>.json   — per-commit per-slide
 *                                             structural snapshot
 *   <out>/regression-report.json            — ordered list of commits,
 *                                             with per-slide diff lines
 *                                             between consecutive commits
 *   stdout: human summary with a colored "first-change" marker per slide
 */
import { execFileSync, execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { resolve, join } from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const JSZip = require("jszip");

type Args = {
  from: string; to: string; slides: string[];
  fixtures: string; out: string; repoRoot: string;
};

function parseArgs(argv: string[]): Args {
  const a: any = {
    fixtures: "renderer/html2slides/e2e/fixtures",
    out: "/tmp/regression-scan",
    repoRoot: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--from") a.from = argv[++i];
    else if (v === "--to") a.to = argv[++i];
    else if (v === "--slides") a.slides = argv[++i].split(",").map((s: string) => s.trim());
    else if (v === "--fixtures") a.fixtures = argv[++i];
    else if (v === "--out") a.out = resolve(argv[++i]);
    else if (v === "--repo-root") a.repoRoot = resolve(argv[++i]);
  }
  if (!a.from || !a.to || !a.slides) {
    throw new Error("usage: --from <sha> --to <sha> --slides <csv> [--fixtures <dir>] [--out <dir>]");
  }
  return a as Args;
}

const EMU2PX = 1280 / (10 * 914400);

interface ShapeSnap {
  text: string; x: number; y: number; w: number; h: number;
  anchor?: string; align?: string; spcPct?: number; sz?: number;
  b?: boolean; colors?: string[]; insets?: [number, number, number, number];
  lineRects?: number; // number of distinct text runs, proxy for wrap lines
}
interface SlideSnap { shapes: ShapeSnap[]; spcPctDist: Record<string, number>; }

async function snapshotSlide(pptxPath: string): Promise<SlideSnap> {
  const zip = await JSZip.loadAsync(readFileSync(pptxPath));
  const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  const sps = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
  const shapes: ShapeSnap[] = [];
  const spcPctDist: Record<string, number> = {};
  for (const sp of sps) {
    const off = sp.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
    const ext = sp.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    if (!off || !ext) continue;
    const texts = [...sp.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]);
    const snap: ShapeSnap = {
      text: texts.join(""),
      x: Math.round(+off[1] * EMU2PX * 10) / 10,
      y: Math.round(+off[2] * EMU2PX * 10) / 10,
      w: Math.round(+ext[1] * EMU2PX * 10) / 10,
      h: Math.round(+ext[2] * EMU2PX * 10) / 10,
      lineRects: texts.length,
    };
    const anchor = sp.match(/<a:bodyPr[^>]*anchor="(\w+)"/)?.[1]; if (anchor) snap.anchor = anchor;
    const align = sp.match(/<a:pPr[^>]*algn="(\w+)"/)?.[1]; if (align) snap.align = align;
    const spc = sp.match(/<a:spcPct val="(\d+)"/)?.[1];
    if (spc) { snap.spcPct = +spc; spcPctDist[spc] = (spcPctDist[spc] || 0) + 1; }
    const sz = sp.match(/<a:rPr[^>]*sz="(\d+)"/)?.[1]; if (sz) snap.sz = +sz;
    if (/<a:rPr[^>]*b="1"/.test(sp)) snap.b = true;
    const colors = Array.from(new Set([...sp.matchAll(/<a:srgbClr val="([0-9A-Fa-f]+)"/g)].map(m => m[1].toUpperCase())));
    if (colors.length) snap.colors = colors;
    const insets = sp.match(/<a:bodyPr[^>]*lIns="(-?\d+)"[^>]*tIns="(-?\d+)"[^>]*rIns="(-?\d+)"[^>]*bIns="(-?\d+)"/);
    if (insets) snap.insets = [+insets[1], +insets[2], +insets[3], +insets[4]];
    shapes.push(snap);
  }
  return { shapes, spcPctDist };
}

function diffShape(i: number, a: ShapeSnap | undefined, b: ShapeSnap | undefined): string[] {
  const lines: string[] = [];
  if (!a) { lines.push(`  +shape#${i} ${JSON.stringify(b).slice(0, 160)}`); return lines; }
  if (!b) { lines.push(`  -shape#${i} ${JSON.stringify(a).slice(0, 160)}`); return lines; }
  const label = b.text || a.text ? `"${(b.text || a.text).slice(0, 40)}"` : `shape#${i}`;
  const fields: Array<keyof ShapeSnap> = ["text", "x", "y", "w", "h", "anchor", "align", "spcPct", "sz", "b", "colors", "insets", "lineRects"];
  const diffs: string[] = [];
  for (const f of fields) {
    const av = (a as any)[f], bv = (b as any)[f];
    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      diffs.push(`${f}: ${JSON.stringify(av)} → ${JSON.stringify(bv)}`);
    }
  }
  if (diffs.length) lines.push(`  ${label}: ${diffs.join("; ")}`);
  return lines;
}

function diffSlide(before: SlideSnap, after: SlideSnap): string[] {
  const out: string[] = [];
  const n = Math.max(before.shapes.length, after.shapes.length);
  for (let i = 0; i < n; i++) {
    out.push(...diffShape(i, before.shapes[i], after.shapes[i]));
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { from, to, slides, fixtures, out, repoRoot } = args;
  mkdirSync(out, { recursive: true });

  // Resolve commit list (inclusive range).
  const shas = execFileSync("git", ["rev-list", "--reverse", `${from}^..${to}`], { cwd: repoRoot })
    .toString().trim().split("\n").filter(s => s.length === 40);
  if (!shas.length) throw new Error(`no commits in range ${from}..${to}`);
  console.log(`Scanning ${shas.length} commit(s): ${shas[0].slice(0,8)}..${shas[shas.length - 1].slice(0,8)}`);

  const recordScript = resolve(repoRoot, "renderer/structured-prompts/bug_solving/scripts/record-pptx.sh");
  if (!existsSync(recordScript)) throw new Error(`record-pptx.sh not found at ${recordScript}`);

  const snapDir = join(out, "snapshots");
  mkdirSync(snapDir, { recursive: true });
  const commits: Array<{ sha: string; subject: string; snaps: Record<string, SlideSnap> }> = [];

  for (let i = 0; i < shas.length; i++) {
    const sha = shas[i];
    const subject = execFileSync("git", ["log", "-1", "--format=%s", sha], { cwd: repoRoot }).toString().trim();
    console.log(`\n[${i + 1}/${shas.length}] ${sha.slice(0, 8)} — ${subject}`);

    // Worktree at this commit.
    const wtDir = resolve(repoRoot, ".claude/worktrees", `regscan-${sha.slice(0, 8)}-${Date.now()}`);
    execFileSync("git", ["worktree", "add", "--detach", wtDir, sha], { cwd: repoRoot, stdio: "inherit" });
    // Skip commits that predate the renderer/ move — they don't have the
    // record-pptx.sh script at all, so we can't build their pptx.
    const wtScript = resolve(wtDir, "renderer/structured-prompts/bug_solving/scripts/record-pptx.sh");
    if (!existsSync(wtScript)) {
      console.error(`  skipping ${sha.slice(0, 8)}: record-pptx.sh not at this commit`);
      execFileSync("git", ["worktree", "remove", "--force", wtDir], { cwd: repoRoot });
      continue;
    }
    // Symlink node_modules so convert-pptx resolves deps. The renderer-scoped
    // one only exists on commits where renderer/ lives at the repo root —
    // skip any symlink whose parent dir is absent on the worktree.
    for (const rel of ["node_modules", "renderer/node_modules"]) {
      const main = resolve(repoRoot, rel);
      const wt = resolve(wtDir, rel);
      const wtParent = resolve(wt, "..");
      if (!existsSync(main) || !existsSync(wtParent)) continue;
      execSync(`rm -rf "${wt}" && ln -s "${main}" "${wt}"`);
    }

    const pptxDir = join(snapDir, sha, "pptx");
    mkdirSync(pptxDir, { recursive: true });
    try {
      execFileSync("bash", [recordScript, "--slides", slides.join(","), "--label", sha.slice(0, 8), "--out", pptxDir], {
        cwd: wtDir, stdio: "inherit", env: { ...process.env },
      });
    } catch (e: any) {
      console.error(`  FAILED to build at ${sha.slice(0, 8)}: ${e.message}`);
      execFileSync("git", ["worktree", "remove", "--force", wtDir], { cwd: repoRoot });
      continue;
    }

    const snaps: Record<string, SlideSnap> = {};
    for (const sid of slides) {
      const pptx = join(pptxDir, `${sid}.pptx`);
      if (!existsSync(pptx)) { console.error(`  missing pptx for ${sid}`); continue; }
      snaps[sid] = await snapshotSlide(pptx);
      writeFileSync(join(snapDir, sha, `${sid}.json`), JSON.stringify(snaps[sid], null, 2));
    }
    commits.push({ sha, subject, snaps });

    execFileSync("git", ["worktree", "remove", "--force", wtDir], { cwd: repoRoot });
  }

  // Diff consecutive commits per slide.
  console.log(`\n${"=".repeat(60)}\nREGRESSION REPORT (${commits.length} commits)\n${"=".repeat(60)}`);
  const report: Array<{ sha: string; subject: string; perSlide: Record<string, string[]> }> = [];
  for (let i = 1; i < commits.length; i++) {
    const prev = commits[i - 1], cur = commits[i];
    const perSlide: Record<string, string[]> = {};
    let anyChange = false;
    for (const sid of slides) {
      if (!prev.snaps[sid] || !cur.snaps[sid]) continue;
      const diffs = diffSlide(prev.snaps[sid], cur.snaps[sid]);
      if (diffs.length) { perSlide[sid] = diffs; anyChange = true; }
    }
    if (anyChange) {
      console.log(`\n${cur.sha.slice(0, 8)}  ${cur.subject}`);
      for (const sid of Object.keys(perSlide)) {
        console.log(`  ${sid}:`);
        for (const line of perSlide[sid]) console.log(`  ${line}`);
      }
    }
    report.push({ sha: cur.sha, subject: cur.subject, perSlide });
  }
  writeFileSync(join(out, "regression-report.json"), JSON.stringify(report, null, 2));
  console.log(`\nFull report written to ${join(out, "regression-report.json")}`);
}

main().catch(e => { console.error(e); process.exit(1); });

/**
 * diff-pptx-pairs-lib.ts — pure library for producing human-readable
 * OOXML-level diffs per slide between a `before/` and `after/` dir of
 * single-slide pptx files.
 *
 * For each matching <slide_id>.pptx in both dirs, writes:
 *   <out>/<slide_id>.diff      — text unified-ish diff of slide1.xml + theme
 *   <out>/<slide_id>.summary.json  — machine-readable snapshot of
 *     structural differences (shape count, text content, spcPct distribution,
 *     position/size per named text shape).
 *
 * Structural summary lets the per-slide verdict agent answer
 * "does the diff match the expected change?" without having to parse raw XML.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, basename, resolve } from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const JSZip = require("jszip");

export interface ShapeSnapshot {
  text: string;              // concatenated <a:t> contents
  x: number; y: number; w: number; h: number;
  anchor?: string;           // bodyPr anchor ("t"|"ctr"|"b")
  align?: string;            // pPr algn
  spcPct?: number;           // first spcPct val found
  sz?: number;               // first rPr sz (OOXML hundredths of pt)
  b?: boolean;               // bold
  color?: string;            // first solidFill srgbClr
  insets?: [number, number, number, number];  // lIns tIns rIns bIns in EMU
}

export interface SlideSnapshot {
  shapeCount: number;
  spcPctDistribution: Record<string, number>;
  shapes: ShapeSnapshot[];
}

export const EMU_PER_IN = 914400;
export const SLIDE_W_IN = 10;
export const SLIDE_W_PX = 1280;
export const EMU2PX = SLIDE_W_PX / (SLIDE_W_IN * EMU_PER_IN);

export async function snapshotSlide(pptxPath: string): Promise<SlideSnapshot> {
  const zip = await JSZip.loadAsync(readFileSync(pptxPath));
  // Single-slide pptx → always slide1.xml.
  const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  const sps = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
  const shapes: ShapeSnapshot[] = [];
  const spcDist: Record<string, number> = {};
  for (const sp of sps) {
    const off = sp.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
    const ext = sp.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    if (!off || !ext) continue;
    const textMatches = [...sp.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]);
    const text = textMatches.join("");
    const anchor = sp.match(/<a:bodyPr[^>]*anchor="(\w+)"/)?.[1];
    const align = sp.match(/<a:pPr[^>]*algn="(\w+)"/)?.[1];
    const spcPct = sp.match(/<a:spcPct val="(\d+)"/)?.[1];
    const sz = sp.match(/<a:rPr[^>]*sz="(\d+)"/)?.[1];
    const b = /<a:rPr[^>]*b="1"/.test(sp);
    const color = sp.match(/<a:srgbClr val="([0-9A-Fa-f]+)"/)?.[1];
    const insetsRe = sp.match(/<a:bodyPr[^>]*lIns="(-?\d+)"[^>]*tIns="(-?\d+)"[^>]*rIns="(-?\d+)"[^>]*bIns="(-?\d+)"/);

    const snap: ShapeSnapshot = {
      text,
      x: +off[1] * EMU2PX,
      y: +off[2] * EMU2PX,
      w: +ext[1] * EMU2PX,
      h: +ext[2] * EMU2PX,
    };
    if (anchor) snap.anchor = anchor;
    if (align) snap.align = align;
    if (spcPct) {
      snap.spcPct = +spcPct;
      spcDist[spcPct] = (spcDist[spcPct] || 0) + 1;
    }
    if (sz) snap.sz = +sz;
    if (b) snap.b = true;
    if (color) snap.color = color;
    if (insetsRe) snap.insets = [+insetsRe[1], +insetsRe[2], +insetsRe[3], +insetsRe[4]];
    shapes.push(snap);
  }
  return {
    shapeCount: shapes.length,
    spcPctDistribution: spcDist,
    shapes,
  };
}

/** Round numeric fields so sub-pixel jitter doesn't dominate the diff. */
export function roundSnap(s: SlideSnapshot): SlideSnapshot {
  return {
    ...s,
    shapes: s.shapes.map(sh => ({
      ...sh,
      x: Math.round(sh.x * 10) / 10,
      y: Math.round(sh.y * 10) / 10,
      w: Math.round(sh.w * 10) / 10,
      h: Math.round(sh.h * 10) / 10,
    })),
  };
}

/** Simple index-based diff of the two shape arrays. pptx shape order is
 *  deterministic (from emit order in convert-pptx.ts), so aligned-index
 *  comparison produces readable output. */
export function diffSnapshots(before: SlideSnapshot, after: SlideSnapshot): string[] {
  const out: string[] = [];
  if (before.shapeCount !== after.shapeCount) {
    out.push(`shapeCount: ${before.shapeCount} → ${after.shapeCount}`);
  }
  const spcKeys = new Set([
    ...Object.keys(before.spcPctDistribution),
    ...Object.keys(after.spcPctDistribution),
  ]);
  for (const k of [...spcKeys].sort()) {
    const b = before.spcPctDistribution[k] || 0;
    const a = after.spcPctDistribution[k] || 0;
    if (b !== a) out.push(`spcPct=${k}: ${b} → ${a} shape(s)`);
  }
  const n = Math.min(before.shapeCount, after.shapeCount);
  for (let i = 0; i < n; i++) {
    const b = before.shapes[i], a = after.shapes[i];
    const label = b.text || a.text ? `"${(a.text || b.text).slice(0, 40)}"` : `(shape#${i})`;
    const fieldDiffs: string[] = [];
    const cmp = <K extends keyof ShapeSnapshot>(k: K) => {
      const bv: ShapeSnapshot[K] = b[k];
      const av: ShapeSnapshot[K] = a[k];
      if (JSON.stringify(bv) !== JSON.stringify(av)) {
        fieldDiffs.push(`    ${k}: ${JSON.stringify(bv)} → ${JSON.stringify(av)}`);
      }
    };
    (["text","x","y","w","h","anchor","align","spcPct","sz","b","color","insets"] as const)
      .forEach(cmp);
    if (fieldDiffs.length) {
      out.push(`  ${label}:`, ...fieldDiffs);
    }
  }
  // Shape-count delta: print indices present only on one side.
  for (let i = n; i < Math.max(before.shapeCount, after.shapeCount); i++) {
    if (i < before.shapeCount) {
      out.push(`  REMOVED#${i}: ${JSON.stringify(before.shapes[i]).slice(0, 200)}`);
    } else {
      out.push(`  ADDED#${i}: ${JSON.stringify(after.shapes[i]).slice(0, 200)}`);
    }
  }
  return out;
}

export interface DiffPptxPairsOpts {
  before: string; // dir of single-slide .pptx files (baseline)
  after: string;  // dir of single-slide .pptx files (post-fix)
  out: string;    // dir to write <slide_id>.diff and <slide_id>.summary.json into
}

export interface DiffPptxPairsResult {
  emitted: number;             // count of slides successfully diffed
  outDir: string;              // resolved out dir
  diffFiles: string[];         // absolute paths of <out>/<slide_id>.diff written
}

export async function diffPptxPairs(opts: DiffPptxPairsOpts): Promise<DiffPptxPairsResult> {
  const { before, after, out } = opts;
  mkdirSync(out, { recursive: true });
  const beforePptxs = readdirSync(before).filter(f => f.endsWith(".pptx")).sort();
  let emitted = 0;
  const diffFiles: string[] = [];
  for (const f of beforePptxs) {
    const afterPath = join(after, f);
    const beforePath = join(before, f);
    const id = basename(f, ".pptx");
    const diffPath = join(out, `${id}.diff`);
    try {
      const snapBefore = roundSnap(await snapshotSlide(beforePath));
      const snapAfter = roundSnap(await snapshotSlide(afterPath));
      const lines = diffSnapshots(snapBefore, snapAfter);
      const body = lines.length
        ? lines.join("\n")
        : "(no structural differences detected)";
      writeFileSync(
        diffPath,
        [`# pptx diff: ${id}`, `# before: ${beforePath}`, `# after:  ${afterPath}`, ``, body, ``].join("\n"),
      );
      writeFileSync(
        join(out, `${id}.summary.json`),
        JSON.stringify({ slide_id: id, before: snapBefore, after: snapAfter }, null, 2),
      );
      diffFiles.push(resolve(diffPath));
      emitted++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      writeFileSync(diffPath, `# diff error: ${msg}\n`);
    }
  }
  console.log(`diff-pptx-pairs: ${emitted} diff file(s) written → ${out}`);
  return { emitted, outDir: resolve(out), diffFiles };
}

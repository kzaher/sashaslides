#!/usr/bin/env npx tsx
/**
 * debug-extract.ts — print what `extract-dom.ts` produced for one HTML file, as the converter sees it.
 *
 *   npx tsx renderer/html2slides/debug-extract.ts <slide.html> [--view summary|full|runs|table]
 *
 * It runs the converter's own `extractFromHtml()` (convert-pptx-io.ts), so the readiness gate, font
 * polling, viewport and emoji retyping are exactly the pipeline's: a dump can never disagree with
 * what the converter actually receives. Every view is line-per-item and stable, so the way to see what
 * an extractor change did is: run it, change the extractor, run it again, `diff`.
 *
 *   summary  one line per element: text style and runs, rect fill/corners/borders/gradient (default)
 *   full     one line per element with geometry, corner radii and clip mask
 *   runs     only the text RUNS of text, list and list-item elements
 *   table    only tables: fill, clip mask and per-row cell heights and fills
 *
 * Needs Chrome with remote debugging on HTML2SLIDES_CHROME_PORT (default 9222).
 */
import { resolve } from "node:path";

import { extractFromHtml } from "./convert-pptx-io.ts";
import type {
  Bounds,
  BorderSides,
  ClipMask,
  CornerRadii,
  ExtractedElement,
  TableElement,
  TextRun,
} from "./convert-pptx-lib.ts";

const VIEWS = ["summary", "full", "runs", "table"] as const;
type View = (typeof VIEWS)[number];

function isView(value: string): value is View {
  return (VIEWS as readonly string[]).includes(value);
}

type Args = Readonly<{ htmlPath: string; view: View }>;

function parseArgs(argv: readonly string[]): Args {
  let htmlPath: string | undefined;
  let view: View = "summary";
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at];
    if (arg === "--view") {
      const value = argv[++at] ?? "";
      if (!isView(value)) throw new Error(`--view must be one of ${VIEWS.join("|")}, got "${value}"`);
      view = value;
    } else if (arg !== undefined) {
      htmlPath = arg;
    }
  }
  if (htmlPath === undefined) throw new Error(`usage: debug-extract.ts <slide.html> [--view ${VIEWS.join("|")}]`);
  return { htmlPath: resolve(htmlPath), view };
}

const px = (value: number): string => value.toFixed(0);
const box = (b: Bounds): string => `(${px(b.x)},${px(b.y)},${px(b.w)},${px(b.h)})`;
const corners = (cr: CornerRadii): string => `tl:${cr.tl},tr:${cr.tr},br:${cr.br},bl:${cr.bl}`;
const sides = (s: BorderSides): string =>
  `top:${s.top.width}/${s.top.color},right:${s.right.width}/${s.right.color},` +
  `bottom:${s.bottom.width}/${s.bottom.color},left:${s.left.width}/${s.left.color}`;
const clip = (mask: ClipMask | null | undefined): string =>
  mask ? `clipMask={bnds:${box(mask.bounds)} ${corners(mask.cornerRadii)}}` : "clipMask=null";

function summaryLine(el: ExtractedElement): readonly string[] {
  switch (el.type) {
    case "text": {
      const s = el.style;
      const head =
        `TEXT: ${JSON.stringify(el.text)}  bounds=${JSON.stringify(el.bounds)}  ` +
        `font=${s?.fontFamily}/${s?.fontSize}/${s?.fontWeight}  color=${s?.color}  align=${s?.textAlign}`;
      const runs = (el.runs ?? []).map((r) => `  run: ${JSON.stringify(r.text)}  color=${r.style?.color || "(inherit)"}`);
      return [head, ...runs];
    }
    case "rect": {
      const cr = el.cornerRadii ? `cornerRadii={${corners(el.cornerRadii)}}` : "cornerRadii=none";
      const bs = el.borderSides ? `borderSides={${sides(el.borderSides)}}` : "borderSides=none";
      const gr = el.gradient
        ? `gradient={angle:${el.gradient.angle},stops:[${el.gradient.stops.map((s) => `${s.color}@${s.position}`).join(",")}]}`
        : "gradient=none";
      return [`rect  bounds=${JSON.stringify(el.bounds)}  fill=${el.fill}  ${cr}  ${bs}  ${gr}`];
    }
    case "line":
      return [`${el.type}  bounds=${JSON.stringify(el.bounds)}  ${el.color || ""}`];
    default:
      return [`${el.type}  bounds=${JSON.stringify(el.bounds)}`];
  }
}

function fullLine(el: ExtractedElement, at: number): string {
  const cr = "cornerRadii" in el && el.cornerRadii ? `cornerRadii={${corners(el.cornerRadii)}}` : "";
  const br = "borderRadius" in el && el.borderRadius !== undefined ? `br=${el.borderRadius}` : "";
  let extra = "";
  if (el.type === "table") extra = ` rows=${el.rows.length}`;
  else if (el.type === "rect") extra = ` fill=${el.fill || "-"} bg=${el.style?.bgColor || "-"}`;
  else if (el.type === "text") extra = ` text=${JSON.stringify((el.text || "").slice(0, 30))}`;
  return `[${at}] ${el.type} ${box(el.bounds)} ${br} ${cr} ${clip(el.clipMask)}${extra}`;
}

function runLine(run: TextRun): string {
  return run.style == null
    ? "style=null (inherits the element's)"
    : `size=${String(run.style.fontSize)} weight=${String(run.style.fontWeight)}`;
}

function runsLines(el: ExtractedElement, at: number): readonly string[] {
  const lines: string[] = [];
  if ("text" in el && typeof el.text === "string") lines.push(`[${at}] ${el.type} text=${JSON.stringify(el.text)}`);
  if (el.type === "text") {
    for (const [runAt, run] of (el.runs ?? []).entries()) lines.push(`[${at}]   run ${runAt} ${JSON.stringify(run.text)}  ${runLine(run)}`);
  }
  if (el.type === "list") {
    for (const [itemAt, item] of el.items.entries()) {
      lines.push(`[${at}]   item ${itemAt} text=${JSON.stringify(item.text)}`);
      for (const [runAt, run] of (item.runs ?? []).entries()) {
        lines.push(`[${at}]     item ${itemAt} run ${runAt} ${JSON.stringify(run.text)}`);
      }
    }
  }
  return lines;
}

function tableLines(el: TableElement, at: number): readonly string[] {
  const lines = [`TABLE[${at}] bgColor=${el.bgColor || "null"} borderRadius=${el.borderRadius} clipMask=${el.clipMask ? "YES" : "no"}`];
  if (el.clipMask) lines.push(`  clipMask bounds=${box(el.clipMask.bounds)} cr=${corners(el.clipMask.cornerRadii)}`);
  lines.push(`  bounds=${box(el.bounds)}`);
  for (const [rowAt, row] of el.rows.entries()) {
    const fills = row.map((c) => `${c.isHeader ? "H" : "D"}${c.style?.bgColor || "-"}`).join(",");
    const heights = row.map((c) => (c.bounds ? px(c.bounds.h) : "?")).join(",");
    lines.push(`  row[${rowAt}] heights=[${heights}]  cells=[${fills}]`);
  }
  return lines;
}

function render(elements: readonly ExtractedElement[], view: View): readonly string[] {
  return elements.flatMap((el, at): readonly string[] => {
    switch (view) {
      case "summary": return summaryLine(el);
      case "full": return [fullLine(el, at)];
      case "runs": return runsLines(el, at);
      case "table": return el.type === "table" ? tableLines(el, at) : [];
    }
  });
}

async function main(): Promise<void> {
  const { htmlPath, view } = parseArgs(process.argv.slice(2));
  const { extraction } = await extractFromHtml(htmlPath);
  for (const line of render(extraction.elements, view)) console.log(line);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);

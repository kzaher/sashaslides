#!/usr/bin/env npx tsx
/**
 * generate-clusters.ts — AUTO-WRITE clusters.ts from a checked reconciled bad set.
 *
 * The user has repeatedly been burned by WRONG GROUPING (unrelated slides folded
 * into one cluster → a fix that regresses a sibling, or a single defect
 * description that doesn't match every slide in the group). This generator sides
 * with correctness over batching: it emits ONE `Cluster` per bad slide, so a
 * cluster's slide set is always exactly `[that slide]` and its description is
 * exactly that slide's reconciled issue. No grouping heuristic to get wrong.
 *
 * `generateClusters(reconciled, { retryBudget })` returns the clusters.ts SOURCE
 * as a string. A CLI prints it to stdout by default (so a human reviews first)
 * and only writes `clusters.ts` with `--write`.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { reconcileLedgers, loadLedger, bySlideNumber, type ReconciledLedger } from "./reconcile-ledgers.js";
import type { Cluster } from "./workspace-setup.js";

export interface GenerateOptions {
  /** per-cluster attempt cap written into each Cluster. */
  retryBudget: number;
}

/** The standard "how to solve it" footer appended to every cluster description.
 *  Kept identical across clusters so the worker instructions are uniform. */
const FOOTER =
  "\n\nApproach: analyze the TARGET (original) vs the ATTEMPT (current render) + the annotation, " +
  "find the ROOT CAUSE in renderer/html2slides/extract-dom.ts and/or convert-pptx*.ts, apply the " +
  "MINIMAL fix, and DO NOT regress the other slides (render a couple of neighbours to confirm).";

/**
 * Build clusters DIRECTLY from a live SxS ratings.json — one cluster per slide the
 * user CURRENTLY marked BAD, using that slide's live comment + the standard footer.
 * NO ledger reconciliation, NO clusters.ts: the slides you actually marked bad are
 * the sole source of truth at solve start. Sorted by slide number. Empty file /
 * unreadable / nothing bad → [].
 */
export function clustersFromRatings(ratingsPath: string, opts: { retryBudget?: number } = {}): Cluster[] {
  if (!existsSync(ratingsPath)) return [];
  let raw: Record<string, { status?: string; verdict?: string; rating?: string; good?: boolean; comment?: string; issue?: string }>;
  try { raw = JSON.parse(readFileSync(ratingsPath, "utf8")); } catch { return []; }
  const isBad = (v: (typeof raw)[string]): boolean => {
    const s = (v?.status ?? v?.verdict ?? v?.rating ?? "").toString().toLowerCase();
    return s === "bad" || v?.good === false;
  };
  const num = (id: string): number => Number(id.replace(/^slide_?/, "")) || 0;
  const usedSlugs = new Map<string, number>();
  return Object.entries(raw)
    .filter(([, v]) => isBad(v))
    .sort(([a], [b]) => num(a) - num(b))
    .map(([id, v]) => {
      const issue = (v.comment ?? v.issue ?? "").toString().trim();
      let slug = taskSlug(id, issue);
      const n = usedSlugs.get(slug) ?? 0; usedSlugs.set(slug, n + 1);
      if (n > 0) slug = `${slug}-${n + 1}`;
      return {
        task_id: slug,
        slide_ids: [id],
        cluster_description: `${id} — ${issue || "(no comment)"}${FOOTER}`,
        ...(opts.retryBudget && opts.retryBudget >= 1 ? { retry_budget: opts.retryBudget } : {}),
      };
    });
}

/** Short issue keyword derived from the issue text, for a readable task slug.
 *  Takes the first few alphanumeric words, lowercased, dash-joined; empty issue
 *  → "issue". */
export function issueKeyword(issue: string): string {
  const words = issue
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const kw = words.slice(0, 3).join("-");
  return kw || "issue";
}

const STOPWORDS = new Set([
  "the", "and", "for", "are", "not", "but", "with", "this", "that", "you",
  "can", "should", "would", "just", "some", "there", "they", "them", "its",
  "which", "when", "why", "how", "into", "onto", "from", "have", "has",
]);

/** A deterministic, valid JS identifier-ish slug for the task_id: slide number +
 *  issue keyword, e.g. slide_11 + "not a list…" → "slide-11-list-output". */
export function taskSlug(slideId: string, issue: string): string {
  const num = /^slide_(\d+)$/.exec(slideId)?.[1] ?? slideId.replace(/[^a-z0-9]+/gi, "-");
  return `slide-${num}-${issueKeyword(issue)}`;
}

/** JSON-string-escape a description for embedding in the emitted TS source. We
 *  emit it as a JSON string literal (double-quoted, \n-escaped) which is valid
 *  TS and round-trips exactly. */
function tsStringLiteral(s: string): string {
  return JSON.stringify(s);
}

/**
 * Build the clusters.ts source from a reconciled ledger: one Cluster per bad
 * slide (sorted by slide number for a stable file), exporting `CLUSTERS`.
 */
export function generateClusters(reconciled: ReconciledLedger, opts: GenerateOptions): string {
  const bad = [...reconciled.badSet].sort(bySlideNumber);
  const usedSlugs = new Map<string, number>();

  const clusterBlocks: string[] = [];
  const constNames: string[] = [];

  for (const id of bad) {
    const slide = reconciled.slides[id];
    const issue = slide?.issue ?? "";
    let slug = taskSlug(id, issue);
    // de-dup slugs defensively (two slides could yield the same keyword).
    const n = usedSlugs.get(slug) ?? 0;
    usedSlugs.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n + 1}`;

    const constName = `C_${id.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}`;
    constNames.push(constName);

    const description = `${id} — ${issue || "(no issue text)"}${FOOTER}`;

    clusterBlocks.push(
      `const ${constName}: Cluster = {\n` +
      `  task_id: ${tsStringLiteral(slug)},\n` +
      `  slide_ids: [${tsStringLiteral(id)}],\n` +
      `  retry_budget: ${opts.retryBudget},\n` +
      `  cluster_description: ${tsStringLiteral(description)},\n` +
      `};`,
    );
  }

  const header =
    "/**\n" +
    " * clusters.ts — AUTO-GENERATED by generate-clusters.ts from the reconciled,\n" +
    " * checked bad set. ONE Cluster per bad slide (no grouping heuristic → no\n" +
    " * wrong-grouping regressions). Re-generate with:\n" +
    " *   npx tsx renderer/structured-prompts/bug_solving/reconcile-and-check.ts --emit-clusters\n" +
    " * Review the diff before launching a solve; a human owns the final clusters.ts.\n" +
    " */\n" +
    'import type { Cluster } from "./workspace-setup.js";';

  const body = clusterBlocks.length
    ? clusterBlocks.join("\n\n")
    : "// (no bad slides — nothing to solve)";

  const exportLine = `export const CLUSTERS: Cluster[] = [${constNames.join(", ")}];`;

  return `${header}\n\n${body}\n\n${exportLine}\n`;
}

// ===========================================================================
// CLI
// ===========================================================================

/** Default ledger paths (mirrors reconcile-and-check.ts). */
const DEFAULT_PATHS = {
  candidates: "/workspaces/sashaslides/.bug-solving-history/candidates.json",
  baseline: "/workspaces/sashaslides/renderer/html2slides/e2e/.ratings-complex.json",
  history: "/workspaces/sashaslides/.bug-solving-history/ratings.json",
  live: "/tmp/sxs-complex/ratings.json",
};

function argVal(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function isMain(): boolean {
  // Run directly (tsx clusters generator), not imported.
  return (
    typeof process !== "undefined" &&
    Array.isArray(process.argv) &&
    /generate-clusters\.ts$/.test(process.argv[1] ?? "")
  );
}

if (isMain()) {
  const retryBudget = Number(argVal("--retry-budget", "5")) || 5;
  const reconciled = reconcileLedgers({
    candidates: loadLedger(argVal("--candidates", DEFAULT_PATHS.candidates)),
    baseline: loadLedger(argVal("--baseline", DEFAULT_PATHS.baseline)),
    history: loadLedger(argVal("--history", DEFAULT_PATHS.history)),
    live: loadLedger(argVal("--live", DEFAULT_PATHS.live)),
  });
  const source = generateClusters(reconciled, { retryBudget });
  if (process.argv.includes("--write")) {
    const here = dirname(fileURLToPath(import.meta.url));
    const out = join(here, "clusters.ts");
    writeFileSync(out, source);
    console.error(`[generate-clusters] wrote ${reconciled.badSet.length} cluster(s) → ${out}`);
  } else {
    process.stdout.write(source);
    console.error(`\n[generate-clusters] ${reconciled.badSet.length} cluster(s) printed (use --write to overwrite clusters.ts).`);
  }
}

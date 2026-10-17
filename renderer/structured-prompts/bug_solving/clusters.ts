/**
 * clusters.ts — the solve's clusters, built from the live SxS ratings.
 *
 * One cluster per slide the user currently marked BAD (clustersFromRatings), so a
 * cluster's slide set is exactly that slide and its description is that slide's own
 * comment: no grouping heuristic to get wrong. The user can still group slides by
 * hand (applyManualClusters, `solve.sh --clusters`).
 */
import { readFileSync, existsSync } from "node:fs";
import type { Cluster } from "./workspace-setup.js";

/** The standard "how to solve it" footer appended to every cluster description.
 *  Kept identical across clusters so the worker instructions are uniform. */
const FOOTER =
  "\n\nApproach: analyze the TARGET (original) vs the ATTEMPT (current render) + the annotation, " +
  "find the ROOT CAUSE in renderer/html2slides/extract-dom.ts and/or convert-pptx*.ts, apply the " +
  "MINIMAL fix, and DO NOT regress the other slides (render a couple of neighbours to confirm).";

/**
 * Build clusters DIRECTLY from a live SxS ratings.json — one cluster per slide the
 * user CURRENTLY marked BAD, using that slide's live comment + the standard footer.
 * No ledger reconciliation and no generated cluster file: the slides you marked bad are
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

/**
 * Manually GROUP the auto per-slide clusters into shared clusters. `specRaw` is a
 * JSON-ish nested array of slide ids — single OR double quotes, ids may be
 * `slide_35` / `S_35` / `35` (matched by number). Each inner array becomes ONE
 * cluster that merges those slides' auto clusters (so they're solved as one root
 * cause + one fork). Every BAD slide NOT named keeps its own per-slide cluster.
 *
 *   --clusters="[['slide_35','slide_36','slide_37','slide_38']]"   → 1 cluster
 *   --clusters="[['slide_35','slide_36'],['slide_10','slide_11']]" → 2 clusters
 *
 * Only slides that are already in `auto` (i.e. marked BAD) can be grouped — a
 * name that matches no bad slide is skipped with a warning.
 *
 * `options.memberKey` maps a spec entry AND a cluster's slide id to the key they
 * are matched on. Default: the slide number (forward ids are unique per number).
 * The reverse direction's ids ("complex__slide_05") repeat numbers across sets, so
 * it passes reverseClusterMemberKey (reverse-direction.ts) instead.
 */
export function applyManualClusters(
  auto: Cluster[],
  specRaw: string,
  options: { memberKey?: (reference: string) => string } = {},
): Cluster[] {
  const raw = (specRaw ?? "").trim();
  if (!raw) return auto;
  let spec: unknown;
  try {
    spec = JSON.parse(raw.replace(/'/g, '"'));
  } catch (e) {
    throw new Error(
      `--clusters: not valid JSON (${(e as Error).message}). ` +
        `Example: --clusters="[['slide_35','slide_36','slide_37','slide_38']]"`,
    );
  }
  if (!Array.isArray(spec) || !spec.every((g) => Array.isArray(g))) {
    throw new Error("--clusters must be an array of arrays, e.g. [['slide_35','slide_36']]");
  }
  const numOf = (s: unknown): number => Number(String(s).replace(/[^0-9]/g, "")) || -1;
  const keyOf = options.memberKey ?? ((reference: string): string => String(numOf(reference)));
  const byNum = new Map<string, Cluster>();
  for (const c of auto) for (const sid of c.slide_ids) byNum.set(keyOf(sid), c);

  const grouped = new Set<Cluster>();
  const merged: Cluster[] = [];
  for (const group of spec as unknown[][]) {
    const members = [
      ...new Set(group.map((reference) => keyOf(String(reference))).map((key) => byNum.get(key)).filter((c): c is Cluster => !!c)),
    ];
    if (members.length === 0) {
      console.error(`[clusters] manual group ${JSON.stringify(group)} matched no BAD slide — skipped`);
      continue;
    }
    if (members.length === 1) {
      // A single-member group is a no-op grouping — keep the cluster as-is.
      grouped.add(members[0]);
      merged.push(members[0]);
      continue;
    }
    members.forEach((c) => grouped.add(c));
    const slide_ids = [...new Set(members.flatMap((c) => c.slide_ids))].sort((a, b) => numOf(a) - numOf(b));
    merged.push({
      task_id: members[0].task_id,
      slide_ids,
      cluster_description:
        `Manual cluster of ${slide_ids.length} slides (${slide_ids.join(", ")}) — solve as ONE ` +
        `shared root cause, one fix.\n` +
        members.map((c) => c.cluster_description).join("\n"),
      ...(members[0].retry_budget ? { retry_budget: members[0].retry_budget } : {}),
    });
  }
  const rest = auto.filter((c) => !grouped.has(c));
  return [...merged, ...rest];
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

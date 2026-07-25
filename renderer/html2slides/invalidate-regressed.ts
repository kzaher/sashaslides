/**
 * invalidate-regressed.ts — after a goldens check, INVALIDATE the "good" rating
 * of any slide whose current render REGRESSED vs its blessed golden.
 *
 * A "good" rating means "this render is approved". If the render now differs
 * from the golden (a regression), that approval is stale — so we flip the slide
 * from good → bad (surfaced in the SxS + eligible for a re-solve), tagging the
 * comment so it's clear the invalidation was automatic, not a human verdict.
 *
 * Only slides currently rated "good" are touched. "new" (never-blessed) slides,
 * already-bad slides, and unchanged ("ok") slides are left exactly as they are.
 *
 *   npx tsx invalidate-regressed.ts <regression-report.json> <ratings.json> [ratings-backup.json]
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";

type Result = { file: string; status: string; diffPixels?: number };
type Entry = { status?: string; comment?: string; ratedAt?: string; annotation?: string; invalidated?: boolean };

const [reportPath, ratingsPath, backupPath] = process.argv.slice(2);
if (!reportPath || !ratingsPath) {
  console.error("usage: invalidate-regressed.ts <regression-report.json> <ratings.json> [backup.json]");
  process.exit(2);
}
if (!existsSync(reportPath) || !existsSync(ratingsPath)) {
  console.log("[invalidate] no regression-report / ratings.json — nothing to invalidate");
  process.exit(0);
}

const report = JSON.parse(readFileSync(reportPath, "utf8")) as { results?: Result[] };
const ratings = JSON.parse(readFileSync(ratingsPath, "utf8")) as Record<string, Entry>;

const stamp = new Date().toISOString().slice(0, 10);
const invalidated: string[] = [];
for (const r of report.results ?? []) {
  if (r.status !== "regressed") continue;              // only genuine regressions
  const id = r.file.replace(/\.png$/, "");
  const entry = ratings[id];
  if (!entry || entry.status !== "good") continue;     // only invalidate currently-GOOD slides
  const note = `[auto-invalidated by regen: render regressed vs blessed golden (${r.diffPixels ?? "?"}px, ${stamp})]`;
  ratings[id] = {
    ...entry,
    status: "bad",
    invalidated: true,
    comment: entry.comment ? `${note} ${entry.comment}` : note,
    ratedAt: new Date().toISOString(),
  };
  invalidated.push(id);
}

if (invalidated.length === 0) {
  console.log("[invalidate] no previously-GOOD slide regressed — ratings unchanged");
  process.exit(0);
}

writeFileSync(ratingsPath, JSON.stringify(ratings, null, 2));
if (backupPath) {
  try { copyFileSync(ratingsPath, backupPath); } catch { /* backup is best-effort */ }
}
console.log(
  `[invalidate] ${invalidated.length} previously-GOOD slide(s) REGRESSED vs golden → flipped to BAD ` +
    `(re-review in the SxS / re-solve): ${invalidated.join(", ")}`,
);

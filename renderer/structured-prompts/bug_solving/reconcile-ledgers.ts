/**
 * reconcile-ledgers.ts — DETERMINISTIC ledger reconciliation + pre-solve
 * validation for the bug_solving pipeline.
 *
 * WHY: the pipeline picks which slides to re-solve from SEVERAL disagreeing
 * ledgers, and reconciling them BY HAND kept producing WRONG clusters (a slide
 * demoted after a merge failure looks "good" in the user-blessed baseline; the
 * live SxS UI goes stale and shows already-fixed slides as bad; the operative
 * candidates ledger has terse one-word comments). This module encodes the
 * precedence + conflict rules IN CODE so the bad set is reproducible.
 *
 * ## Ledger sources (all optional; each is `{ "<slide_id>": RatingRecord }`)
 *   candidates — .bug-solving-history/candidates.json — OPERATIVE bug_solving
 *                ledger (per-round green/red + merge-failure demotes). HIGHEST
 *                authority for STATUS.
 *   baseline   — renderer/html2slides/e2e/.ratings-complex.json — persistent
 *                user-blessed complex ratings. Authority for ISSUE TEXT + the
 *                original bad set.
 *   history    — .bug-solving-history/ratings.json — canonical per-slide issue
 *                ledger (issue-text fallback).
 *   live       — /tmp/sxs-complex/ratings.json — the live SxS UI ledger; LOWEST
 *                authority (often STALE). Cross-check only.
 *
 * ## STATUS precedence (candidates → baseline → history → unrated)
 *   The FIRST source that has a concrete good|bad verdict for the slide wins.
 *   `pending`/absent in a source ⇒ that source abstains (fall through).
 *   `live` NEVER sets status — it is only cross-checked for stale-conflict notes.
 *
 * ## ISSUE-TEXT preference (baseline → history → candidates)
 *   The RICHEST non-empty user comment wins in that order: the user's own words
 *   in the baseline describe the defect best; candidates comments are often
 *   terse ("No"), so they lose to any baseline/history comment.
 *
 * The pure `reconcileLedgers(sources)` does NO fs (take already-parsed objects);
 * a thin `loadLedger(path)` reads+parses (missing/malformed → {} with a warning).
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ===========================================================================
// Ledger shapes
// ===========================================================================

/** One slide's record as stored in any ledger JSON. All fields optional — a
 *  ledger may carry only a status, only a comment, or an alternate `issue`. */
export interface RatingRecord {
  status?: "good" | "bad" | "pending" | string;
  /** the SxS/candidates ledgers store the user comment here. */
  comment?: string;
  /** some ledgers spell the defect text `issue` instead of `comment`. */
  issue?: string;
}

/** A parsed ledger: slide id → record. */
export type Ledger = Record<string, RatingRecord>;

/** The four ledger inputs to reconciliation. All optional; a missing ledger is
 *  simply `{}` (or omitted). */
export interface LedgerSources {
  candidates?: Ledger;
  baseline?: Ledger;
  history?: Ledger;
  live?: Ledger;
}

/** Which ledger a value came from (for conflict + provenance reporting). */
export type LedgerName = "candidates" | "baseline" | "history" | "live";

// ===========================================================================
// Reconciled result shapes
// ===========================================================================

export type ReconciledStatus = "good" | "bad" | "unrated";

/** The per-source status projection recorded on each reconciled slide (so a
 *  reader can see exactly what every ledger said). `undefined` = the source had
 *  no concrete good|bad verdict (absent / pending). */
export interface PerSourceStatus {
  candidates?: ReconciledStatus;
  baseline?: ReconciledStatus;
  history?: ReconciledStatus;
  live?: ReconciledStatus;
}

/** The reconciled view of one slide. */
export interface ReconciledSlide {
  status: ReconciledStatus;
  /** status === "bad" — the slide must be (re-)solved. */
  needsSolve: boolean;
  /** the richest user comment (baseline → history → candidates); "" if none. */
  issue: string;
  /** what each ledger said (for provenance). */
  sources: PerSourceStatus;
  /** cross-ledger disagreements, each with both values + the resolving rule. */
  conflicts: string[];
}

/** A pipeline-level conflict record (aggregated across slides). */
export interface ReconciledConflict {
  slide: string;
  detail: string;
  /** false = an UNRESOLVABLE disagreement (two equal-authority sources) — a
   *  guard that should never fire under strict precedence; a caller must stop. */
  resolved: boolean;
}

export interface ReconciledLedger {
  slides: Record<string, ReconciledSlide>;
  /** sorted list of slide ids with needsSolve === true. */
  badSet: string[];
  /** every conflict across all slides (resolved + unresolved). */
  conflicts: ReconciledConflict[];
}

// ===========================================================================
// Helpers
// ===========================================================================

/** Project a raw ledger record's status to good|bad|(undefined). `pending` and
 *  anything that isn't exactly good|bad ⇒ undefined (the source abstains). */
function concreteStatus(rec: RatingRecord | undefined): ReconciledStatus | undefined {
  if (!rec) return undefined;
  if (rec.status === "good") return "good";
  if (rec.status === "bad") return "bad";
  return undefined; // pending / absent / unknown → abstain
}

/** The non-empty defect text a record carries (comment preferred, else issue). */
function recordIssue(rec: RatingRecord | undefined): string {
  if (!rec) return "";
  const c = (rec.comment ?? "").trim();
  if (c) return c;
  const i = (rec.issue ?? "").trim();
  return i;
}

/** Union of every slide id seen across the ledgers, sorted (slide_NN natural). */
function allSlideIds(sources: LedgerSources): string[] {
  const ids = new Set<string>();
  for (const led of [sources.candidates, sources.baseline, sources.history, sources.live]) {
    if (led) for (const id of Object.keys(led)) ids.add(id);
  }
  return [...ids].sort(bySlideNumber);
}

/** Natural sort so slide_2 < slide_10 (falls back to lexical for non-slide ids). */
export function bySlideNumber(a: string, b: string): number {
  const na = /^slide_(\d+)$/.exec(a);
  const nb = /^slide_(\d+)$/.exec(b);
  if (na && nb) return Number(na[1]) - Number(nb[1]);
  return a < b ? -1 : a > b ? 1 : 0;
}

// ===========================================================================
// The pure reconciler
// ===========================================================================

/**
 * Reconcile the four ledgers into a single deterministic view. No fs, no
 * mutation of the inputs — takes already-parsed ledger objects and returns a
 * fresh {@link ReconciledLedger}.
 */
export function reconcileLedgers(sources: LedgerSources): ReconciledLedger {
  const slides: Record<string, ReconciledSlide> = {};
  const allConflicts: ReconciledConflict[] = [];

  for (const id of allSlideIds(sources)) {
    const cand = concreteStatus(sources.candidates?.[id]);
    const base = concreteStatus(sources.baseline?.[id]);
    const hist = concreteStatus(sources.history?.[id]);
    const liv = concreteStatus(sources.live?.[id]);

    const perSource: PerSourceStatus = {};
    if (cand !== undefined) perSource.candidates = cand;
    if (base !== undefined) perSource.baseline = base;
    if (hist !== undefined) perSource.history = hist;
    if (liv !== undefined) perSource.live = liv;

    // STATUS precedence: candidates → baseline → history → unrated. The first
    // source with a concrete good|bad verdict wins.
    let status: ReconciledStatus = "unrated";
    let winner: LedgerName | null = null;
    if (cand !== undefined) { status = cand; winner = "candidates"; }
    else if (base !== undefined) { status = base; winner = "baseline"; }
    else if (hist !== undefined) { status = hist; winner = "history"; }

    // ISSUE-TEXT preference: baseline → history → candidates (richest user
    // wording first). live is never used for issue text (stale + duplicative).
    const issue =
      recordIssue(sources.baseline?.[id]) ||
      recordIssue(sources.history?.[id]) ||
      recordIssue(sources.candidates?.[id]) ||
      "";

    // ---- conflict detection -------------------------------------------------
    const conflicts: string[] = [];

    // candidates (winner) disagrees with a LOWER-authority persistent ledger →
    // the candidates verdict is the operative one; note WHY it differs.
    if (cand !== undefined) {
      if (base !== undefined && base !== cand) {
        const detail =
          cand === "bad" && base === "good"
            ? `baseline=good but candidates=bad → demoted after merge failure (candidates wins, stays bad)`
            : cand === "good" && base === "bad"
              ? `baseline=bad but candidates=good → fixed since the baseline (candidates wins, now good)`
              : `baseline=${base} but candidates=${cand} → candidates wins`;
        conflicts.push(detail);
        allConflicts.push({ slide: id, detail, resolved: true });
      }
      if (hist !== undefined && hist !== cand) {
        const detail =
          cand === "bad" && hist === "good"
            ? `history=good but candidates=bad → demoted after merge failure (candidates wins, stays bad)`
            : `history=${hist} but candidates=${cand} → candidates wins`;
        conflicts.push(detail);
        allConflicts.push({ slide: id, detail, resolved: true });
      }
    } else if (base !== undefined && hist !== undefined && base !== hist) {
      // No candidates verdict: baseline outranks history. Note the disagreement.
      const detail = `history=${hist} but baseline=${base} → baseline wins (higher authority)`;
      conflicts.push(detail);
      allConflicts.push({ slide: id, detail, resolved: true });
    }

    // live is LOWEST authority + often stale: cross-check it against the winner.
    if (liv !== undefined && winner !== null && liv !== status) {
      const detail = `live=${liv} but ${winner}=${status} → live likely stale (${winner} wins)`;
      conflicts.push(detail);
      allConflicts.push({ slide: id, detail, resolved: true });
    }

    // GUARD: an UNRESOLVABLE conflict — two EQUAL-authority sources disagree.
    // Strict precedence means this should never fire, but if the precedence
    // model ever changes to allow ties we flag it unresolved so the caller stops
    // rather than silently guessing. (No two of our four sources share a rank,
    // so this is a defensive no-op today.)
    // (Intentionally left as documentation; no equal-rank pair exists.)

    slides[id] = {
      status,
      needsSolve: status === "bad",
      issue,
      sources: perSource,
      conflicts,
    };
  }

  const badSet = Object.keys(slides)
    .filter((id) => slides[id].needsSolve)
    .sort(bySlideNumber);

  return { slides, badSet, conflicts: allConflicts };
}

// ===========================================================================
// Thin fs loader
// ===========================================================================

/** Read + parse a ledger JSON. Missing file → {} (silent). Malformed JSON → {}
 *  with a stderr warning. Never throws — a bad ledger degrades to "no opinion"
 *  rather than aborting the reconcile. */
export function loadLedger(path: string): Ledger {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Ledger;
    }
    console.error(`[reconcile] warning: ${path} is not a JSON object — ignoring.`);
    return {};
  } catch (e) {
    console.error(`[reconcile] warning: could not parse ${path}: ${(e as Error).message} — ignoring.`);
    return {};
  }
}

// ===========================================================================
// Post-reconciliation validation
// ===========================================================================

/** A validation report for the reconciled result, produced BEFORE any solve. */
export interface CheckReport {
  /** true iff there are ZERO failures (warnings do not gate). */
  ok: boolean;
  failures: string[];
  warnings: string[];
  /** echo of the reconciled bad set (sorted). */
  badSet: string[];
}

export interface CheckOptions {
  /** dir holding `<slide_id>.html` fixtures (C2). */
  fixturesDir: string;
  /** optional dir holding `originals/<id>.png` + `slides/<id>.png` (C4). */
  imagesDir?: string;
}

/**
 * Validate a {@link ReconciledLedger} before a solve. Checks (C1–C6):
 *   C1 empty badSet → WARNING "nothing to solve" (ok stays true; caller decides).
 *   C2 every bad slide has `<fixturesDir>/<id>.html` → FAILURE if missing.
 *   C3 every bad slide has a non-empty `issue` → FAILURE.
 *   C4 (imagesDir given) every bad slide has originals/<id>.png + slides/<id>.png
 *      (annotation optional) → WARNING if missing.
 *   C5 any UNRESOLVED conflict → FAILURE; resolved (demote) conflicts → WARNING.
 *   C6 every bad slide id matches /^slide_\d+$/ and ids are distinct → FAILURE.
 */
export function checkReconciled(reconciled: ReconciledLedger, opts: CheckOptions): CheckReport {
  const failures: string[] = [];
  const warnings: string[] = [];
  const badSet = reconciled.badSet;

  // C1 — nothing to solve.
  if (badSet.length === 0) {
    warnings.push("C1: badSet is empty — nothing to solve.");
  }

  // C6 — valid + distinct ids. (Run first so later checks trust the ids.)
  const seen = new Set<string>();
  for (const id of badSet) {
    if (!/^slide_\d+$/.test(id)) {
      failures.push(`C6: bad slide id "${id}" is not of the form slide_<digits>.`);
    }
    if (seen.has(id)) {
      failures.push(`C6: duplicate bad slide id "${id}".`);
    }
    seen.add(id);
  }

  // C2 / C3 / C4 — per bad slide.
  for (const id of badSet) {
    const slide = reconciled.slides[id];

    // C2 — fixture present.
    const fixture = join(opts.fixturesDir, `${id}.html`);
    if (!existsSync(fixture)) {
      failures.push(`C2: bad slide ${id} has no fixture at ${fixture} — cannot solve it.`);
    }

    // C3 — non-empty issue.
    if (!slide || !slide.issue || !slide.issue.trim()) {
      failures.push(`C3: bad slide ${id} has an empty issue — the worker needs the defect described.`);
    }

    // C4 — original + rendered PNGs (annotation optional).
    if (opts.imagesDir) {
      const original = join(opts.imagesDir, "originals", `${id}.png`);
      const rendered = join(opts.imagesDir, "slides", `${id}.png`);
      const missing: string[] = [];
      if (!existsSync(original)) missing.push(original);
      if (!existsSync(rendered)) missing.push(rendered);
      if (missing.length) {
        warnings.push(`C4: bad slide ${id} missing image(s): ${missing.join(", ")}.`);
      }
    }
  }

  // C5 — conflicts.
  for (const c of reconciled.conflicts) {
    if (!c.resolved) {
      failures.push(`C5: UNRESOLVED conflict on ${c.slide}: ${c.detail}.`);
    } else {
      warnings.push(`C5: resolved conflict on ${c.slide}: ${c.detail}.`);
    }
  }

  return { ok: failures.length === 0, failures, warnings, badSet };
}

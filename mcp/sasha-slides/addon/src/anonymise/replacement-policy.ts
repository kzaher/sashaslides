/**
 * replacement-policy.ts — the gate a model-written replacement has to pass, and what it costs when
 * it passes.
 *
 * THE RULE THAT MATTERS: this module can only ever say "use this replacement" or "fall back". It
 * has no third answer, and in particular it cannot say "use the original". `anonymiseSlideHtml`
 * substitutes every run this module does not accept, so a model that is wrong, lazy, empty,
 * truncated, confused about ids or actively hostile costs READABILITY and never safety. That is
 * the whole architecture in one sentence, and the hostile-reply cases in anonymise-leak.test.ts
 * are what hold it.
 *
 * THE THREE REJECTION RULES are the contract's (UI-CONTRACT.md, "Anonymisation is model-assisted,
 * but the model is never the safety net"):
 *   - `unchanged`       — it equals the original, case-insensitively;
 *   - `echoes-original` — it shares FOUR CONSECUTIVE letters or digits with the original;
 *   - `emptied`         — it is empty and the original was not.
 * Plus one the contract implies rather than states: `unknown-run`, an id this document has no run
 * for. An id is a POSITION (text-runs.ts), so an id from a different document, a hallucinated one
 * or one for a run that has since been edited away names a position whose content this map was not
 * written about. Applying it would be guessing, so the run is substituted and the id is reported.
 *
 * `echoes-original` IS A SUBSTRING RULE, NOT A WORD RULE, and that is deliberate. "No reused word
 * of four or more characters" leaves `Northwind` → `Northwi` and `Zqxvcanary` → `canary`
 * accepted, which is precisely the leak this feature exists not to cause: a fragment of a company
 * name is the company name to a reader. So the unit is the four-character WINDOW inside a run of
 * letters or digits (`echoFragmentsOf`), and a replacement is rejected if it shares even one with
 * the slide. This SUBSUMES the word rule — a shared word of four or more characters contains all
 * of its own windows — so there is exactly one rule here, not two that overlap.
 *
 * Measured cost, on 27 hand-written plausible replacements for e2e/fixtures 01 and 02: the word
 * rule rejected 6 (22%), this one rejects 9 (33%). The errors are not symmetric — a false
 * rejection costs one hand-edit in a flow built around editing the after column, a false
 * acceptance puts the user's own words in a payload leaving their machine — and every rejection is
 * reported with its run id so the user knows which runs to write themselves.
 *
 * IT IS SCOPED TO THE WHOLE DOCUMENT, not to the one run. A reply that moves the company name out
 * of the heading run and into the footer run would pass a per-run check and put the name straight
 * into the output. The document-wide set is a superset, so it never accepts anything a per-run
 * check would reject; the price is that a legitimately-reused common word ("revenue") is rejected
 * too. `textRunRewriteRequest` states the rule in the prompt, so a cooperative model does not trip
 * it nearly as often as the raw rate above suggests.
 *
 * WHAT NO RULE HERE CAN CATCH, stated plainly because it belongs in the residual-risk list and not
 * in a reader's assumptions: a model that deliberately ENCODES the original — base64, an acrostic,
 * a cipher — defeats every check in this file, because its output shares no fragment with its input.
 * Nothing cheap detects that. The defences against it are that the model is shown only the visible
 * text (never the carriers) and that the user reads the after column before pressing send.
 */
import type { TextRunId, TextRunKind, TextRunSite } from "./text-runs.ts";

/** What the model (or the user, having edited it) proposes: run id to replacement text. */
export type TextRunReplacements = ReadonlyMap<TextRunId, string>;

/** Why a proposal was thrown away. `detail` on `RejectedReplacement` says it in a sentence. */
export type ReplacementRejectionReason = "unknown-run" | "unchanged" | "echoes-original" | "emptied";

/**
 * One run the user will see as gibberish even though a replacement was offered for it. Shown in
 * the review surface so "this one was gibberished" is visible rather than inferred.
 */
export type RejectedReplacement = Readonly<{
  runId: TextRunId;
  reason: ReplacementRejectionReason;
  /** One sentence, ready to render. */
  detail: string;
}>;

/** How an accepted replacement can still cost fidelity. The defect reproduces off the layout. */
export type ShapeRiskKind =
  /** The number of hard line breaks differs, which is a different line count under `white-space: pre*`. */
  | "line-count"
  /** The length moved outside the tolerance band, so a wrapped run can break at a different word. */
  | "length"
  /** The longest unbreakable word grew, so a narrow box that fitted the original can overflow. */
  | "longest-word";

export type ShapeRisk = Readonly<{
  runId: TextRunId;
  runKind: TextRunKind;
  risk: ShapeRiskKind;
  detail: string;
  originalLength: number;
  replacementLength: number;
}>;

/** An accepted proposal, with the site that says where to put it and what whitespace to keep. */
export type AcceptedReplacement = Readonly<{ site: TextRunSite; text: string }>;

export type ReplacementDecisions = Readonly<{
  /** Keyed by run id. Only ever contains ids that `sites` actually had. */
  accepted: ReadonlyMap<TextRunId, AcceptedReplacement>;
  rejected: readonly RejectedReplacement[];
  shapeRisks: readonly ShapeRisk[];
}>;

/**
 * Every proposal judged against the runs of ONE document. Pure: same inputs, same decisions.
 *
 * `replacements` is untrusted — it comes from a model (through
 * `parseTextRunRewriteReply`) or from a user's edit box — so nothing here trusts its keys or its
 * values. An id that is not a run becomes `unknown-run`; a value is normalised before it is judged
 * (see `visibleTextOf`) so an invisible character cannot smuggle an echo past the token check.
 */
export function decideReplacements({
  sites,
  replacements,
}: {
  sites: readonly TextRunSite[];
  replacements: TextRunReplacements;
}): ReplacementDecisions {
  const accepted = new Map<TextRunId, AcceptedReplacement>();
  const rejected: RejectedReplacement[] = [];
  const shapeRisks: ShapeRisk[] = [];
  const siteById = new Map(sites.map((site) => [site.id, site]));
  const forbiddenFragments = forbiddenEchoFragmentsOf({ sites });

  for (const [runId, proposed] of replacements) {
    const site = siteById.get(runId);
    if (site === undefined) {
      rejected.push({ runId, reason: "unknown-run", detail: detailFor({ reason: "unknown-run", runId }) });
      continue;
    }
    const verdict = judgeReplacement({ original: site.text, proposed, forbiddenFragments });
    switch (verdict.outcome) {
      case "rejected":
        rejected.push({ runId, reason: verdict.reason, detail: detailFor({ reason: verdict.reason, runId }) });
        continue;
      case "accepted":
        accepted.set(runId, { site, text: verdict.text });
        for (const risk of shapeRisksOf({ site, replacement: verdict.text })) shapeRisks.push(risk);
        continue;
      default:
        return assertNever(verdict);
    }
  }
  return { accepted, rejected, shapeRisks };
}

export type ReplacementVerdict =
  /** `text` is the NORMALISED proposal — what goes into the output, not the raw string. */
  | Readonly<{ outcome: "accepted"; text: string }>
  | Readonly<{ outcome: "rejected"; reason: Exclude<ReplacementRejectionReason, "unknown-run"> }>;

/**
 * The three rules, on one run. Exported so each of them can be tested on its own, which is how
 * they stay honest: `replacement-policy.test.ts` has a case per rule and per evasion.
 */
export function judgeReplacement({
  original,
  proposed,
  forbiddenFragments,
}: {
  original: string;
  proposed: string;
  /** `echoFragmentsOf` of every run in the document. Already folded for comparison. */
  forbiddenFragments: ReadonlySet<string>;
}): ReplacementVerdict {
  const text = visibleTextOf(proposed);
  if (text === "") return { outcome: "rejected", reason: "emptied" };
  if (foldedForComparison(text) === foldedForComparison(original)) return { outcome: "rejected", reason: "unchanged" };
  for (const fragment of echoFragmentsOf(text)) {
    if (forbiddenFragments.has(fragment)) return { outcome: "rejected", reason: "echoes-original" };
  }
  return { outcome: "accepted", text };
}

/**
 * Every four-character window of `text`, folded for comparison. Sharing one of these with the
 * slide is what `echoes-original` means.
 *
 * A window never crosses a boundary: it is taken inside a maximal run of LETTERS or a maximal run
 * of DIGITS, so `Northwind2024` contributes `nort`…`wind` and `2024` but never `nd20`. That keeps
 * the rule about the words themselves rather than about where they happen to sit, in both
 * directions — the same tokenisation is applied to the proposal before the sets are intersected.
 *
 * The folding (compatibility decomposition, combining marks dropped, lowercased) is what makes
 * `Ｎｏｒｔｈｗｉｎｄ` and `Nörthwind` share windows with `Northwind` instead of sliding past a
 * literal comparison. A run shorter than four characters contributes nothing, so a three-letter
 * word is reusable — the contract sets the threshold at four and this keeps it there.
 */
export function echoFragmentsOf(text: string): ReadonlySet<string> {
  const fragments = new Set<string>();
  for (const found of foldedForComparison(text).matchAll(/\p{L}+|\p{N}+/gu)) {
    const token = found[0];
    for (let at = 0; at + ECHO_FRAGMENT_LENGTH <= token.length; at += 1) {
      fragments.add(token.slice(at, at + ECHO_FRAGMENT_LENGTH));
    }
  }
  return fragments;
}

/** Every fragment no replacement in this document may contain. See the header on the scope. */
export function forbiddenEchoFragmentsOf({ sites }: { sites: readonly TextRunSite[] }): ReadonlySet<string> {
  const fragments = new Set<string>();
  for (const site of sites) for (const fragment of echoFragmentsOf(site.text)) fragments.add(fragment);
  return fragments;
}

/** The contract's threshold: four consecutive letters or digits. One rule, one number. */
const ECHO_FRAGMENT_LENGTH = 4;

/**
 * Length is allowed to move a little, because a model cannot hit a character count exactly and a
 * two-character drift on a short label changes nothing. Beyond this band a wrapped run can break
 * at a different word, which is reported rather than silently accepted.
 */
const LENGTH_TOLERANCE_FRACTION = 0.1;
const LENGTH_TOLERANCE_FLOOR = 2;

function shapeRisksOf({ site, replacement }: { site: TextRunSite; replacement: string }): readonly ShapeRisk[] {
  const risks: ShapeRisk[] = [];
  const lengths = { originalLength: site.text.length, replacementLength: replacement.length };
  const risk = (kind: ShapeRiskKind, detail: string): ShapeRisk => ({
    runId: site.id,
    runKind: site.kind,
    risk: kind,
    detail,
    ...lengths,
  });

  const originalBreaks = hardBreakCount(site.text);
  const replacementBreaks = hardBreakCount(replacement);
  if (originalBreaks !== replacementBreaks) {
    risks.push(
      risk(
        "line-count",
        `The replacement has ${replacementBreaks} hard line break(s) where the original had ${originalBreaks}. Under \`white-space: pre\` or \`pre-wrap\` that is a different number of rendered lines.`,
      ),
    );
  }

  const allowed = Math.max(LENGTH_TOLERANCE_FLOOR, Math.ceil(site.text.length * LENGTH_TOLERANCE_FRACTION));
  const delta = replacement.length - site.text.length;
  if (Math.abs(delta) > allowed) {
    risks.push(
      risk(
        "length",
        `The replacement is ${Math.abs(delta)} character(s) ${delta > 0 ? "longer" : "shorter"} than the original (${site.text.length}), which is outside the ±${allowed} band. A run that wraps may break at a different word, so a defect about wrapping or overflow may not reproduce.`,
      ),
    );
  }

  const originalWord = longestWordLength(site.text);
  const replacementWord = longestWordLength(replacement);
  if (replacementWord > originalWord) {
    risks.push(
      risk(
        "longest-word",
        `The replacement's longest unbreakable word is ${replacementWord} characters where the original's was ${originalWord}. A narrow box that fitted the original can overflow.`,
      ),
    );
  }
  return risks;
}

function hardBreakCount(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

function longestWordLength(text: string): number {
  return text.split(/\s+/).reduce((longest, word) => Math.max(longest, word.length), 0);
}

/**
 * The proposal as it will be emitted: control characters and invisible formatting characters
 * removed, CRLF normalised, surrounding whitespace dropped (the site's own `prefix`/`suffix` carry
 * that).
 *
 * The removal is not tidiness. `Zqxv<U+200B>canary` renders and copy-pastes as the original but
 * shares no token with it, so stripping the invisibles BEFORE the token check is what stops a
 * zero-width space being a way past `echoes-original`.
 */
function visibleTextOf(proposed: string): string {
  return proposed
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[­​-‏‪-‮⁠-⁤﻿]/g, "")
    .trim();
}

/**
 * The form two strings are compared in: compatibility-decomposed, combining marks dropped,
 * lowercased. `Ｒｅｖｅｎｕｅ`, `Revenue` and `Révenue` all fold to `revenue`, so none of them is a
 * way past a rule written about the other.
 */
function foldedForComparison(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function detailFor({ reason, runId }: { reason: ReplacementRejectionReason; runId: TextRunId }): string {
  switch (reason) {
    case "unknown-run":
      return `There is no run \`${runId}\` in this slide, so the replacement offered for it was not used. Nothing was changed by it.`;
    case "unchanged":
      return `The replacement for \`${runId}\` was the original text again, so it was gibberished instead.`;
    case "echoes-original":
      return `The replacement for \`${runId}\` reused four or more consecutive letters or digits from the slide's own text, so it was gibberished instead. Write this one yourself if you want it readable.`;
    case "emptied":
      return `The replacement for \`${runId}\` was empty but the original was not, so it was gibberished instead.`;
    default:
      return assertNever(reason);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled replacement case: ${JSON.stringify(value)}`);
}

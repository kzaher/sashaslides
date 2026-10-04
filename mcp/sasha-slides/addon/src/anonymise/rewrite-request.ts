/**
 * rewrite-request.ts — the two pure halves of the model call: the prompt that goes out, and the
 * parser for whatever comes back.
 *
 * It does not call anything. The composition root owns the transport (and therefore the decision
 * to send the user's visible text to a model at all); this module only turns runs into a string
 * and a string back into typed, bounded data.
 *
 * THE REPLY IS UNTRUSTED INPUT, so it is parsed HERE and nowhere else — a model's answer has the
 * same status as an HTTP body. The parser is strict on purpose: a reply that is not a JSON array of
 * `{ id, text }` objects is `malformed` in full rather than half-salvaged, because the cost of
 * rejecting it is gibberish (safe, unreadable) while the cost of guessing at it is applying a
 * replacement to a run nobody wrote it for.
 *
 * MALFORMED CANNOT LEAK. `outcome: "malformed"` carries no replacements, and
 * `anonymiseSlideHtml` substitutes every run it has no accepted replacement for, so the worst a
 * broken, empty, truncated or hostile reply can do is produce the output the deterministic
 * anonymiser would have produced on its own. There is no path from a reply to the original text
 * reaching the output: this module never returns the original, and the policy's `unchanged` and
 * `echoes-original` rules reject a reply that tries to hand it back.
 *
 * The prompt states the REJECTION RULES the policy will enforce (same shape, no four consecutive
 * letters or digits reused from ANY run, never the original, never empty). That is not what makes
 * them safe —
 * replacement-policy.ts enforces them whatever the prompt said — but a cooperative model that is
 * told the gate trips it far less often, and every trip costs the user a readable run.
 */
import type { TextRunReplacements } from "./replacement-policy.ts";
import type { TextRun, TextRunId } from "./text-runs.ts";

/** What to send, and the runs it is about, in the order the prompt lists them. */
export type TextRunRewriteRequest = Readonly<{
  prompt: string;
  runs: readonly TextRun[];
}>;

export function textRunRewriteRequest({ runs }: { runs: readonly TextRun[] }): TextRunRewriteRequest {
  const listing = runs
    .map((run) => `${run.id}\t${run.kind}\t${run.text.length} chars\t${JSON.stringify(run.text)}`)
    .join("\n");
  const prompt = [
    "You are helping anonymise one slide so it can be attached to a rendering-bug report.",
    "Below is every visible text run of the slide, one per line, as:",
    "",
    "\tid<TAB>kind<TAB>length<TAB>text (JSON-quoted)",
    "",
    listing,
    "",
    "Write a plausible but entirely FICTIONAL replacement for each run, as if the slide belonged to",
    "an invented company in a similar line of business. The report is read by someone diagnosing a",
    "LAYOUT defect, so the replacement must occupy the same space as the text it replaces.",
    "",
    "Rules, each of which is checked after you answer:",
    "1. Never return the original text, in any casing. A run you cannot rewrite is better left out.",
    "2. Do not reuse FOUR CONSECUTIVE LETTERS OR DIGITS from any run above — not a whole word, and",
    "   not part of one. `Northwind` rules out `Northwi`, `thwind` and `wind`, in every run and not",
    "   only the run it came from. Three letters in a row are fine, so ordinary short words are too.",
    "3. Keep the length within about 10% of the original, and never leave a replacement empty.",
    "4. Keep the shape: the same number of line breaks, the same number of digits in every number",
    "   (so a seven-figure amount stays a seven-figure amount), the same currency symbols,",
    "   separators and trailing punctuation, and the same capitalisation style.",
    "5. Keep the register: a heading stays a heading, a table cell stays a short label.",
    "",
    "Reply with a JSON array and nothing else — no prose, no explanation, no code fence:",
    '[{"id":"<id from the list>","text":"<replacement>"}]',
    "One entry per run, each id exactly once, each `text` a plain string.",
  ].join("\n");
  return { prompt, runs };
}

/**
 * The parse result. A discriminated union rather than a nullable map, because "the model answered
 * nonsense" and "the model answered nothing for half the runs" are different things the review
 * surface should say out loud.
 */
export type TextRunRewriteReply =
  | Readonly<{
      outcome: "parsed";
      /** Pass straight to `anonymiseSlideHtml({ replacements })`; it still judges every entry. */
      replacements: TextRunReplacements;
      /** Ids the reply named that this slide has no run for. Reported, never applied. */
      unknownRunIds: readonly string[];
      /** Runs the reply said nothing about. Each will be gibberish. */
      missingRunIds: readonly TextRunId[];
    }>
  | Readonly<{
      outcome: "malformed";
      /** One sentence for the review surface. Never contains the reply itself. */
      problem: string;
    }>;

export function parseTextRunRewriteReply({
  reply,
  runs,
}: {
  reply: string;
  runs: readonly TextRun[];
}): TextRunRewriteReply {
  const body = withoutCodeFence(reply);
  if (body === "") return { outcome: "malformed", problem: "The model's reply was empty." };

  const parsed = parseJson(body);
  if (parsed.outcome === "failed") {
    return { outcome: "malformed", problem: `The model's reply was not JSON (${parsed.problem}).` };
  }
  if (!Array.isArray(parsed.value)) {
    return { outcome: "malformed", problem: "The model's reply was JSON but not an array of entries." };
  }

  const known = new Set(runs.map((run) => run.id));
  const replacements = new Map<TextRunId, string>();
  const unknownRunIds: string[] = [];
  for (const element of parsed.value) {
    const entry = asEntry(element);
    if (entry === null) {
      return {
        outcome: "malformed",
        problem: 'Every entry of the reply must be an object with exactly an "id" string and a "text" string.',
      };
    }
    if (replacements.has(entry.id) || unknownRunIds.includes(entry.id)) {
      return { outcome: "malformed", problem: `The reply names the run \`${entry.id}\` more than once.` };
    }
    if (!known.has(entry.id)) {
      unknownRunIds.push(entry.id);
      continue;
    }
    replacements.set(entry.id, entry.text);
  }

  return {
    outcome: "parsed",
    replacements,
    unknownRunIds,
    missingRunIds: runs.filter((run) => !replacements.has(run.id)).map((run) => run.id),
  };
}

/**
 * A fenced block is a formatting habit rather than content, so one fence wrapping the WHOLE reply
 * is removed. Anything else — prose around the JSON, two blocks, a half-open fence — is left as it
 * was and fails the JSON parse, which is the intended outcome: the prompt asked for JSON only.
 */
function withoutCodeFence(reply: string): string {
  const trimmed = reply.trim();
  if (!trimmed.startsWith("```") || !trimmed.endsWith("```") || trimmed.length < 6) return trimmed;
  const firstBreak = trimmed.indexOf("\n");
  if (firstBreak < 0) return trimmed;
  return trimmed.slice(firstBreak + 1, trimmed.length - 3).trim();
}

type JsonParse =
  | Readonly<{ outcome: "parsed"; value: unknown }>
  | Readonly<{ outcome: "failed"; problem: string }>;

function parseJson(body: string): JsonParse {
  try {
    return { outcome: "parsed", value: JSON.parse(body) as unknown };
  } catch (error) {
    return { outcome: "failed", problem: error instanceof Error ? error.message : "unparseable" };
  }
}

/** `null` for anything that is not exactly `{ id: string, text: string }`. */
function asEntry(element: unknown): Readonly<{ id: string; text: string }> | null {
  if (typeof element !== "object" || element === null || Array.isArray(element)) return null;
  const keys = Object.keys(element);
  if (keys.length !== 2 || !keys.includes("id") || !keys.includes("text")) return null;
  const record: Readonly<Record<string, unknown>> = element as Readonly<Record<string, unknown>>;
  const { id, text } = record;
  if (typeof id !== "string" || typeof text !== "string" || id === "") return null;
  return { id, text };
}

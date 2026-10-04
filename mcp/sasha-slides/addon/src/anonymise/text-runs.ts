/**
 * text-runs.ts — the VISIBLE text of a slide, run by run, with an id that is stable for the same
 * document.
 *
 * WHY THIS EXISTS AND WHERE ITS BOUNDARY IS. The deterministic substituter is what keeps the
 * anonymiser safe; a model's job is only to make the result READABLE. So the model is shown
 * exactly the runs a human sees on the slide — body text, `<title>`, `alt`, `aria-label`, SVG
 * `<text>` — and NOTHING ELSE. Every structural carrier (`data-*`, `class`, `id`, `href`, CSS
 * `content:`, comments, `<script>`, `data:` images, entity references, every other attribute) is
 * owned by the deterministic engine and is deliberately absent from this list: a model that never
 * sees a carrier cannot be the thing that was supposed to neutralise it.
 *
 * Specifically NOT runs, and each for a reason:
 *   - the `title` ATTRIBUTE and SVG `<title>`/`<desc>` — tooltips and accessibility text that are
 *     not on the slide, so there is no readability to win, and they stay fully deterministic;
 *   - `<textarea>` content — not a thing a slide document renders;
 *   - any text inside `<head>`, which is not rendered at all;
 *   - whitespace-only or punctuation-only text, which has nothing to replace.
 *
 * IDS ARE POSITIONS, not sequence numbers: `t12` is the 12th token of `tokenizeHtml(html)` and
 * `t12a3` is that token's 3rd attribute. Two consequences worth knowing:
 *   1. `extractTextRuns(html)` and `anonymiseSlideHtml({ html, … })` agree on every id without
 *      passing anything between them, because both derive it from the same token stream with the
 *      same `collectTextRunSites`. There is no second walk that could drift.
 *   2. An id is only meaningful for the exact bytes it was extracted from. Edit the HTML and the
 *      ids move — which is correct: a replacement written for a run that no longer exists must not
 *      be applied to whatever took its place. `anonymiseSlideHtml` reports such an id as
 *      `unknown-run` and substitutes instead.
 *
 * WHITESPACE IS NOT PART OF THE RUN. `prefix`/`suffix` hold the source whitespace either side and
 * are re-emitted verbatim around a replacement. Between two inline elements that whitespace IS a
 * space in the rendered line, so a model that trimmed or re-indented it would silently change the
 * layout — the one thing the anonymiser exists to preserve.
 */
import { decodeHtmlEntities } from "./html-entities.ts";
import { tokenizeHtml, type HtmlToken } from "./html-tokens.ts";
import { hasSubstitutableCharacter } from "./substitute-text.ts";

/** The one token kind that carries attributes, named once so the helpers below can say it. */
type HtmlStartTag = Extract<HtmlToken, { kind: "start-tag" }>;

/**
 * Where a run lives, encoded. Opaque to the model and to the UI: compare them, never construct
 * one. See the header for why it is a position rather than an index into this list.
 */
export type TextRunId = string;

/** What the user is looking at when they read this run. Shown next to it in the review surface. */
export type TextRunKind =
  /** Character data on the slide: a heading, a paragraph, a table cell. */
  | "body-text"
  /** The document's `<title>`. Not on the slide, but it is text the author wrote. */
  | "document-title"
  /** Character data inside an SVG `<text>`, `<tspan>` or `<textPath>`. */
  | "svg-text"
  /** An `alt` attribute: the text that stands in for an image. */
  | "image-alternative"
  /** An `aria-label`. */
  | "accessible-label";

/** One run, as the "before" column shows it and as the model is asked about it. */
export type TextRun = Readonly<{
  id: TextRunId;
  kind: TextRunKind;
  /** The visible text, entity references decoded, surrounding whitespace removed. */
  text: string;
}>;

/**
 * The visible text runs of `html`, in document order.
 *
 * This is the ONLY thing that should ever be shown to a model or rendered as the "before" column.
 * It is the user's original text, so it stays in the user's own browser and in the request to the
 * model; it is never part of a defect report — see defect-report.ts.
 */
export function extractTextRuns({ html }: { html: string }): readonly TextRun[] {
  return collectTextRunSites({ tokens: tokenizeHtml(html) }).map(({ id, kind, text }) => ({ id, kind, text }));
}

/**
 * A run plus where it sits in the token stream. The anonymiser needs the position to put a
 * replacement back; nothing outside this directory does.
 */
export type TextRunSite = Readonly<{
  id: TextRunId;
  kind: TextRunKind;
  /** Index into the token array this was collected from. */
  tokenIndex: number;
  /** Index into that token's `attributes`, or `null` for character data. */
  attributeIndex: number | null;
  /** Source whitespace in front of the text. Re-emitted verbatim. */
  prefix: string;
  text: string;
  /** Source whitespace after the text. Re-emitted verbatim. */
  suffix: string;
}>;

export function collectTextRunSites({ tokens }: { tokens: readonly HtmlToken[] }): readonly TextRunSite[] {
  const sites: TextRunSite[] = [];
  const openElements: string[] = [];

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    if (token === undefined) continue;
    switch (token.kind) {
      case "start-tag": {
        for (const site of attributeRunSitesOf({ token, tokenIndex })) sites.push(site);
        if (!token.selfClosing && !VOID_ELEMENTS.has(token.name)) openElements.push(token.name);
        continue;
      }
      case "end-tag": {
        const found = openElements.lastIndexOf(token.name);
        if (found >= 0) openElements.length = found;
        continue;
      }
      case "text": {
        const kind = characterDataKindIn(openElements);
        if (kind === null) continue;
        const site = runSiteOf({ id: textRunIdOf({ tokenIndex, attributeIndex: null }), kind, tokenIndex, attributeIndex: null, source: token.source });
        if (site !== null) sites.push(site);
        continue;
      }
      case "raw-text": {
        // `<title>` is raw text, so its content never arrives as a `text` token. SVG's own
        // `<title>` is tokenised the same way and is deliberately not a run.
        if (token.owner !== "title" || openElements.includes("svg")) continue;
        const site = runSiteOf({ id: textRunIdOf({ tokenIndex, attributeIndex: null }), kind: "document-title", tokenIndex, attributeIndex: null, source: token.text });
        if (site !== null) sites.push(site);
        continue;
      }
      case "comment":
      case "doctype":
      case "cdata":
      case "bogus":
        continue;
      default:
        return assertNever(token);
    }
  }
  return sites;
}

/**
 * The id of the run at a position. The anonymiser calls this while walking the same token stream
 * `collectTextRunSites` walked, which is what makes the two agree by construction.
 */
export function textRunIdOf({ tokenIndex, attributeIndex }: { tokenIndex: number; attributeIndex: number | null }): TextRunId {
  return attributeIndex === null ? `t${tokenIndex}` : `t${tokenIndex}a${attributeIndex}`;
}

/** The attributes whose value is text on (or standing in for) the slide. Nothing else qualifies. */
const TEXT_RUN_ATTRIBUTES: ReadonlyMap<string, TextRunKind> = new Map([
  ["alt", "image-alternative"],
  ["aria-label", "accessible-label"],
]);

/** Elements with no content, so an unclosed one must not stay on the open-element stack. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

/** Inside `<svg>`, only these actually paint their character data. */
const SVG_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["text", "tspan", "textpath"]);

function attributeRunSitesOf({ token, tokenIndex }: { token: HtmlStartTag; tokenIndex: number }): readonly TextRunSite[] {
  const sites: TextRunSite[] = [];
  for (let attributeIndex = 0; attributeIndex < token.attributes.length; attributeIndex += 1) {
    const attribute = token.attributes[attributeIndex];
    if (attribute === undefined || attribute.assign === null) continue;
    const kind = TEXT_RUN_ATTRIBUTES.get(attribute.name.toLowerCase());
    if (kind === undefined) continue;
    const site = runSiteOf({
      id: textRunIdOf({ tokenIndex, attributeIndex }),
      kind,
      tokenIndex,
      attributeIndex,
      source: attribute.value,
    });
    if (site !== null) sites.push(site);
  }
  return sites;
}

/** `null` when this character data is not rendered on the slide. */
function characterDataKindIn(openElements: readonly string[]): TextRunKind | null {
  if (openElements.includes("head")) return null;
  const svgAt = openElements.indexOf("svg");
  if (svgAt < 0) return "body-text";
  return openElements.slice(svgAt + 1).some((name) => SVG_TEXT_ELEMENTS.has(name)) ? "svg-text" : null;
}

/** `null` when there is nothing in `source` a substitution would change, so it is not a run. */
function runSiteOf({
  id,
  kind,
  tokenIndex,
  attributeIndex,
  source,
}: {
  id: TextRunId;
  kind: TextRunKind;
  tokenIndex: number;
  attributeIndex: number | null;
  source: string;
}): TextRunSite | null {
  const leading = /^\s*/.exec(source)?.[0] ?? "";
  const trailing = source.length > leading.length ? (/\s*$/.exec(source)?.[0] ?? "") : "";
  const middle = source.slice(leading.length, source.length - trailing.length);
  const text = decodeHtmlEntities(middle);
  if (!hasSubstitutableCharacter(text)) return null;
  return { id, kind, tokenIndex, attributeIndex, prefix: leading, text, suffix: trailing };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled token while collecting text runs: ${JSON.stringify(value)}`);
}

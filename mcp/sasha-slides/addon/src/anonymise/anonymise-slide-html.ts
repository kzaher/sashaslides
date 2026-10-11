/**
 * anonymise-slide-html.ts — the one entry point: a candidate slide in, a slide that reproduces the
 * same defect and says nothing about its author out.
 *
 * WHAT THE USER SEES IS WHAT GETS SENT. `anonymiseSlideHtml` is the preview. There is no second,
 * richer form of the slide for the report to use, no original kept alongside "just in case", and no
 * way to ask for the report without first producing this value — `previewDefectReport` in
 * defect-report.ts takes an `AnonymisedSlide` and the `DefectReport` is a projection of that
 * preview with nothing added. If a byte is not in `html` here, it cannot be in the payload.
 *
 * THE CARRIERS, and what happens to each. Every byte of the input lands in exactly one HTML token
 * (html-tokens.ts), so this list is complete by construction rather than by vigilance:
 *
 *   character data            substituted, same length and shape      substitute-text.ts
 *                             (a VISIBLE RUN is width-matched lorem ipsum by default, and
 *                             substituted under `textStrategy: { kind: "substitute" }`
 *                                                                              lorem-text.ts)
 *   `<title>`                 substituted (it is raw text, not a tag)
 *   `<textarea>`              substituted
 *   HTML comments             REMOVED — they cannot affect rendering, so there is no case for them
 *   `<script>` bodies         body REMOVED, the element kept so the structure is identical
 *   `<style>` bodies          `content:` strings and selector strings substituted, `url()`
 *                             rewritten, comments removed, everything else byte-identical
 *   `style="..."`             the same CSS transform, entered in declaration context
 *   attribute values          default-deny: substituted unless the name is on an explicit
 *                             geometry/styling allowlist                   attribute-policy.ts
 *   `data-*`                  substituted, consistently, so `[data-x="y"]` still matches
 *   `alt` / `title` / `aria-` substituted
 *   `src` / `srcset` / `poster` / CSS `url(data:image/...)`
 *                             DISCARDED and replaced by a generated placeholder of the same
 *                             intrinsic size                              placeholder-image.ts
 *   `href` / `action` / `cite` scheme kept, everything after it substituted
 *   `srcdoc` / `on*` / `integrity` / `nonce` / `<base href>` / `<iframe src>`
 *                             REMOVED
 *   `<![CDATA[ ]]>`           substituted (it is legal inside `<svg>`)
 *   `<?...?>` and bogus markup REMOVED
 *   entity references         decoded before anything decides what is a letter, so
 *                             `&#65;&#67;&#77;&#69;` is not a way past the text pass
 *
 * WHO WRITES A VISIBLE RUN, and why it changes nothing about the rest of the table. `textStrategy`
 * picks between `"lorem"` (THE DEFAULT: lorem ipsum matched to the original's rendered width, no
 * model and no network) and `"substitute"` (character by character). Every other carrier in the
 * table above is the deterministic engine's under both, and neither has a value that emits the
 * original.
 *
 * MODEL-ASSISTED TEXT, and why it does not move the guarantee one inch. `replacements` offers
 * written text for the VISIBLE RUNS only — body text, `<title>`, `alt`, `aria-label`, SVG `<text>`
 * (text-runs.ts). Every entry is judged by replacement-policy.ts first, and everything it does not
 * accept — a run the reply skipped, an id this slide has no run for, an echo of the original, an
 * empty string, a malformed reply that produced no map at all — takes the substitution path in the
 * table above, unchanged. There is NO value of `replacements` that makes any carrier in that table
 * come out as its original: the model can only trade gibberish for prose. Each rejection is in
 * `rejectedReplacements` with its reason, each accepted run whose shape moved is in `shapeRisks`,
 * and `textRuns` is the after column run by run.
 *
 * FIDELITY LIMITS, measured by fidelity.e2e.ts in real Chrome at 1280x720 over the four candidate
 * fixtures, UNDER BOTH STRATEGIES. Under both: every box the stylesheet positions and sizes is
 * within 0.00px, the document height is unchanged, and EVERY TEXT RUN WRAPS TO THE SAME NUMBER OF
 * LINES (asserted exactly, with no tolerance). What moves is a box whose size is a function of its
 * own text — an inline element's origin, a column of a `table-layout: auto` table, an absolutely
 * positioned label that shrinks to fit:
 *
 *                              worst content-sized drift      mean drift over every box
 *   01-text        13 boxes    4.30px lorem / 11.66px subst.   1.05px / 1.89px
 *   02-table       41 boxes    2.98px lorem /  6.20px subst.   0.98px / 2.07px
 *   03-image        9 boxes    0.02px lorem /  4.58px subst.   0.00px / 0.51px
 *   04-gradient    15 boxes   10.48px lorem / 13.94px subst.   0.89px / 1.22px
 *
 * Lorem is TIGHTER than substitution on every fixture, which is not the result anyone expected: a
 * substituted letter stays inside its glyph-width BUCKET (up to 20% out per letter, and the errors
 * accumulate along the run), while lorem explicitly minimises the summed width error per word
 * against every font model it has a table for. 04-gradient is the weakest fixture under both and
 * for the same reason — a 62px heading with `letter-spacing: -0.02em`, where a two-per-cent width
 * error is ten pixels.
 *
 * A defect that depends on a column being exactly as wide as the user's longest cell may therefore
 * not reproduce on the anonymised copy; a defect about the stylesheet, the geometry, the fills, the
 * borders or the wrapping will.
 *
 * WHAT IS DELIBERATELY NOT NEUTRALISED is in `residualRisksOf` below, returned with every result
 * and meant to be shown next to the preview.
 *
 * `identifiers` has NO default — the caller must choose, because the choice has a measured
 * consequence. **Prefer `"rename"`.** Under `"preserve"` a class such as `.northwind-total`
 * ships verbatim, so a company name survives a slide whose every word was substituted; that is
 * demonstrated in `identifier-policy-leak.test.ts`. The original worry — that renaming breaks
 * the rendering, so the defect stops reproducing — does not hold: renaming is applied
 * consistently across the markup AND the stylesheet, including descendant selectors, so the
 * cascade still matches and the layout is unchanged. `"preserve"` is only the right choice when
 * a human has read `retainedIdentifiers` and judged the names harmless.
 */
import {
  anonymiseCss,
  anonymiseInlineStyle,
  type CssRewrites,
} from "./anonymise-css.ts";
import { attributePolicyFor } from "./attribute-policy.ts";
import { decodeHtmlEntities, encodeHtmlAttributeValue, encodeHtmlCharacterData } from "./html-entities.ts";
import {
  serializeHtmlTokens,
  tokenizeHtml,
  withRawAttributeValue,
  type HtmlAttribute,
  type HtmlToken,
} from "./html-tokens.ts";
import { keyStream } from "./key-stream.ts";
import { documentWordsOf, loremTexter, type LoremTexter } from "./lorem-text.ts";
import { FALLBACK_IMAGE_SIZE, intrinsicImageSize, placeholderImageDataUri, type PixelSize } from "./placeholder-image.ts";
import {
  decideReplacements,
  type RejectedReplacement,
  type ShapeRisk,
  type TextRunReplacements,
} from "./replacement-policy.ts";
import {
  collectTextRunSites,
  textRunIdOf,
  type TextRunId,
  type TextRunKind,
  type TextRunSite,
} from "./text-runs.ts";
import { hasSubstitutableCharacter, textSubstituter, type TextSubstituter } from "./substitute-text.ts";

/** Goes into the report so a payload can be read back by the version of this module that made it. */
export const ANONYMISER_VERSION = "sasha-anonymise/1";

/**
 * What to do with `class` and `id`.
 *
 * `"rename"` is the one to prefer: it replaces them with `c1`/`i1`-style names consistently
 * across the markup and the stylesheet, so selectors keep matching and nothing a name spells out
 * survives. `"preserve"` keeps them verbatim and is only safe once a human has read
 * `retainedIdentifiers`; class names very often spell out exactly what the slide is about.
 */
export type IdentifierPolicy = "preserve" | "rename";

/**
 * WHICH STRATEGY WRITES THE VISIBLE TEXT RUNS. It writes nothing else: every carrier in the table
 * at the top of this file is the deterministic engine's, under every strategy, which is the one
 * thing about this option that is not a preference.
 *
 * `"lorem"` IS THE DEFAULT: lorem ipsum matched to each word's RENDERED WIDTH (lorem-text.ts). It
 * reads as prose, nothing leaves the browser to produce it, and it is a pure function of the text
 * and the seed. Digits are still substituted under it, so a figure keeps its magnitude and its
 * separators rather than turning into words.
 *
 * `"substitute"` is character-by-character substitution — `Dqtfnmlgq fakzqqz 3299532`. Same shape,
 * same width, unreadable, and the only strategy that preserves the original's own whitespace at
 * every position because it preserves the position of every character. Every carrier that is not a
 * visible run is substituted under both.
 *
 * Neither one can emit the original. `replacements` is not a third member here because it is not
 * an alternative to a strategy: an accepted model replacement wins for its own run and the
 * strategy writes every other run, which is the fallback rule the whole architecture rests on.
 */
export type TextStrategy = Readonly<{ kind: "substitute" }> | Readonly<{ kind: "lorem" }>;

export type AnonymiseOptions = Readonly<{
  html: string;
  /**
   * The substitution key. It must be freshly random per report and it NEVER travels with the
   * output: with the seed, the substitution is reversible, and that is the whole point of keeping
   * it out of `AnonymisedSlide` and out of `DefectReport`. Injected rather than generated here so
   * the tests are deterministic and the composition root owns the randomness.
   */
  seed: string;
  identifiers: IdentifierPolicy;
  /**
   * Model-written (or user-edited) text for the visible runs of `html`, keyed by the ids
   * `extractTextRuns` gave them. Absent, incomplete and rejected entries all mean the same thing:
   * that run is substituted deterministically. See replacement-policy.ts for the gate every entry
   * goes through, and note what this option CANNOT do — there is no value of it that makes a run
   * come out as its original text.
   */
  replacements?: TextRunReplacements | undefined;
  /**
   * Which strategy writes the visible runs this slide has no accepted replacement for. Absent
   * means `{ kind: "lorem" }` — see `DEFAULT_TEXT_STRATEGY`.
   */
  textStrategy?: TextStrategy | undefined;
}>;

export type CarrierTreatment =
  | "substituted"
  /** A visible text run written as width-matched lorem ipsum, with no model and no network. */
  | "lorem-ipsum"
  /** A visible text run replaced by model-written text that passed replacement-policy.ts. */
  | "rewritten"
  | "removed"
  | "replaced-with-placeholder"
  | "preserved";

/** One line of the "what happened to your slide" table the preview shows above the HTML. */
export type CarrierTally = Readonly<{
  carrier: string;
  treatment: CarrierTreatment;
  count: number;
}>;

/**
 * A name emitted verbatim. Only VALUES are substituted, so every name in the document — a class, an
 * id, a `data-*` attribute, a custom element — survives, and a name can be as descriptive as the
 * content it labels. These are collected so the preview can list them for the user to read before
 * sending, which is the difference between a known trade-off and a silent leak.
 */
export type IdentifierNamespace = "class" | "id" | "attribute-name" | "element-name";

export type RetainedIdentifier = Readonly<{ namespace: IdentifierNamespace; name: string }>;

/**
 * One visible run as it comes out — the "after" column, run by run.
 *
 * `text` is NEVER the original: it is either the accepted replacement or the substituted gibberish.
 * Pair it with `extractTextRuns(originalHtml)` by `id` to render the before/after table; the before
 * side stays in the user's browser and never reaches a report.
 */
export type AnonymisedTextRun = Readonly<{
  id: TextRunId;
  kind: TextRunKind;
  /** How this text was produced. `"substituted"` is the fallback, and it is the default. */
  origin: "rewritten" | "substituted";
  text: string;
}>;

export type AnonymisedSlide = Readonly<{
  /** Exactly what will be sent. Render this for the preview. */
  html: string;
  carriers: readonly CarrierTally[];
  /** Every visible run, in document order, as it appears in `html`. */
  textRuns: readonly AnonymisedTextRun[];
  /** Offered replacements that did not pass the gate. Each run below is gibberish. */
  rejectedReplacements: readonly RejectedReplacement[];
  /** Accepted replacements whose shape differs enough to put the defect's reproduction at risk. */
  shapeRisks: readonly ShapeRisk[];
  /** Names emitted verbatim. Empty under `identifiers: "rename"`. */
  retainedIdentifiers: readonly RetainedIdentifier[];
  /** Attribute names that were substituted only because nothing recognised them. */
  unrecognisedAttributes: readonly string[];
  /** One sentence per carrier this module knowingly does not neutralise. */
  residualRisks: readonly string[];
}>;

export function anonymiseSlideHtml({
  html,
  seed,
  identifiers,
  replacements,
  textStrategy,
}: AnonymiseOptions): AnonymisedSlide {
  const substituter = textSubstituter({ seed });
  const tally = new Map<string, CarrierTally>();
  const retained = new Map<string, RetainedIdentifier>();
  const unrecognised = new Set<string>();
  const renames = new Map<string, string>();
  let preservedFontData = false;
  let externalUrls = 0;

  const count = ({ carrier, treatment }: { carrier: string; treatment: CarrierTreatment }): void => {
    const key = `${carrier}\u0000${treatment}`;
    const existing = tally.get(key);
    tally.set(key, { carrier, treatment, count: (existing?.count ?? 0) + 1 });
  };

  const retain = ({ namespace, name }: { namespace: IdentifierNamespace; name: string }): void => {
    if (name !== "") retained.set(`${namespace}\u0000${name}`, { namespace, name });
  };

  const identifierFor = ({ namespace, name }: { namespace: "class" | "id"; name: string }): string => {
    if (name === "") return name;
    if (identifiers === "preserve") {
      retain({ namespace, name });
      return name;
    }
    const key = `${namespace}\u0000${name}`;
    const existing = renames.get(key);
    if (existing !== undefined) return existing;
    const minted = `${namespace === "class" ? "c" : "i"}${renames.size + 1}`;
    renames.set(key, minted);
    return minted;
  };

  const rewriteUrl = ({ url, fallbackSize }: { url: string; fallbackSize: PixelSize }): string => {
    const trimmed = url.trim();
    if (trimmed.startsWith("#")) return `#${identifierFor({ namespace: "id", name: trimmed.slice(1) })}`;
    const data = /^data:([^,;]*)/i.exec(trimmed);
    if (data !== null) {
      const mediaType = (data[1] ?? "").toLowerCase();
      if (mediaType.startsWith("image/")) {
        count({ carrier: "embedded image", treatment: "replaced-with-placeholder" });
        return placeholderImageDataUri({
          size: intrinsicImageSize(trimmed) ?? fallbackSize,
          stream: keyStream({ seed, label: `placeholder\u0000${trimmed.length}` }),
        });
      }
      if (FONT_MEDIA_TYPES.some((prefix) => mediaType.startsWith(prefix))) {
        // Kept on purpose: the font IS the geometry, and dropping it would re-flow every line.
        preservedFontData = true;
        count({ carrier: "embedded font", treatment: "preserved" });
        return trimmed;
      }
      count({ carrier: "embedded data: payload", treatment: "removed" });
      return "about:blank";
    }
    if (/^(javascript|blob|filesystem|about|chrome|file):/i.test(trimmed)) {
      count({ carrier: "script or local-file URL", treatment: "removed" });
      return "about:blank";
    }
    if (/^(https?:|ftp:|\/\/)/i.test(trimmed)) externalUrls += 1;
    count({ carrier: "URL", treatment: "substituted" });
    return substituter.url(trimmed);
  };

  const cssRewrites: CssRewrites = {
    substituter,
    rewriteUrl: (url) => rewriteUrl({ url, fallbackSize: FALLBACK_IMAGE_SIZE }),
    renameSelectorIdentifier: ({ sigil, name }) => identifierFor({ namespace: sigil === "." ? "class" : "id", name }),
  };

  // The runs are collected from the SAME token stream the rewrite walks, and a run id is a
  // position in it, so the ids `extractTextRuns` handed the model and the positions this loop
  // visits agree without anything being passed between them.
  const tokens = tokenizeHtml(html);
  const sites = collectTextRunSites({ tokens });
  const decisions = decideReplacements({ sites, replacements: replacements ?? NO_REPLACEMENTS });
  const siteById = new Map(sites.map((site) => [site.id, site]));
  const lorem = runTexterFor({ strategy: textStrategy ?? DEFAULT_TEXT_STRATEGY, seed, sites, substituter });
  const textRuns: AnonymisedTextRun[] = [];
  let loremRuns = 0;
  const runPlan: RunPlan = {
    siteFor: (locator) => siteById.get(textRunIdOf(locator)) ?? null,
    acceptedFor: (id) => decisions.accepted.get(id)?.text ?? null,
    loremFor: (text) => {
      if (lorem === null) return null;
      loremRuns += 1;
      return lorem.plain(text);
    },
    record: (run) => {
      textRuns.push(run);
    },
  };

  let svgDepth = 0;
  const rewritten: HtmlToken[] = [];
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    if (token === undefined) continue;
    if (token.kind === "start-tag" && token.name === "svg" && !token.selfClosing) svgDepth += 1;
    if (token.kind === "end-tag" && token.name === "svg" && svgDepth > 0) svgDepth -= 1;
    const next = rewriteToken({
      token,
      tokenIndex,
      runPlan,
      insideSvg: svgDepth > 0,
      substituter,
      cssRewrites,
      count,
      identifierFor,
      noteUnrecognised: (name) => unrecognised.add(name),
      retain,
      rewriteUrl,
    });
    if (next !== null) rewritten.push(next);
  }

  return {
    html: serializeHtmlTokens(rewritten),
    carriers: [...tally.values()],
    textRuns,
    rejectedReplacements: decisions.rejected,
    shapeRisks: decisions.shapeRisks,
    retainedIdentifiers: [...retained.values()],
    unrecognisedAttributes: [...unrecognised].sort(),
    residualRisks: residualRisksOf({
      identifiers,
      retainedCount: retained.size,
      preservedFontData,
      externalUrls,
      rewrittenRuns: textRuns.filter((run) => run.origin === "rewritten").length,
      loremRuns,
    }),
  };
}

/**
 * The honest list: what a reader of the anonymised slide could still learn. Returned with every
 * result so it is impossible to ship the preview without it.
 */
export function residualRisksOf({
  identifiers,
  retainedCount,
  preservedFontData,
  externalUrls,
  rewrittenRuns,
  loremRuns,
}: {
  identifiers: IdentifierPolicy;
  retainedCount: number;
  preservedFontData: boolean;
  externalUrls: number;
  /** How many visible runs came out as model-written text rather than as substituted gibberish. */
  rewrittenRuns: number;
  /** How many came out as width-matched lorem ipsum under `textStrategy: { kind: "lorem" }`. */
  loremRuns: number;
}): readonly string[] {
  const risks: string[] = [
    "Shape is preserved on purpose: the number of words, their lengths, the line breaks, the number of table rows and the geometry of every box are all unchanged, because that is what reproduces the defect. A slide's shape can suggest its subject.",
    "Numbers keep their digit count, so the ORDER OF MAGNITUDE of every figure survives — a seven-figure amount stays a seven-figure amount.",
    "Colours are preserved exactly, including brand colours.",
    "Font family names are preserved exactly, including a private or custom font name.",
    "A value written as a bare CSS TOKEN rather than as a quoted string — an unquoted `font-family`, a colour, a length, a custom property's keyword value — is preserved verbatim, because substituting it would change the rendering. Such a token cannot become visible text (CSS `content` accepts only quoted strings, `attr()`, `url()` and counters), but it is readable in the markup.",
    "CSS custom property names (`--company-blue`) and `@keyframes` names are preserved; only their string values are substituted.",
    "Only attribute and element VALUES are substituted — every NAME is emitted verbatim, so a `data-q3-actuals` attribute or an `<acme-chart>` element keeps its name. Every such name is listed in `retainedIdentifiers`.",
    "A letter is replaced from within its GLYPH-WIDTH BUCKET so that lines break in the same place, which means the width pattern of the original text survives. Together with the word lengths and the punctuation that is a shape fingerprint: a reader with a dictionary could guess a short, common word from it. It discloses a pattern, never the characters.",
    "`m`/`w` and `I`/`J` are the buckets with a single alternative, so each of those pairs swaps deterministically; a reader learns that a position held one of the two.",
    "A named entity reference outside the Latin-1 letter table (`&alpha;`) passes through as written, so it can carry the single character it denotes.",
    "The placeholder that replaces an image keeps its intrinsic dimensions but not its codec, so a defect specific to how a JPEG or an animated GIF is handled will not reproduce.",
  ];
  if (identifiers === "preserve") {
    risks.push(
      `Class names and ids are emitted verbatim (${retainedCount} of them, listed in \`retainedIdentifiers\`) because the stylesheet selects on them. Use \`identifiers: "rename"\` if a name such as \`.acme-q3-revenue\` is itself content.`,
    );
  }
  if (preservedFontData) {
    risks.push(
      "An embedded `data:` font was preserved byte for byte, because substituting it would change every text metric on the slide. A font file carries a name table and can carry arbitrary bytes.",
    );
  }
  if (loremRuns > 0) {
    risks.push(
      `${loremRuns} visible text run(s) in this preview are LOREM IPSUM matched to the original's rendered width, written here in your browser with no model and no network. The lorem words are from a fixed Latin vocabulary and say nothing about the slide, but what is preserved to make them fit is: the number of words, each word's width and capitalisation, every space and line break at its own position, and every figure's digit count and separators. A word of a single letter, a word holding a digit and a word in a non-Latin script are substituted character by character instead, because no lorem word is that narrow, a figure must stay a figure, and a script must stay its own script.`,
    );
  }
  // Only disclosed when a model actually wrote something. It used to be unconditional, which
  // meant that on the lorem-only path — where nothing leaves the browser — the preview told the
  // user their slide's text had been sent to a model. A false privacy disclosure in the one
  // place a user goes to check is worse than none. See model-risk-copy.test.ts.
  if (rewrittenRuns > 0) {
    risks.push(
      "ASKING A MODEL FOR READABLE REPLACEMENT TEXT SENDS THIS SLIDE'S VISIBLE TEXT TO THAT MODEL — the body text, the `<title>`, every `alt` and `aria-label` and every SVG `<text>`, as you wrote them. That happens when the replacements are requested, which is BEFORE you see this preview, so it is worth knowing in advance rather than afterwards. The model is never shown an attribute, the stylesheet, a comment, a URL or an embedded image, and no reply of its is used unless it differs from the original and reuses no four consecutive letters or digits from any run of it; but a model that deliberately ENCODED the original (base64, an acrostic) would defeat that check, which is why the text in the after column is yours to read before you send it.",
    );
    risks.push(
      `${rewrittenRuns} visible text run(s) in this preview are model-written rather than substituted character by character, so they read as prose a human wrote. Everything in the sentence above about what the model was shown applies to them.`,
    );
  }
  if (externalUrls > 0) {
    risks.push(
      `${externalUrls} external URL(s) were substituted rather than removed, so the document still has a link-shaped value where one was; the host and path are gone.`,
    );
  }
  return risks;
}

const FONT_MEDIA_TYPES: readonly string[] = ["font/", "application/font", "application/x-font", "application/vnd.ms-font"];

/**
 * The run bookkeeping the rewrite needs, in one value: where the runs are, which ones have an
 * accepted replacement, and where to record what each one came out as.
 */
type RunPlan = Readonly<{
  /** `null` unless a VISIBLE RUN lives at exactly this position — see text-runs.ts. */
  siteFor: (locator: Readonly<{ tokenIndex: number; attributeIndex: number | null }>) => TextRunSite | null;
  /** `null` means "substitute": no replacement was offered for this run, or it was rejected. */
  acceptedFor: (id: TextRunId) => string | null;
  /**
   * The lorem text for a run, or `null` under `textStrategy: { kind: "substitute" }` — where there
   * is no run writer at all and the per-carrier substitution path below does the whole job.
   */
  loremFor: (text: string) => string | null;
  record: (run: AnonymisedTextRun) => void;
}>;

const NO_REPLACEMENTS: TextRunReplacements = new Map<TextRunId, string>();

/**
 * THE DEFAULT IS LOREM. A caller that says nothing gets readable, width-matched prose, because a
 * report nobody can diagnose is the failure this product was built to avoid and lorem costs
 * nothing to get it: no model, no network, no word of the user's own.
 *
 * `"substitute"` is still here, and is still what every other carrier uses. It is the right answer
 * for a slide the lorem path cannot speak for — one in a script lorem has no words in, or one
 * where a reviewer wants the original's exact character positions rather than its exact widths.
 */
const DEFAULT_TEXT_STRATEGY: TextStrategy = { kind: "lorem" };

/**
 * The one place the strategy is read. `null` is not a failure: it is the typed absence of a run
 * writer, which is exactly what `"substitute"` is — the carrier table's own substitution path
 * already covers every run, so there is nothing for a run writer to add.
 */
function runTexterFor({
  strategy,
  seed,
  sites,
  substituter,
}: {
  strategy: TextStrategy;
  seed: string;
  sites: readonly TextRunSite[];
  substituter: TextSubstituter;
}): LoremTexter | null {
  switch (strategy.kind) {
    case "substitute":
      return null;
    case "lorem":
      return loremTexter({ seed, documentWords: documentWordsOf({ sites }), substituter });
    default:
      return assertNever(strategy);
  }
}

type TokenRewrite = Readonly<{
  token: HtmlToken;
  tokenIndex: number;
  runPlan: RunPlan;
  insideSvg: boolean;
  substituter: TextSubstituter;
  cssRewrites: CssRewrites;
  count: (options: Readonly<{ carrier: string; treatment: CarrierTreatment }>) => void;
  identifierFor: (options: Readonly<{ namespace: "class" | "id"; name: string }>) => string;
  noteUnrecognised: (name: string) => void;
  retain: (options: Readonly<{ namespace: IdentifierNamespace; name: string }>) => void;
  rewriteUrl: (options: Readonly<{ url: string; fallbackSize: PixelSize }>) => string;
}>;

/** `null` means the token is removed from the output entirely. */
function rewriteToken(rewrite: TokenRewrite): HtmlToken | null {
  const { token, substituter, count } = rewrite;
  switch (token.kind) {
    case "text": {
      const site = rewrite.runPlan.siteFor({ tokenIndex: rewrite.tokenIndex, attributeIndex: null });
      if (site !== null) {
        return { kind: "text", source: rewriteRunCharacterData({ site, source: token.source, carrier: "text", rewrite }) };
      }
      if (!hasSubstitutableCharacter(token.source)) return token;
      count({ carrier: "text", treatment: "substituted" });
      return { kind: "text", source: substituter.htmlText(token.source) };
    }
    case "comment":
      count({ carrier: "HTML comment", treatment: "removed" });
      return null;
    case "bogus":
      count({ carrier: "processing instruction", treatment: "removed" });
      return null;
    case "cdata":
      count({ carrier: "CDATA section", treatment: "substituted" });
      return { ...token, text: substituter.plain(token.text) };
    case "doctype":
      return token;
    case "end-tag":
      return token;
    case "raw-text":
      return rewriteRawText({ token, rewrite });
    case "start-tag": {
      // A custom element name must contain a hyphen, which makes this the exact test for "a tag
      // name the author chose" as opposed to one the HTML or SVG spec did.
      if (token.name.includes("-")) rewrite.retain({ namespace: "element-name", name: token.name });
      const attributes = token.attributes
        .map((attribute, attributeIndex) => rewriteAttribute({ attribute, attributeIndex, token, rewrite }))
        .filter((attribute): attribute is HtmlAttribute => attribute !== null);
      return { ...token, attributes };
    }
    default:
      return assertNever(token);
  }
}

function rewriteRawText({
  token,
  rewrite,
}: {
  token: Readonly<{ kind: "raw-text"; owner: string; text: string }>;
  rewrite: TokenRewrite;
}): HtmlToken {
  const { substituter, cssRewrites, count } = rewrite;
  if (token.owner === "style") {
    count({ carrier: "stylesheet", treatment: "substituted" });
    return { ...token, text: anonymiseCss({ css: token.text, rewrites: cssRewrites }) };
  }
  if (token.owner === "script") {
    // The element stays so the structure is identical; its body does not. A self-contained slide
    // does not need script to render, and a script body can hold anything at all.
    count({ carrier: "inline script body", treatment: "removed" });
    return { ...token, text: "" };
  }
  // `<title>` and `<textarea>` are escapable raw text: entity references ARE decoded in them.
  const carrier = `<${token.owner}> content`;
  const site = rewrite.runPlan.siteFor({ tokenIndex: rewrite.tokenIndex, attributeIndex: null });
  if (site !== null) return { ...token, text: rewriteRunCharacterData({ site, source: token.text, carrier, rewrite }) };
  count({ carrier, treatment: "substituted" });
  return { ...token, text: substituter.htmlText(token.text) };
}

/**
 * A run's character data, either rewritten or substituted, and recorded either way.
 *
 * The run's own leading and trailing whitespace is re-emitted verbatim around a replacement:
 * between two inline elements that whitespace IS a rendered space, so letting the model's answer
 * decide it would move the line.
 */
function rewriteRunCharacterData({
  site,
  source,
  carrier,
  rewrite,
}: {
  site: TextRunSite;
  /** The token's RAW source, entity references still encoded. The fallback path substitutes this. */
  source: string;
  carrier: string;
  rewrite: TokenRewrite;
}): string {
  const accepted = rewrite.runPlan.acceptedFor(site.id);
  if (accepted !== null) {
    rewrite.count({ carrier, treatment: "rewritten" });
    rewrite.runPlan.record({ id: site.id, kind: site.kind, origin: "rewritten", text: accepted });
    return `${site.prefix}${encodeHtmlCharacterData(accepted)}${site.suffix}`;
  }
  const lorem = rewrite.runPlan.loremFor(site.text);
  if (lorem !== null) {
    rewrite.count({ carrier, treatment: "lorem-ipsum" });
    // `origin` stays `"substituted"`: it says WHO wrote the text, and lorem is the engine writing
    // it, not the model. Which engine strategy wrote it is the caller's own `textStrategy`.
    rewrite.runPlan.record({ id: site.id, kind: site.kind, origin: "substituted", text: lorem });
    return `${site.prefix}${encodeHtmlCharacterData(lorem)}${site.suffix}`;
  }
  rewrite.count({ carrier, treatment: "substituted" });
  const substituted = rewrite.substituter.htmlText(source);
  rewrite.runPlan.record({
    id: site.id,
    kind: site.kind,
    origin: "substituted",
    text: decodeHtmlEntities(substituted).trim(),
  });
  return substituted;
}

function rewriteAttribute({
  attribute,
  attributeIndex,
  token,
  rewrite,
}: {
  attribute: HtmlAttribute;
  attributeIndex: number;
  token: Readonly<{ name: string; attributes: readonly HtmlAttribute[] }>;
  rewrite: TokenRewrite;
}): HtmlAttribute | null {
  if (attribute.assign === null) return attribute;
  const policy = attributePolicyFor({
    tagName: token.name,
    attributeName: attribute.name,
    tagAttributes: token.attributes,
    insideSvg: rewrite.insideSvg,
  });
  const lowercaseName = attribute.name.toLowerCase();
  if (!policy.known) rewrite.noteUnrecognised(lowercaseName);
  if (!policy.known || lowercaseName.startsWith("data-")) {
    rewrite.retain({ namespace: "attribute-name", name: lowercaseName });
  }

  const quote: '"' | "'" = attribute.quote === "'" ? "'" : '"';
  const label = `${attribute.name.toLowerCase()} attribute`;
  const raw = (text: string): HtmlAttribute => withRawAttributeValue({ attribute, raw: text });
  const asText = (text: string): HtmlAttribute => raw(encodeHtmlAttributeValue({ text, quote }));

  // A visible run (`alt`, `aria-label`) may be rewritten, but ONLY where the deterministic engine
  // would have substituted the value anyway: if the allowlist ever starts preserving one of these
  // as geometry, a model proposal must not be the thing that overrides it.
  const site = rewrite.runPlan.siteFor({ tokenIndex: rewrite.tokenIndex, attributeIndex });
  if (site !== null && policy.action === "substitute-text") {
    return raw(rewriteRunAttributeValue({ site, attribute, label, quote, rewrite }));
  }

  switch (policy.action) {
    case "preserve":
      return attribute;
    case "drop":
      rewrite.count({ carrier: label, treatment: "removed" });
      return null;
    case "substitute-text":
      if (!hasSubstitutableCharacter(attribute.value)) return attribute;
      rewrite.count({ carrier: label, treatment: "substituted" });
      return raw(rewrite.substituter.htmlAttributeValue({ raw: attribute.value, quote }));
    case "inline-style":
      rewrite.count({ carrier: "style attribute", treatment: "substituted" });
      return asText(
        anonymiseInlineStyle({ declarations: decodeHtmlEntities(attribute.value), rewrites: rewrite.cssRewrites }),
      );
    case "css-value": {
      // The CSS transform works on declarations, so the value is wrapped in one and unwrapped
      // again. It copies everything through except `url()` and strings, which is the point.
      const declaration = `${lowercaseName}:${decodeHtmlEntities(attribute.value)}`;
      const transformed = anonymiseInlineStyle({ declarations: declaration, rewrites: rewrite.cssRewrites });
      return asText(transformed.slice(lowercaseName.length + 1));
    }
    case "substitute-url":
      return asText(
        rewrite.rewriteUrl({
          url: decodeHtmlEntities(attribute.value),
          fallbackSize: declaredImageSize(token.attributes),
        }),
      );
    case "image-source":
      return asText(
        rewriteImageSource({
          value: decodeHtmlEntities(attribute.value),
          fallbackSize: declaredImageSize(token.attributes),
          rewrite,
        }),
      );
    case "class-names":
      return asText(
        splitTokens(decodeHtmlEntities(attribute.value))
          .map((name) => rewrite.identifierFor({ namespace: "class", name }))
          .join(" "),
      );
    case "element-id":
      return asText(rewrite.identifierFor({ namespace: "id", name: decodeHtmlEntities(attribute.value).trim() }));
    case "id-references":
      return asText(
        splitTokens(decodeHtmlEntities(attribute.value))
          .map((name) => rewrite.identifierFor({ namespace: "id", name }))
          .join(" "),
      );
    case "id-fragment": {
      const value = decodeHtmlEntities(attribute.value).trim();
      if (!value.startsWith("#")) return asText(rewrite.rewriteUrl({ url: value, fallbackSize: FALLBACK_IMAGE_SIZE }));
      return asText(`#${rewrite.identifierFor({ namespace: "id", name: value.slice(1) })}`);
    }
    default:
      return assertNever(policy.action);
  }
}

/** The `alt` / `aria-label` twin of `rewriteRunCharacterData`: a raw, escaped attribute value. */
function rewriteRunAttributeValue({
  site,
  attribute,
  label,
  quote,
  rewrite,
}: {
  site: TextRunSite;
  attribute: HtmlAttribute;
  label: string;
  quote: '"' | "'";
  rewrite: TokenRewrite;
}): string {
  const accepted = rewrite.runPlan.acceptedFor(site.id);
  if (accepted !== null) {
    rewrite.count({ carrier: label, treatment: "rewritten" });
    rewrite.runPlan.record({ id: site.id, kind: site.kind, origin: "rewritten", text: accepted });
    return encodeHtmlAttributeValue({ text: `${site.prefix}${accepted}${site.suffix}`, quote });
  }
  const lorem = rewrite.runPlan.loremFor(site.text);
  if (lorem !== null) {
    rewrite.count({ carrier: label, treatment: "lorem-ipsum" });
    rewrite.runPlan.record({ id: site.id, kind: site.kind, origin: "substituted", text: lorem });
    return encodeHtmlAttributeValue({ text: `${site.prefix}${lorem}${site.suffix}`, quote });
  }
  rewrite.count({ carrier: label, treatment: "substituted" });
  const substituted = rewrite.substituter.htmlAttributeValue({ raw: attribute.value, quote });
  rewrite.runPlan.record({
    id: site.id,
    kind: site.kind,
    origin: "substituted",
    text: decodeHtmlEntities(substituted).trim(),
  });
  return substituted;
}

/**
 * `srcset` is a comma-separated list of `url descriptor` pairs, and each url is its own image. The
 * descriptors are geometry and survive; every url is replaced.
 */
function rewriteImageSource({
  value,
  fallbackSize,
  rewrite,
}: {
  value: string;
  fallbackSize: PixelSize;
  rewrite: TokenRewrite;
}): string {
  if (!value.includes(",") || /^data:/i.test(value.trim())) {
    return rewrite.rewriteUrl({ url: value, fallbackSize });
  }
  return value
    .split(",")
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const url = parts[0] ?? "";
      const descriptor = parts.slice(1).join(" ");
      const replaced = rewrite.rewriteUrl({ url, fallbackSize });
      return descriptor === "" ? replaced : `${replaced} ${descriptor}`;
    })
    .join(", ");
}

/**
 * The size to generate a placeholder at when the original's header cannot be read — an external
 * source, which this module will not fetch. The element's own `width`/`height` are the best
 * available answer; `FALLBACK_IMAGE_SIZE` is the last resort.
 */
function declaredImageSize(attributes: readonly HtmlAttribute[]): PixelSize {
  const numberOf = (name: string): number | null => {
    const found = attributes.find((attribute) => attribute.name.toLowerCase() === name);
    if (found === undefined) return null;
    const parsed = Number.parseFloat(found.value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  const width = numberOf("width");
  const height = numberOf("height");
  if (width === null || height === null) return FALLBACK_IMAGE_SIZE;
  return { widthPx: width, heightPx: height };
}

function splitTokens(value: string): readonly string[] {
  return value.split(/\s+/).filter((part) => part !== "");
}

function assertNever(value: never): never {
  throw new Error(`Unhandled anonymiser case: ${JSON.stringify(value)}`);
}

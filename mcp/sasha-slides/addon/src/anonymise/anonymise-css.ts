/**
 * anonymise-css.ts — CSS in, CSS out, with the carriers inside it neutralised and nothing else
 * touched.
 *
 * CSS is the part of a slide that MUST come out unchanged: it is the geometry, the colours, the
 * fonts and the cascade, which is to say it is the defect. So this is not a CSS parser that
 * re-prints a tree — it is a scanner that hands back every byte of the input in order, labelled,
 * and a transform that rewrites four labels and copies the rest. `anonymiseCss` with an identity
 * substituter is the identity function, which anonymise-css.test.ts asserts over the real fixtures.
 *
 * The four things inside a stylesheet that can carry the user's content:
 *   1. `content: "Q3 actuals"` — a string in a declaration. Substituted.
 *   2. `[data-owner="a.mcbride"]` — a string in a selector. Substituted, with the SAME mapping the
 *      attribute itself gets (substitute-text.ts memoises), so the selector still matches.
 *   3. `url(data:image/svg+xml,<svg><text>Acme</text></svg>)` — an image, or anything at all.
 *      Handed to the caller's `rewriteUrl`.
 *   4. `/* figures from the Q3 board pack *\/` — a comment. Removed outright.
 *
 * And the two kinds of string that are NOT content and must survive verbatim, because substituting
 * them would change the rendering rather than the information: a font family name (`font-family`,
 * `font`, `src`) and a layout string (`grid-template-areas`, `quotes`). Those are named in
 * `PRESERVED_STRING_PROPERTIES`; everything else defaults to being substituted, so a property this
 * file has never heard of is anonymised rather than trusted.
 */
import type { TextSubstituter } from "./substitute-text.ts";

/** Where in the grammar a piece sits. Selector context is also an at-rule prelude. */
export type CssContext = "selector" | "declaration";

export type CssPiece =
  | Readonly<{ kind: "comment"; source: string }>
  | Readonly<{ kind: "string"; quote: '"' | "'"; raw: string; context: CssContext; property: string | null }>
  /** A whole `url(...)` token. `inner` is the URL without quotes; `source` is the token verbatim. */
  | Readonly<{ kind: "url"; source: string; inner: string; quote: '"' | "'" | ""; property: string | null }>
  /** Everything else, verbatim: selectors, declarations, braces, whitespace. */
  | Readonly<{ kind: "code"; text: string; context: CssContext }>;

export type CssRewrites = Readonly<{
  substituter: TextSubstituter;
  /** A `url(...)` payload in, its replacement out. The orchestrator owns the policy. */
  rewriteUrl: (url: string) => string;
  /**
   * A `.class` or `#id` name as written in a selector in, the name to emit out. Identity when
   * preserving. The sigil travels with it because the two live in different namespaces: a renamed
   * `.card` and a renamed `#card` must not become the same name.
   */
  renameSelectorIdentifier: (options: Readonly<{ sigil: "." | "#"; name: string }>) => string;
}>;

export function anonymiseCss({ css, rewrites }: { css: string; rewrites: CssRewrites }): string {
  return scanCss(css).map((piece) => rewritePiece({ piece, rewrites })).join("");
}

/**
 * An inline `style="..."` attribute: the same transform, entered in declaration context because
 * there is no selector or brace around it.
 */
export function anonymiseInlineStyle({ declarations, rewrites }: { declarations: string; rewrites: CssRewrites }): string {
  return anonymiseCss({ css: `*{${declarations}}`, rewrites }).slice(2, -1);
}

/** Every byte of `css`, in order, labelled. `scanCss(x).map(source).join("") === x`. */
export function scanCss(css: string): readonly CssPiece[] {
  const pieces: CssPiece[] = [];
  const contexts: CssContext[] = ["selector"];
  let code = "";
  let property: string | null = null;
  let preludeStart = 0;
  let at = 0;

  const context = (): CssContext => contexts[contexts.length - 1] ?? "selector";
  const flush = (): void => {
    if (code === "") return;
    pieces.push({ kind: "code", text: code, context: context() });
    code = "";
  };

  while (at < css.length) {
    const character = css.charAt(at);

    if (css.startsWith("/*", at)) {
      flush();
      const close = css.indexOf("*/", at + 2);
      const end = close < 0 ? css.length : close + 2;
      pieces.push({ kind: "comment", source: css.slice(at, end) });
      at = end;
      continue;
    }
    if (character === '"' || character === "'") {
      flush();
      const read = readCssString({ css, from: at, quote: character });
      pieces.push({ kind: "string", quote: character, raw: read.raw, context: context(), property });
      at = read.end;
      continue;
    }
    if (/^url\(/i.test(css.slice(at, at + 4))) {
      flush();
      const read = readUrlToken({ css, from: at });
      pieces.push({ kind: "url", source: read.source, inner: read.inner, quote: read.quote, property });
      at = read.end;
      continue;
    }
    if (character === "{") {
      code += character;
      flush();
      contexts.push(blockContextFor(css.slice(preludeStart, at)));
      property = null;
      at += 1;
      preludeStart = at;
      continue;
    }
    if (character === "}") {
      code += character;
      flush();
      if (contexts.length > 1) contexts.pop();
      property = null;
      at += 1;
      preludeStart = at;
      continue;
    }
    if (character === ";") {
      code += character;
      property = null;
      at += 1;
      if (context() === "selector") preludeStart = at;
      continue;
    }
    if (character === ":" && context() === "declaration" && property === null) {
      property = propertyNameBefore({ css, colonAt: at });
      code += character;
      at += 1;
      continue;
    }
    code += character;
    at += 1;
  }
  flush();
  return pieces;
}

export function serializeCssPieces(pieces: readonly CssPiece[]): string {
  return pieces.map(sourceOfPiece).join("");
}

/**
 * Properties whose string values are rendering instructions, not content.
 *
 * `font-family`/`font`/`src` because the brief's rule is that fonts are preserved exactly — the
 * font IS the defect in a metrics bug. The grid and `quotes` strings because they are layout
 * grammar: substituting the letters of `"header header"` would re-flow the whole slide.
 */
const PRESERVED_STRING_PROPERTIES: ReadonlySet<string> = new Set([
  "font",
  "font-family",
  "src",
  "grid",
  "grid-template",
  "grid-template-areas",
  "grid-area",
  "quotes",
  "will-change",
  "transition",
  "animation",
  "animation-name",
]);

function rewritePiece({ piece, rewrites }: { piece: CssPiece; rewrites: CssRewrites }): string {
  switch (piece.kind) {
    case "comment":
      // A comment cannot affect rendering, so there is no reason to keep one and every reason not to.
      return "";
    case "string": {
      if (preservesString(piece)) return sourceOfPiece(piece);
      const substituted = rewrites.substituter.plain(unescapeCssString(piece.raw));
      return `${piece.quote}${escapeCssString({ text: substituted, quote: piece.quote })}${piece.quote}`;
    }
    case "url":
      return `url(${piece.quote}${rewrites.rewriteUrl(piece.inner)}${piece.quote})`;
    case "code":
      return piece.context === "selector" ? renameSelectorIdentifiers({ text: piece.text, rewrites }) : piece.text;
    default:
      return assertNever(piece);
  }
}

function preservesString(piece: Readonly<{ context: CssContext; property: string | null }>): boolean {
  if (piece.context === "selector") return false;
  return piece.property !== null && PRESERVED_STRING_PROPERTIES.has(piece.property);
}

/**
 * `.name` and `#name` in a selector. A colour literal (`#1b1b1f`) cannot reach here: it only ever
 * appears in a declaration, and declaration code is copied through untouched.
 */
function renameSelectorIdentifiers({ text, rewrites }: { text: string; rewrites: CssRewrites }): string {
  return text.replace(SELECTOR_IDENTIFIER, (whole, sigil: string, name: string) => {
    if (sigil !== "." && sigil !== "#") return whole;
    const renamed = rewrites.renameSelectorIdentifier({ sigil, name });
    return renamed === name ? whole : `${sigil}${renamed}`;
  });
}

/** A class or id selector: the CSS identifier grammar, minus escapes, which no slide uses. */
const SELECTOR_IDENTIFIER = /([.#])(-?[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff-]*)/g;

function sourceOfPiece(piece: CssPiece): string {
  switch (piece.kind) {
    case "comment":
      return piece.source;
    case "string":
      return `${piece.quote}${piece.raw}${piece.quote}`;
    case "url":
      return piece.source;
    case "code":
      return piece.text;
    default:
      return assertNever(piece);
  }
}

function readCssString({ css, from, quote }: { css: string; from: number; quote: string }): Readonly<{ raw: string; end: number }> {
  let at = from + 1;
  let raw = "";
  while (at < css.length) {
    const character = css.charAt(at);
    if (character === "\\") {
      raw += css.slice(at, at + 2);
      at += 2;
      continue;
    }
    if (character === quote) return { raw, end: at + 1 };
    raw += character;
    at += 1;
  }
  return { raw, end: css.length };
}

function readUrlToken({ css, from }: { css: string; from: number }): Readonly<{ source: string; inner: string; quote: '"' | "'" | ""; end: number }> {
  let at = from + 4;
  while (at < css.length && /\s/.test(css.charAt(at))) at += 1;
  const opener = css.charAt(at);
  if (opener === '"' || opener === "'") {
    const read = readCssString({ css, from: at, quote: opener });
    const close = css.indexOf(")", read.end);
    const end = close < 0 ? css.length : close + 1;
    return { source: css.slice(from, end), inner: read.raw, quote: opener, end };
  }
  const close = css.indexOf(")", at);
  const end = close < 0 ? css.length : close + 1;
  return { source: css.slice(from, end), inner: css.slice(at, end - 1).trim(), quote: "", end };
}

/**
 * What a `{` opens. A conditional group rule's body holds more selectors; anything else holds
 * declarations. `@keyframes` counts as a group because its body holds keyframe selectors.
 */
function blockContextFor(prelude: string): CssContext {
  const atKeyword = /^\s*@([a-zA-Z-]+)/.exec(prelude);
  if (atKeyword === null) return "declaration";
  return GROUP_AT_RULES.has((atKeyword[1] ?? "").toLowerCase()) ? "selector" : "declaration";
}

const GROUP_AT_RULES: ReadonlySet<string> = new Set([
  "media",
  "supports",
  "container",
  "layer",
  "scope",
  "document",
  "keyframes",
  "-webkit-keyframes",
  "-moz-keyframes",
]);

function propertyNameBefore({ css, colonAt }: { css: string; colonAt: number }): string | null {
  let at = colonAt - 1;
  while (at >= 0 && /[\w-]/.test(css.charAt(at))) at -= 1;
  const name = css.slice(at + 1, colonAt).toLowerCase();
  return name === "" ? null : name;
}

/** CSS string escapes are `\`-prefixed; the substituter works on the characters they denote. */
function unescapeCssString(raw: string): string {
  return raw.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_whole, body: string) => {
    if (/^[0-9a-fA-F]/.test(body)) {
      const code = Number.parseInt(body.trim(), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "";
    }
    return body === "\n" ? "" : body;
  });
}

function escapeCssString({ text, quote }: { text: string; quote: string }): string {
  return text.replace(/\\/g, "\\\\").replace(new RegExp(quote, "g"), `\\${quote}`).replace(/\n/g, "\\a ");
}

function assertNever(value: never): never {
  throw new Error(`Unhandled css piece: ${JSON.stringify(value)}`);
}

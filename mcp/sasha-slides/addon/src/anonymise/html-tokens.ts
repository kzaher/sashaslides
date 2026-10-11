/**
 * html-tokens.ts — a byte-exact HTML token stream, and the serializer that puts it back.
 *
 * WHY NOT DOMParser. Three reasons, in order of how much they matter:
 *
 *   1. A DOM round-trip is not byte-exact. `innerHTML` renormalises attribute quoting, drops the
 *      exact whitespace inside tags, re-encodes entities, and inserts the tags the parser inferred
 *      (`<tbody>`). The brief's rule is "layout, CSS, class names, element structure, fonts,
 *      colours and geometry are preserved exactly" — anything the anonymiser does not deliberately
 *      change must come out as the same bytes, and a token stream is how that is guaranteed:
 *      `serializeHtmlTokens(tokenizeHtml(html)) === html` for every input, which
 *      html-tokens.test.ts asserts over the real fixtures.
 *   2. There is no DOMParser in plain node, and the brief asks for a module that can be tested
 *      exhaustively there.
 *   3. A DOM hides things. Comments, `<!doctype>`, CDATA inside `<svg>`, bogus comments and the
 *      exact raw text of `<style>` are all carriers, and a tokeniser cannot silently lose one:
 *      every byte of the input lands in exactly one token, so the rewriter's `switch` over
 *      `HtmlToken["kind"]` is a complete enumeration of the carriers by construction.
 *
 * This is NOT a conformant HTML5 tokeniser and does not try to be — it has no insertion modes, no
 * tag-name correction and no entity table. It is a lossless lexer for documents of the shape
 * PROTOCOL.md requires (a self-contained 1280x720 document), and the one place it could disagree
 * with a browser — a `<` that is not a tag — it resolves the way browsers do, as text.
 */
import { encodeHtmlAttributeValue } from "./html-entities.ts";

/** One attribute, carrying enough source detail to be re-emitted unchanged. */
export type HtmlAttribute = Readonly<{
  /** Source whitespace before the name. Re-emitted verbatim. */
  before: string;
  /** As written, case included: `attributeActionFor` lowercases, the serializer does not. */
  name: string;
  /** Source between the name and the opening quote, `=` included. `null` for a bare attribute. */
  assign: string | null;
  /** `""` for an unquoted value. */
  quote: '"' | "'" | "";
  /** RAW source of the value: entity references are still encoded. */
  value: string;
}>;

export type HtmlToken =
  /** Character data. `source` still holds entity references; see substitute-text.ts. */
  | Readonly<{ kind: "text"; source: string }>
  /**
   * `<!-- ... -->`. `text` excludes the delimiters. `terminated` is false for a comment that runs
   * to the end of the document, which a browser still treats as a comment — carrying it keeps the
   * round-trip exact instead of inventing a `-->`.
   */
  | Readonly<{ kind: "comment"; text: string; terminated: boolean }>
  /** `<!doctype html>` and friends, verbatim including the delimiters. */
  | Readonly<{ kind: "doctype"; source: string }>
  /** `<![CDATA[ ... ]]>`, which is legal inside `<svg>`. `text` excludes the delimiters. */
  | Readonly<{ kind: "cdata"; text: string; terminated: boolean }>
  /** `<?xml ... >` and other junk a browser treats as a bogus comment. Verbatim. */
  | Readonly<{ kind: "bogus"; source: string }>
  | Readonly<{
      kind: "start-tag";
      /** Lowercased, for dispatch. `sourceName` is what gets re-emitted. */
      name: string;
      sourceName: string;
      attributes: readonly HtmlAttribute[];
      /** Source whitespace between the last attribute and the `>`. */
      trailing: string;
      selfClosing: boolean;
    }>
  | Readonly<{ kind: "end-tag"; name: string; sourceName: string; trailing: string }>
  /**
   * The whole content of a raw-text element, as one token. `owner` is the lowercased tag name —
   * `style`, `script`, `textarea` or `title`, the four elements whose content a browser does not
   * parse as markup and each of which needs its own treatment.
   */
  | Readonly<{ kind: "raw-text"; owner: string; text: string }>;

export function tokenizeHtml(html: string): readonly HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let at = 0;

  while (at < html.length) {
    const openAt = html.indexOf("<", at);
    if (openAt < 0) {
      tokens.push({ kind: "text", source: html.slice(at) });
      break;
    }
    if (openAt > at) tokens.push({ kind: "text", source: html.slice(at, openAt) });

    const markup = readMarkup({ html, openAt });
    if (markup === null) {
      // A `<` that begins nothing: browsers show it, so it is text.
      tokens.push({ kind: "text", source: "<" });
      at = openAt + 1;
      continue;
    }
    tokens.push(markup.token);
    at = markup.end;

    if (markup.token.kind === "start-tag" && !markup.token.selfClosing && RAW_TEXT_ELEMENTS.has(markup.token.name)) {
      const raw = readRawText({ html, from: at, owner: markup.token.name });
      if (raw.text !== "") tokens.push({ kind: "raw-text", owner: markup.token.name, text: raw.text });
      at = raw.end;
    }
  }
  return tokens;
}

/** The inverse of `tokenizeHtml`, byte for byte. */
export function serializeHtmlTokens(tokens: readonly HtmlToken[]): string {
  return tokens.map(serializeToken).join("");
}

/** `name`'s attribute, or `null`. Lowercase comparison, because HTML attribute names are ASCII-insensitive. */
export function attributeNamed({
  token,
  name,
}: {
  token: Readonly<{ attributes: readonly HtmlAttribute[] }>;
  name: string;
}): HtmlAttribute | null {
  const wanted = name.toLowerCase();
  return token.attributes.find((attribute) => attribute.name.toLowerCase() === wanted) ?? null;
}

/**
 * The same attribute with a new value, quoted and escaped so it survives re-parsing.
 *
 * An unquoted source value is promoted to double quotes rather than kept bare: a substitute can
 * contain characters (a space, a `>`) that would end an unquoted value, and silently producing
 * different markup is exactly what this module must not do.
 */
export function withAttributeValue({ attribute, value }: { attribute: HtmlAttribute; value: string }): HtmlAttribute {
  const quote = attribute.quote === "" ? '"' : attribute.quote;
  return { ...attribute, assign: attribute.assign ?? "=", quote, value: encodeHtmlAttributeValue({ text: value, quote }) };
}

/** The same attribute with a value already escaped by the caller (a CSS or URL rewrite). */
export function withRawAttributeValue({ attribute, raw }: { attribute: HtmlAttribute; raw: string }): HtmlAttribute {
  const quote = attribute.quote === "" ? '"' : attribute.quote;
  return { ...attribute, assign: attribute.assign ?? "=", quote, value: raw };
}

/** The four elements whose content is not markup. Each is handled separately by the rewriter. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style", "textarea", "title"]);

function serializeToken(token: HtmlToken): string {
  switch (token.kind) {
    case "text":
      return token.source;
    case "comment":
      return `<!--${token.text}${token.terminated ? "-->" : ""}`;
    case "doctype":
      return token.source;
    case "cdata":
      return `<![CDATA[${token.text}${token.terminated ? "]]>" : ""}`;
    case "bogus":
      return token.source;
    case "raw-text":
      return token.text;
    case "start-tag":
      return `<${token.sourceName}${token.attributes.map(serializeAttribute).join("")}${token.trailing}${
        token.selfClosing ? "/>" : ">"
      }`;
    case "end-tag":
      return `</${token.sourceName}${token.trailing}>`;
    default:
      return assertNever(token);
  }
}

function serializeAttribute(attribute: HtmlAttribute): string {
  if (attribute.assign === null) return `${attribute.before}${attribute.name}`;
  return `${attribute.before}${attribute.name}${attribute.assign}${attribute.quote}${attribute.value}${attribute.quote}`;
}

type MarkupRead = Readonly<{ token: HtmlToken; end: number }>;

function readMarkup({ html, openAt }: { html: string; openAt: number }): MarkupRead | null {
  const rest = html.slice(openAt);
  if (rest.startsWith("<!--")) {
    const close = html.indexOf("-->", openAt + 4);
    const text = close < 0 ? html.slice(openAt + 4) : html.slice(openAt + 4, close);
    return { token: { kind: "comment", text, terminated: close >= 0 }, end: close < 0 ? html.length : close + 3 };
  }
  if (rest.startsWith("<![CDATA[")) {
    const close = html.indexOf("]]>", openAt + 9);
    const text = close < 0 ? html.slice(openAt + 9) : html.slice(openAt + 9, close);
    return { token: { kind: "cdata", text, terminated: close >= 0 }, end: close < 0 ? html.length : close + 3 };
  }
  if (rest.startsWith("<!") || rest.startsWith("<?")) {
    const close = html.indexOf(">", openAt);
    const end = close < 0 ? html.length : close + 1;
    const source = html.slice(openAt, end);
    const kind = /^<!doctype/i.test(source) ? "doctype" : "bogus";
    return { token: kind === "doctype" ? { kind: "doctype", source } : { kind: "bogus", source }, end };
  }
  if (rest.startsWith("</")) {
    const nameMatch = /^<\/([a-zA-Z][^\s/>]*)([^>]*)>/.exec(rest);
    if (nameMatch === null) return null;
    const sourceName = nameMatch[1] ?? "";
    const trailing = nameMatch[2] ?? "";
    return {
      token: { kind: "end-tag", name: sourceName.toLowerCase(), sourceName, trailing },
      end: openAt + nameMatch[0].length,
    };
  }
  const startName = /^<([a-zA-Z][^\s/>]*)/.exec(rest);
  if (startName === null) return null;
  const sourceName = startName[1] ?? "";
  return readStartTag({ html, from: openAt + startName[0].length, sourceName });
}

function readStartTag({ html, from, sourceName }: { html: string; from: number; sourceName: string }): MarkupRead {
  const attributes: HtmlAttribute[] = [];
  let at = from;

  for (;;) {
    const whitespaceStart = at;
    while (at < html.length && isHtmlWhitespace(html.charAt(at))) at += 1;
    const before = html.slice(whitespaceStart, at);

    if (at >= html.length) {
      return { token: startTag({ sourceName, attributes, trailing: before, selfClosing: false }), end: html.length };
    }
    if (html.charAt(at) === ">") {
      return { token: startTag({ sourceName, attributes, trailing: before, selfClosing: false }), end: at + 1 };
    }
    if (html.startsWith("/>", at)) {
      return { token: startTag({ sourceName, attributes, trailing: before, selfClosing: true }), end: at + 2 };
    }
    if (html.charAt(at) === "/") {
      // A stray solidus inside the tag. Keep it as part of the whitespace run so it round-trips.
      at += 1;
      attributes.push({ before: `${before}/`, name: "", assign: null, quote: "", value: "" });
      continue;
    }

    const nameStart = at;
    while (at < html.length && !isHtmlWhitespace(html.charAt(at)) && !"=/>".includes(html.charAt(at))) at += 1;
    const name = html.slice(nameStart, at);
    if (name === "") {
      // Nothing consumable — bail rather than spin. The remaining bytes become the trailing run.
      const close = html.indexOf(">", at);
      const end = close < 0 ? html.length : close;
      attributes.push({ before, name: html.slice(at, end), assign: null, quote: "", value: "" });
      return {
        token: startTag({ sourceName, attributes, trailing: "", selfClosing: false }),
        end: close < 0 ? html.length : close + 1,
      };
    }

    const assignStart = at;
    while (at < html.length && isHtmlWhitespace(html.charAt(at))) at += 1;
    if (html.charAt(at) !== "=") {
      attributes.push({ before, name, assign: null, quote: "", value: "" });
      at = assignStart;
      continue;
    }
    at += 1;
    while (at < html.length && isHtmlWhitespace(html.charAt(at))) at += 1;
    const assign = html.slice(assignStart, at);

    const opener = html.charAt(at);
    if (opener === '"' || opener === "'") {
      const close = html.indexOf(opener, at + 1);
      const valueEnd = close < 0 ? html.length : close;
      attributes.push({ before, name, assign, quote: opener, value: html.slice(at + 1, valueEnd) });
      at = close < 0 ? html.length : close + 1;
      continue;
    }
    const valueStart = at;
    while (at < html.length && !isHtmlWhitespace(html.charAt(at)) && html.charAt(at) !== ">") at += 1;
    attributes.push({ before, name, assign, quote: "", value: html.slice(valueStart, at) });
  }
}

function startTag({
  sourceName,
  attributes,
  trailing,
  selfClosing,
}: {
  sourceName: string;
  attributes: readonly HtmlAttribute[];
  trailing: string;
  selfClosing: boolean;
}): HtmlToken {
  return { kind: "start-tag", name: sourceName.toLowerCase(), sourceName, attributes, trailing, selfClosing };
}

function readRawText({ html, from, owner }: { html: string; from: number; owner: string }): Readonly<{ text: string; end: number }> {
  const closing = new RegExp(`</${owner}[\\s/>]`, "i");
  const found = closing.exec(html.slice(from));
  if (found === null) return { text: html.slice(from), end: html.length };
  return { text: html.slice(from, from + found.index), end: from + found.index };
}

function isHtmlWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";
}

function assertNever(value: never): never {
  throw new Error(`Unhandled html token: ${JSON.stringify(value)}`);
}

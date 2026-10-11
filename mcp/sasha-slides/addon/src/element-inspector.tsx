// THE ELEMENT INSPECTOR: the markup of the element the user selected on a candidate slide, shown as
// TEXT, with an editor under it.
//
// SAFETY, AND IT IS NOT NEGOTIABLE. `html` comes off the user's own candidate slide, but it is still
// UNTRUSTED INPUT to this component: a candidate is generated, pasted and hand-edited, so it can
// carry a <script>, an `onerror=` attribute or a `javascript:` url. Nothing here ever puts that
// string where a browser would run it -- no `innerHTML`, no `dangerouslySetInnerHTML`, no `eval`, no
// `new Function`, no <script> element, no write into a live DOM node, no `href`/`src` built from it.
// It reaches the screen in exactly two escaping positions: a <textarea> `value` and React text
// children. Do NOT "improve" this into a live preview -- a preview of this markup belongs in a
// sandboxed iframe owned by some other component, never in this one.
//
// The pretty-printer below is a HAND-WRITTEN TOKENIZER on purpose. It must run under `node:test`
// with no browser, so DOMParser / `document.createElement` are not available to it -- and feeding
// untrusted markup to a parser that builds real nodes is the very thing the paragraph above forbids.

import { useState, type JSX } from "react";
import { assertNever } from "./protocol.ts";

/**
 * The selected element's markup, and the two buttons that commit or discard an edit.
 *
 * The textarea is a CONTROLLED field over one piece of local state (the draft), because the draft
 * has to survive a parent re-render -- the slide editor re-renders on every drag of the selection
 * box -- while still being dropped the moment the selection itself changes.
 */
export function ElementInspector(props: ElementInspectorProps): JSX.Element {
  const view = inspectorViewOf({ html: props.html, selector: props.selector });
  const selection = selectionOf(view);
  const [draft, setDraft] = useState<InspectorDraft>({ key: selection.key, text: selection.baseline });

  // Render-phase reset, the shape React documents for "adjusting state when a prop changes": a new
  // selection discards whatever was typed against the old one. `text` below already reads as the
  // new baseline, so this only persists it -- without it, selecting A, typing, selecting B and
  // coming back to A would resurrect A's abandoned draft.
  if (draft.key !== selection.key) setDraft({ key: selection.key, text: selection.baseline });
  const text = draftTextFor({ draft, key: selection.key, baseline: selection.baseline });
  const edited = text !== selection.baseline;

  switch (view.kind) {
    case "empty":
      return (
        <p className="sasha-ei-empty sasha-dim">Select an element on the slide to see its markup here.</p>
      );
    case "element":
      return (
        <div className="sasha-ei">
          <div className="sasha-ei-head">
            <strong className="sasha-ei-tag">{tagNameOf(view.html)}</strong>
            {view.selector === null ? null : (
              // The full selector lives in `title`: the visible one is clipped to one line, and a
              // deep "section > div:nth-of-type(2) > span" is wider than this panel ever gets.
              <span className="sasha-ei-selector" title={view.selector}>
                {view.selector}
              </span>
            )}
          </div>
          <textarea
            className="sasha-ei-markup"
            rows={8}
            spellCheck={false}
            aria-label="Markup of the selected element"
            disabled={props.disabled}
            value={text}
            onChange={(event) => setDraft({ key: selection.key, text: event.target.value })}
          />
          <div className="sasha-ei-actions">
            <button
              type="button"
              className="sasha-ei-apply"
              disabled={props.disabled || !edited}
              onClick={() => props.onApply({ html: text })}
            >
              Apply
            </button>
            {/* Revert carries the same enablement as Apply: with nothing typed there is nothing to
                revert, and a live-looking button whose click does nothing is worse than a dim one. */}
            <button
              type="button"
              className="sasha-ei-revert"
              disabled={props.disabled || !edited}
              onClick={() => setDraft({ key: selection.key, text: selection.baseline })}
            >
              Revert
            </button>
          </div>
        </div>
      );
    default:
      return assertNever(view);
  }
}

export type ElementInspectorProps = Readonly<{
  /** The selected element's outerHTML, or null when nothing is selected. */
  html: string | null;
  /** The stable CSS selector naming it (e.g. "section > div:nth-of-type(2)"), or null. */
  selector: string | null;
  /** Whether editing is allowed right now (false while a submit is in flight). */
  disabled: boolean;
  /** The user committed new markup for the selected element. */
  onApply: (next: Readonly<{ html: string }>) => void;
}>;

/**
 * The inspector's own rules, spliced into PICKER_CSS by the shells.
 *
 * An array joined rather than a template literal: PICKER_CSS is itself one template literal, so a
 * backtick or a dollar-brace in here would terminate it.
 */
export const ELEMENT_INSPECTOR_CSS = [
  ".sasha-ei { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }",
  ".sasha-ei-empty { margin: 10px 0 0; line-height: 1.5; }",
  ".sasha-ei-head { display: flex; align-items: baseline; gap: 6px; min-width: 0; font-size: 12px; }",
  ".sasha-ei-tag { font-size: 13px; color: #202124; }",
  ".sasha-ei-selector {",
  "  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;",
  "  font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #5f6368;",
  "}",
  ".sasha-ei-markup {",
  "  width: 100%; resize: vertical; min-height: 120px;",
  "  font-family: ui-monospace, Menlo, monospace; font-size: 11px; line-height: 1.5; color: #202124;",
  "  background: #fff; border: 1px solid #dadce0; border-radius: 4px; padding: 6px 8px;",
  "  white-space: pre; overflow-wrap: normal; overflow-x: auto;",
  "}",
  ".sasha-ei-markup:disabled { background: #f1f3f4; color: #5f6368; }",
  ".sasha-ei-actions { display: flex; gap: 6px; }",
  ".sasha-ei-apply, .sasha-ei-revert {",
  "  cursor: pointer; border: 1px solid #dadce0; border-radius: 4px; background: #fff;",
  "  padding: 4px 12px; font-size: 12px; color: #202124;",
  "}",
  ".sasha-ei-apply { border-color: #1a73e8; background: #1a73e8; color: #fff; font-weight: 600; }",
  ".sasha-ei-apply:disabled, .sasha-ei-revert:disabled { cursor: default; opacity: .5; }",
].join("\n");

/**
 * ONE TAG PER LINE, two spaces of indent.
 *
 * Pure, DOM-free and IDEMPOTENT: formatting already-formatted markup returns it unchanged, which is
 * what lets the component re-format on every render without the text creeping. The rules:
 *
 * - structural whitespace is the layout's, so a whitespace-only text node is dropped and the
 *   whitespace inside a text node collapses to single spaces;
 * - an element whose children are all text sits on ONE line while it fits in MAX_INLINE_WIDTH --
 *   `<h1>Title</h1>` is a line, not three;
 * - void and self-closed elements (`<br>`, `<img …>`, `<circle … />`) are leaves, so they never
 *   open an indent level;
 * - `<script>`, `<style>`, `<pre>` and `<textarea>` hold RAW TEXT: their body is copied out
 *   verbatim and never indented, because a space added inside a `<pre>` is a visible change and a
 *   `<` inside a script is not a tag.
 */
export function formatMarkup(html: string): string {
  const lines: string[] = [];
  renderMarkupNodes({ nodes: buildMarkupTree(tokenizeMarkup(html)), depth: 0, lines });
  return lines.join("\n");
}

/**
 * The name of the outermost element, lowercased, for the header.
 *
 * Markup with no element at all (a selected text node) answers "text" rather than an empty bold
 * span, so the header never collapses to a stray selector with nothing in front of it.
 */
export function tagNameOf(html: string): string {
  for (const token of tokenizeMarkup(html)) {
    switch (token.kind) {
      case "openTag":
        return token.name;
      case "rawElement":
        return token.name;
      case "text":
      case "comment":
      case "declaration":
      case "closeTag":
        break;
      default:
        return assertNever(token);
    }
  }
  return "text";
}

/** What the textarea holds, and which selection it was typed against. */
export type InspectorDraft = Readonly<{ key: string; text: string }>;

/**
 * The text the textarea shows. A draft belonging to a DIFFERENT selection is discarded, so picking
 * another element never carries the previous element's markup -- or the user's half-finished edit of
 * it -- over to the new one.
 */
export function draftTextFor(options: Readonly<{ draft: InspectorDraft; key: string; baseline: string }>): string {
  const { draft, key, baseline } = options;
  return draft.key === key ? draft.text : baseline;
}

/** Nothing selected, or one element. A union so the render has a `never` position to fall into. */
type InspectorView =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "element"; html: string; selector: string | null }>;

function inspectorViewOf(options: Readonly<{ html: string | null; selector: string | null }>): InspectorView {
  const { html, selector } = options;
  if (html === null) return { kind: "empty" };
  return { kind: "element", html, selector };
}

/**
 * The selection's identity and the text it starts from.
 *
 * The key carries the SELECTOR as well as the markup: two sibling elements can have byte-identical
 * outerHTML, and moving between them is still a change of selection that must reset the editor. The
 * NUL separator cannot occur in either half of a real selection.
 */
function selectionOf(view: InspectorView): Readonly<{ key: string; baseline: string }> {
  switch (view.kind) {
    case "empty":
      return { key: "", baseline: "" };
    case "element":
      return { key: `${view.selector ?? ""}\u0000${view.html}`, baseline: formatMarkup(view.html) };
    default:
      return assertNever(view);
  }
}

/** The markup tree the formatter walks. Deliberately lossless about the few things that matter. */
type MarkupNode =
  | Readonly<{ kind: "element"; name: string; attributes: string; children: readonly MarkupNode[] }>
  | Readonly<{ kind: "emptyElement"; name: string; attributes: string; selfClosed: boolean }>
  | Readonly<{ kind: "rawElement"; name: string; attributes: string; content: string }>
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "comment"; text: string }>
  | Readonly<{ kind: "declaration"; text: string }>;

/** A tag the parser has opened and not yet closed. The one mutable thing in the formatter. */
type ElementFrame = { readonly name: string; readonly attributes: string; readonly children: MarkupNode[] };

/** Past this width an inlined element breaks across lines. Counted WITH the indent. */
const MAX_INLINE_WIDTH = 80;

const INDENT = "  ";

/** HTML's void elements: they take no children and no closing tag, whatever the source wrote. */
const VOID_ELEMENT_NAMES: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose body is text, not markup -- a `<` in there opens nothing. */
const RAW_TEXT_ELEMENT_NAMES: ReadonlySet<string> = new Set(["script", "style", "pre", "textarea"]);

function renderMarkupNodes(
  options: Readonly<{ nodes: readonly MarkupNode[]; depth: number; lines: string[] }>,
): void {
  const { nodes, depth, lines } = options;
  for (const node of nodes) renderMarkupNode({ node, depth, lines });
}

function renderMarkupNode(options: Readonly<{ node: MarkupNode; depth: number; lines: string[] }>): void {
  const { node, depth, lines } = options;
  const indent = INDENT.repeat(depth);
  switch (node.kind) {
    case "element": {
      const compact = compactMarkup(node);
      if (node.children.every(isInlinableChild) && indent.length + compact.length <= MAX_INLINE_WIDTH) {
        lines.push(indent + compact);
        return;
      }
      lines.push(indent + openTagMarkup(node));
      renderMarkupNodes({ nodes: node.children, depth: depth + 1, lines });
      lines.push(`${indent}</${node.name}>`);
      return;
    }
    case "rawElement": {
      const body = trimRawBody(node.content);
      const compact = `${openTagMarkup(node)}${body}</${node.name}>`;
      if (!body.includes("\n") && indent.length + compact.length <= MAX_INLINE_WIDTH) {
        lines.push(indent + compact);
        return;
      }
      lines.push(indent + openTagMarkup(node));
      // Verbatim and UNINDENTED: indenting a raw body would both change what it means and grow it
      // by two spaces on every pass, which is exactly the way idempotency is lost.
      for (const line of body.split("\n")) lines.push(line);
      lines.push(`${indent}</${node.name}>`);
      return;
    }
    case "emptyElement":
    case "comment":
    case "declaration":
      lines.push(indent + compactMarkup(node));
      return;
    case "text":
      // Trimmed because the line break around it IS the whitespace it stood for.
      lines.push(indent + node.text.trim());
      return;
    default:
      return assertNever(node);
  }
}

/** Whether a child can share its parent's line. Only text can -- see formatMarkup's rules. */
function isInlinableChild(node: MarkupNode): boolean {
  switch (node.kind) {
    case "text":
      return true;
    case "element":
    case "emptyElement":
    case "rawElement":
    case "comment":
    case "declaration":
      return false;
    default:
      return assertNever(node);
  }
}

/** The node on one line, with no indent. Used to decide whether it fits, and to emit it when it does. */
function compactMarkup(node: MarkupNode): string {
  switch (node.kind) {
    case "element":
      return `${openTagMarkup(node)}${node.children.map(compactMarkup).join("")}</${node.name}>`;
    case "emptyElement":
      return `<${node.name}${attributeSuffix(node.attributes)}${node.selfClosed ? " />" : ">"}`;
    case "rawElement":
      return `${openTagMarkup(node)}${node.content}</${node.name}>`;
    case "text":
      return node.text;
    case "comment":
      return `<!--${node.text}-->`;
    case "declaration":
      return node.text;
    default:
      return assertNever(node);
  }
}

function openTagMarkup(node: Readonly<{ name: string; attributes: string }>): string {
  return `<${node.name}${attributeSuffix(node.attributes)}>`;
}

function attributeSuffix(attributes: string): string {
  return attributes === "" ? "" : ` ${attributes}`;
}

/**
 * Drops the newline a formatter put straight after the open tag and the one before the close tag,
 * so re-formatting a raw body does not gain a blank line each time.
 */
function trimRawBody(content: string): string {
  return content.replace(/^[ \t]*\r?\n/, "").replace(/\r?\n[ \t]*$/, "");
}

function buildMarkupTree(tokens: readonly MarkupToken[]): readonly MarkupNode[] {
  const roots: MarkupNode[] = [];
  const open: ElementFrame[] = [];
  const childrenOfInnermost = (): MarkupNode[] => {
    const innermost = open[open.length - 1];
    return innermost === undefined ? roots : innermost.children;
  };
  for (const token of tokens) {
    switch (token.kind) {
      case "openTag":
        if (token.selfClosed || VOID_ELEMENT_NAMES.has(token.name)) {
          childrenOfInnermost().push({
            kind: "emptyElement",
            name: token.name,
            attributes: token.attributes,
            selfClosed: token.selfClosed,
          });
          break;
        }
        open.push({ name: token.name, attributes: token.attributes, children: [] });
        break;
      case "closeTag": {
        const depth = innermostOpenIndex({ open, name: token.name });
        // A close tag matching nothing open is DROPPED: there is no place for it in the tree, and
        // keeping it would shift every line below it out by one level.
        if (depth < 0) break;
        // Anything still open inside the one being closed was never closed by the source; close it
        // here, which is what a browser does with `<div><span></div>`.
        while (open.length > depth) closeInnermostFrame({ open, roots });
        break;
      }
      case "rawElement":
        childrenOfInnermost().push({
          kind: "rawElement",
          name: token.name,
          attributes: token.attributes,
          content: token.content,
        });
        break;
      case "text":
        childrenOfInnermost().push({ kind: "text", text: token.text });
        break;
      case "comment":
        childrenOfInnermost().push({ kind: "comment", text: token.text });
        break;
      case "declaration":
        childrenOfInnermost().push({ kind: "declaration", text: token.text });
        break;
      default:
        assertNever(token);
    }
  }
  while (open.length > 0) closeInnermostFrame({ open, roots });
  return roots;
}

function innermostOpenIndex(options: Readonly<{ open: readonly ElementFrame[]; name: string }>): number {
  const { open, name } = options;
  for (let index = open.length - 1; index >= 0; index -= 1) {
    const frame = open[index];
    if (frame !== undefined && frame.name === name) return index;
  }
  return -1;
}

function closeInnermostFrame(options: Readonly<{ open: ElementFrame[]; roots: MarkupNode[] }>): void {
  const { open, roots } = options;
  const frame = open.pop();
  if (frame === undefined) return;
  const node: MarkupNode = {
    kind: "element",
    name: frame.name,
    attributes: frame.attributes,
    children: frame.children,
  };
  const parent = open[open.length - 1];
  if (parent === undefined) {
    roots.push(node);
    return;
  }
  parent.children.push(node);
}

type MarkupToken =
  | Readonly<{ kind: "openTag"; name: string; attributes: string; selfClosed: boolean }>
  | Readonly<{ kind: "closeTag"; name: string }>
  | Readonly<{ kind: "rawElement"; name: string; attributes: string; content: string }>
  | MarkupTextToken
  | Readonly<{ kind: "comment"; text: string }>
  | Readonly<{ kind: "declaration"; text: string }>;

type MarkupTextToken = Readonly<{ kind: "text"; text: string }>;

/**
 * The tokenizer. It is deliberately forgiving -- the markup is whatever the user typed, so an
 * unterminated tag, an unmatched close tag or a bare `<` must each produce a token rather than
 * throw and leave the user staring at an empty editor.
 */
function tokenizeMarkup(html: string): readonly MarkupToken[] {
  const tokens: MarkupToken[] = [];
  let at = 0;
  while (at < html.length) {
    const lessThan = html.indexOf("<", at);
    if (lessThan < 0) {
      pushTextToken({ tokens, text: html.slice(at) });
      break;
    }
    if (lessThan > at) pushTextToken({ tokens, text: html.slice(at, lessThan) });
    if (html.startsWith("<!--", lessThan)) {
      const end = html.indexOf("-->", lessThan + 4);
      tokens.push({ kind: "comment", text: html.slice(lessThan + 4, end < 0 ? html.length : end) });
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lessThan) || html.startsWith("<?", lessThan)) {
      const end = html.indexOf(">", lessThan);
      const stop = end < 0 ? html.length : end + 1;
      tokens.push({ kind: "declaration", text: html.slice(lessThan, stop) });
      at = stop;
      continue;
    }
    if (html.startsWith("</", lessThan)) {
      const nameEnd = scanTagNameEnd({ html, from: lessThan + 2 });
      const end = html.indexOf(">", nameEnd);
      tokens.push({ kind: "closeTag", name: html.slice(lessThan + 2, nameEnd).toLowerCase() });
      at = end < 0 ? html.length : end + 1;
      continue;
    }
    // A `<` that no letter follows is arithmetic or prose ("a < b"), not a tag.
    if (!startsTagName(html[lessThan + 1])) {
      pushTextToken({ tokens, text: "<" });
      at = lessThan + 1;
      continue;
    }
    const nameEnd = scanTagNameEnd({ html, from: lessThan + 1 });
    const name = html.slice(lessThan + 1, nameEnd).toLowerCase();
    const tag = scanTagAttributes({ html, from: nameEnd });
    if (!tag.selfClosed && RAW_TEXT_ELEMENT_NAMES.has(name)) {
      const raw = scanRawText({ html, from: tag.end, name });
      tokens.push({ kind: "rawElement", name, attributes: tag.attributes, content: raw.content });
      at = raw.end;
      continue;
    }
    tokens.push({ kind: "openTag", name, attributes: tag.attributes, selfClosed: tag.selfClosed });
    at = tag.end;
  }
  return tokens;
}

/**
 * A text token, unless it is only the whitespace between two tags -- that whitespace is the old
 * formatting, and keeping it would make the formatter grow its own output on every pass.
 *
 * Adjacent text is MERGED into the token before it, because the tokenizer emits a prose `<` as a
 * token of its own; without merging, "a < b" would print as three lines.
 */
function pushTextToken(options: Readonly<{ tokens: MarkupToken[]; text: string }>): void {
  const { tokens, text } = options;
  if (text.trim() === "") return;
  // A single leading/trailing space is KEPT: it is the space in `<p>Hello <b>world</b></p>`, which
  // the reader would otherwise find silently deleted.
  const normalized = text.replace(/\s+/g, " ");
  const previous = tokens[tokens.length - 1];
  if (previous !== undefined && isTextToken(previous)) {
    tokens[tokens.length - 1] = { kind: "text", text: previous.text + normalized };
    return;
  }
  tokens.push({ kind: "text", text: normalized });
}

/** Exhaustive, so a new kind of token has to say whether prose can be appended to it. */
function isTextToken(token: MarkupToken): token is MarkupTextToken {
  switch (token.kind) {
    case "text":
      return true;
    case "openTag":
    case "closeTag":
    case "rawElement":
    case "comment":
    case "declaration":
      return false;
    default:
      return assertNever(token);
  }
}

function scanTagNameEnd(options: Readonly<{ html: string; from: number }>): number {
  const { html, from } = options;
  let index = from;
  while (index < html.length) {
    const char = html[index];
    if (char === undefined || !isTagNameChar(char)) break;
    index += 1;
  }
  return index;
}

function startsTagName(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z]/.test(char);
}

function isTagNameChar(char: string): boolean {
  return /[A-Za-z0-9:._-]/.test(char);
}

/**
 * Everything between the tag name and the tag's own `>`.
 *
 * QUOTE AWARE, which is the whole point: `<div title="a > b">` has a `>` that does not end the tag,
 * and a regex that stops at the first `>` splits the element in half. Whitespace OUTSIDE quotes
 * collapses to one space, so an attribute list written over several lines still prints as one tag
 * per line; inside quotes every byte is copied.
 */
function scanTagAttributes(
  options: Readonly<{ html: string; from: number }>,
): Readonly<{ attributes: string; selfClosed: boolean; end: number }> {
  const { html, from } = options;
  let quote: string | null = null;
  let attributes = "";
  let index = from;
  let selfClosed = false;
  while (index < html.length) {
    const char = html[index];
    if (char === undefined) break;
    if (quote !== null) {
      attributes += char;
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      attributes += char;
      quote = char;
      index += 1;
      continue;
    }
    if (char === ">") {
      index += 1;
      break;
    }
    if (char === "/" && html[index + 1] === ">") {
      selfClosed = true;
      index += 2;
      break;
    }
    if (/\s/.test(char)) {
      if (attributes !== "" && !attributes.endsWith(" ")) attributes += " ";
      index += 1;
      continue;
    }
    attributes += char;
    index += 1;
  }
  return { attributes: attributes.trim(), selfClosed, end: index };
}

/** The body of a raw-text element, up to its own close tag, copied byte for byte. */
function scanRawText(
  options: Readonly<{ html: string; from: number; name: string }>,
): Readonly<{ content: string; end: number }> {
  const { html, from, name } = options;
  const close = html.toLowerCase().indexOf(`</${name}`, from);
  if (close < 0) return { content: html.slice(from), end: html.length };
  const end = html.indexOf(">", close);
  return { content: html.slice(from, close), end: end < 0 ? html.length : end + 1 };
}

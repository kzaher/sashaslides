// PAGE POSITIONS <-> BODY INDICES for the inline text editor. The browser reports a caret, a
// selection and a `beforeinput` target range as (node, offset) pairs; the editor works in the
// Y.Text index space (document.ts). The rendered paragraphs carry the index they start at and each
// run the index of its first character (text-paragraphs.tsx), so the mapping reads those attributes
// and the text nodes' lengths, and nothing else -- drawing and editing agree by construction.
//
// Key decisions:
//
//  * A LIST MARKER IS OUTSIDE THE INDEX SPACE; an automatic field is ONE index wide whatever it
//    prints ("12" is still length 1).
//  * A POSITION OUTSIDE THE EDITED BODY IS null, never a clamped guess, so a stray selection in the
//    chrome can never move the caret.

import { AUTOMATIC_TEXT_ATTRIBUTE, LIST_MARKER_ATTRIBUTE, PARAGRAPH_START_ATTRIBUTE, RUN_START_ATTRIBUTE } from "../render/text-paragraphs.tsx";

/** A body index for a page position inside `root`; null outside it. */
export function indexFromPagePosition(options: Readonly<{ root: HTMLElement; container: Node; offset: number }>): number | null {
  if (!options.root.contains(options.container)) return null;
  const container = options.container;
  if (container.nodeType === TEXT_NODE) {
    const run = container.parentElement?.closest(`[${RUN_START_ATTRIBUTE}]`) ?? null;
    if (run !== null && options.root.contains(run)) return runStart(run) + Math.min(options.offset, runLength(run));
    return paragraphIndexOf(container, options.root);
  }
  if (!(container instanceof Element)) return null;
  if (container.hasAttribute(RUN_START_ATTRIBUTE)) return runStart(container) + (options.offset === 0 ? 0 : runLength(container));
  if (container.hasAttribute(PARAGRAPH_START_ATTRIBUTE)) return indexInParagraph({ paragraph: container, childOffset: options.offset });
  return indexInBlock({ root: options.root, block: container, childOffset: options.offset });
}

/** The page position of a body index inside `root`, for placing the browser's selection. */
export function pagePositionOfIndex(options: Readonly<{ root: HTMLElement; index: number }>): Readonly<{ node: Node; offset: number }> | null {
  const paragraphs = Array.from(options.root.querySelectorAll(`[${PARAGRAPH_START_ATTRIBUTE}]`));
  let chosen: Element | null = null;
  for (const paragraph of paragraphs) {
    if (paragraphStart(paragraph) > options.index) break;
    chosen = paragraph;
  }
  if (chosen === null) return null;
  const runs = Array.from(chosen.querySelectorAll(`[${RUN_START_ATTRIBUTE}]`));
  for (const run of runs) {
    const start = runStart(run);
    const length = runLength(run);
    if (options.index < start || options.index > start + length) continue;
    if (run.hasAttribute(AUTOMATIC_TEXT_ATTRIBUTE)) return positionBesideChild({ child: run, after: options.index > start });
    const text = run.firstChild;
    if (text === null) return { node: run, offset: 0 };
    return { node: text, offset: options.index - start };
  }
  const last = runs[runs.length - 1];
  if (last === undefined) return { node: chosen, offset: firstContentOffset(chosen) };
  if (last.hasAttribute(AUTOMATIC_TEXT_ATTRIBUTE)) return positionBesideChild({ child: last, after: true });
  const text = last.firstChild;
  return text === null ? { node: last, offset: 0 } : { node: text, offset: text.textContent?.length ?? 0 };
}

const TEXT_NODE = 3;

function runStart(run: Element): number {
  return Number(run.getAttribute(RUN_START_ATTRIBUTE) ?? "0");
}

function paragraphStart(paragraph: Element): number {
  return Number(paragraph.getAttribute(PARAGRAPH_START_ATTRIBUTE) ?? "0");
}

/** An automatic field is one index wide; a text run is as long as its text. */
function runLength(run: Element): number {
  if (run.hasAttribute(AUTOMATIC_TEXT_ATTRIBUTE)) return 1;
  return run.textContent?.length ?? 0;
}

function paragraphIndexOf(node: Node, root: HTMLElement): number | null {
  const paragraph = node.parentElement?.closest(`[${PARAGRAPH_START_ATTRIBUTE}]`) ?? null;
  if (paragraph === null || !root.contains(paragraph)) return null;
  return paragraphStart(paragraph);
}

/** A position between a paragraph's children: after the run before it, or the paragraph's start. */
function indexInParagraph(options: Readonly<{ paragraph: Element; childOffset: number }>): number {
  const children = Array.from(options.paragraph.childNodes).slice(0, options.childOffset);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (!(child instanceof Element) || child.hasAttribute(LIST_MARKER_ATTRIBUTE)) continue;
    // A child holding runs (the paragraph's span, a link) ends where its LAST run ends.
    const run = child.hasAttribute(RUN_START_ATTRIBUTE) ? child : Array.from(child.querySelectorAll(`[${RUN_START_ATTRIBUTE}]`)).pop();
    if (run !== undefined) return runStart(run) + runLength(run);
  }
  return paragraphStart(options.paragraph);
}

/** A position between children of something above the paragraphs (the content root, a link). */
function indexInBlock(options: Readonly<{ root: HTMLElement; block: Element; childOffset: number }>): number | null {
  const insideParagraph = options.block.closest(`[${PARAGRAPH_START_ATTRIBUTE}]`);
  if (insideParagraph !== null && options.root.contains(insideParagraph)) {
    const before = Array.from(options.block.childNodes).slice(0, options.childOffset);
    const runs = before.flatMap((node) => (node instanceof Element ? [...(node.hasAttribute(RUN_START_ATTRIBUTE) ? [node] : []), ...Array.from(node.querySelectorAll(`[${RUN_START_ATTRIBUTE}]`))] : []));
    const last = runs[runs.length - 1];
    if (last !== undefined) return runStart(last) + runLength(last);
    const firstRun = options.block.querySelector(`[${RUN_START_ATTRIBUTE}]`);
    return firstRun === null ? paragraphStart(insideParagraph) : runStart(firstRun);
  }
  const paragraphs = Array.from(options.block.querySelectorAll(`[${PARAGRAPH_START_ATTRIBUTE}]`));
  const before = Array.from(options.block.childNodes).slice(0, options.childOffset);
  const lastParagraphBefore = before.flatMap((node) => (node instanceof Element ? [...(node.hasAttribute(PARAGRAPH_START_ATTRIBUTE) ? [node] : []), ...Array.from(node.querySelectorAll(`[${PARAGRAPH_START_ATTRIBUTE}]`))] : [])).pop();
  if (lastParagraphBefore === undefined) return paragraphs[0] === undefined ? null : paragraphStart(paragraphs[0]);
  return indexInParagraph({ paragraph: lastParagraphBefore, childOffset: lastParagraphBefore.childNodes.length });
}

function positionBesideChild(options: Readonly<{ child: Element; after: boolean }>): Readonly<{ node: Node; offset: number }> {
  const parent = options.child.parentNode;
  if (parent === null) return { node: options.child, offset: 0 };
  const index = Array.from(parent.childNodes).indexOf(options.child);
  return { node: parent, offset: options.after ? index + 1 : index };
}

/** In an empty paragraph the caret sits after the list marker, before the line break. */
function firstContentOffset(paragraph: Element): number {
  const children = Array.from(paragraph.childNodes);
  const marker = children.findIndex((child) => child instanceof Element && child.hasAttribute(LIST_MARKER_ATTRIBUTE));
  return marker === -1 ? 0 : marker + 1;
}

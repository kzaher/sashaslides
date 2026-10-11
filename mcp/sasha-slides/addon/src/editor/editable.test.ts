// The refusals. The contract says an edit the editor cannot express is dropped WITH A WARNING and
// never approximated, so each rule here is also the sentence the user is shown.

import { walkUpOnRepeatClick as walkUpOnRepeatClickForTest } from "./slide-editor.ts";

/** A stand-in for an Element: just the two things the walk reads. */
type Nested = Readonly<{ tagName?: string; parentElement: Nested | null; contains: (other: Nested) => boolean }>;
import assert from "node:assert/strict";
import test from "node:test";
import { mayMove, mayRecolour, mayRemove, mayResize, mayRetext, type LayoutFacts } from "./editable.ts";

function layout(partial: Partial<LayoutFacts> & Readonly<{ tag: string }>): LayoutFacts {
  return { display: "block", hasBlockChildren: false, hasText: true, isReplaced: false, ...partial };
}

test("the slide itself is not an element on the slide", () => {
  for (const tag of ["body", "html"]) {
    assert.equal(mayMove(layout({ tag })).kind, "refused");
    assert.equal(mayResize(layout({ tag })).kind, "refused");
    assert.equal(mayRemove(layout({ tag })).kind, "refused");
    assert.equal(mayRetext(layout({ tag })).kind, "refused");
  }
  // A background colour for the slide is still a legitimate edit, so `body` keeps its swatch.
  assert.equal(mayRecolour(layout({ tag: "body" })).kind, "allowed");
  assert.equal(mayRecolour(layout({ tag: "html" })).kind, "refused");
});

test("a non-replaced inline element cannot be moved or resized, and says why", () => {
  const span = layout({ tag: "span", display: "inline" });
  const move = mayMove(span);
  assert.equal(move.kind, "refused");
  assert.ok(move.kind === "refused" && move.reason.includes("transform"));
  assert.equal(mayResize(span).kind, "refused");
  // Its colour and its words are exactly the edits that DO make sense on a word.
  assert.equal(mayRecolour(span).kind, "allowed");
  assert.equal(mayRetext(span).kind, "allowed");
});

test("a replaced inline element is a box, so it moves and resizes like one", () => {
  const image = layout({ tag: "img", display: "inline", isReplaced: true, hasText: false });
  assert.equal(mayMove(image).kind, "allowed");
  assert.equal(mayResize(image).kind, "allowed");
  assert.equal(mayRetext(image).kind, "refused");
});

test("retexting a container of blocks would delete them, so it is refused", () => {
  const row = layout({ tag: "div", hasBlockChildren: true });
  const refused = mayRetext(row);
  assert.equal(refused.kind, "refused");
  assert.ok(refused.kind === "refused" && refused.reason.includes("Select the text inside it"));
  // A heading with inline children (`<h1>Paths in, <em>ids out</em></h1>`) is a text run, not a
  // container: retexting it flattens the `<em>`, which is what "the user typed new words" means.
  assert.equal(mayRetext(layout({ tag: "h1" })).kind, "allowed");
});

test("an element with nothing to say cannot be retexted", () => {
  assert.equal(mayRetext(layout({ tag: "div", hasText: false })).kind, "refused");
});

// --- clicking the same place again selects the parent ---------------------

/**
 * The topmost element under the pointer is almost never the one the user means -- it is the span
 * inside the cell inside the row inside the table. Every drawing program answers this the same
 * way: the first click takes the leaf, clicking again in the same place walks out one ring.
 */
test("the first click takes what was hit", () => {
  const leaf: Nested = { contains: () => false, parentElement: null };
  assert.equal(walkUpOnRepeatClickForTest({ hit: leaf, selected: null }), leaf);
});

test("clicking again INSIDE the selection walks out to its parent", () => {
  const parent: Nested = { contains: () => true, parentElement: null };
  const leaf: Nested = { contains: () => false, parentElement: parent };
  const selected = { element: { contains: () => true, parentElement: parent } };
  assert.equal(walkUpOnRepeatClickForTest({ hit: leaf, selected }), parent);
});

/** A click somewhere else is a NEW selection, never a continuation of the last one. */
test("clicking outside the selection selects what was hit, not an ancestor", () => {
  const elsewhere: Nested = { contains: () => false, parentElement: null };
  const selected: Readonly<{ element: Nested }> = {
    element: { contains: () => false, parentElement: { contains: () => true, parentElement: null } },
  };
  assert.equal(walkUpOnRepeatClickForTest({ hit: elsewhere, selected }), elsewhere);
});

/** At the root there is nowhere further out, so it holds rather than deselecting. */
test("at the root the selection holds instead of clearing", () => {
  const root: Nested = { contains: () => true, parentElement: null };
  const selected = { element: root };
  assert.equal(walkUpOnRepeatClickForTest({ hit: root, selected }), root);
});

/*
 * THE WALK HAS A FLOOR, AND IT IS THE SLIDE -- AND AT THE FLOOR IT STARTS OVER.
 *
 * Clicking the same place enough times used to walk all the way out to <body> -- so the whole
 * slide became "the selected element". Nothing useful can be done with that: moving it means
 * moving the page, resizing it means resizing the 1280x720 canvas, and commenting on it says
 * only "this slide", which the comment already records. So the walk never steps into the page.
 *
 * Holding at the outermost element was the first answer, and it left the user stuck: every
 * further click re-selected the same outer box, so reaching a leaf again meant clicking somewhere
 * else first. Like every drawing program, the walk is a CYCLE: one more click at the top goes
 * back to what was hit.
 */
test("one click past the outermost element starts over at the leaf, never takes <body>", () => {
  const body: Nested = { tagName: "BODY", contains: () => true, parentElement: null };
  const outermost: Nested = { tagName: "SECTION", contains: () => true, parentElement: body };
  const hit: Nested = { tagName: "H1", contains: () => false, parentElement: outermost };
  assert.equal(walkUpOnRepeatClickForTest({ hit, selected: { element: outermost } }), hit);
});

test("nor <html>, for the same reason", () => {
  const html: Nested = { tagName: "HTML", contains: () => true, parentElement: null };
  const outermost: Nested = { tagName: "DIV", contains: () => true, parentElement: html };
  const hit: Nested = { tagName: "P", contains: () => false, parentElement: outermost };
  assert.equal(walkUpOnRepeatClickForTest({ hit, selected: { element: outermost } }), hit);
});

/*
 * The Parent button CAN select <body> on purpose -- a slide background colour is a real edit. A
 * click on the slide from there must start over at the leaf, not stay on the page forever.
 */
test("with <body> selected, a click selects the leaf that was hit", () => {
  const html: Nested = { tagName: "HTML", contains: () => true, parentElement: null };
  const body: Nested = { tagName: "BODY", contains: () => true, parentElement: html };
  const card: Nested = { tagName: "SECTION", contains: () => true, parentElement: body };
  const hit: Nested = { tagName: "SPAN", contains: () => false, parentElement: card };
  assert.equal(walkUpOnRepeatClickForTest({ hit, selected: { element: body } }), hit);
});

test("but it still walks through ordinary containers on the way out", () => {
  const body: Nested = { tagName: "BODY", contains: () => true, parentElement: null };
  const card: Nested = { tagName: "SECTION", contains: () => true, parentElement: body };
  const row: Nested = { tagName: "DIV", contains: () => true, parentElement: card };
  const hit: Nested = { tagName: "SPAN", contains: () => false, parentElement: row };
  assert.equal(walkUpOnRepeatClickForTest({ hit, selected: { element: row } }), card, "one ring out");
});

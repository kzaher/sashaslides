// The refusals. The contract says an edit the editor cannot express is dropped WITH A WARNING and
// never approximated, so each rule here is also the sentence the user is shown.

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

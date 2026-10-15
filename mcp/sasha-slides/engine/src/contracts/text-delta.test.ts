// The index rule every text position in the editor follows (text-delta.ts header), including the
// tie-break at an insertion point that decides whether two people typing at the same spot
// interleave, and the "ab" never becomes "ba" guarantee for fast local typing.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { transformIndex, type TextDelta } from "./text-delta.ts";

describe("transformIndex", () => {
  const insertTwoAtFive: TextDelta = [{ kind: "retain", length: 5 }, { kind: "insert", length: 2 }];
  const deleteThreeAtTwo: TextDelta = [{ kind: "retain", length: 2 }, { kind: "delete", length: 3 }];

  it("an index before an insert does not move", () => {
    assert.equal(transformIndex({ delta: insertTwoAtFive, index: 3, bias: "before" }), 3);
  });

  it("an index after an insert shifts by its length", () => {
    assert.equal(transformIndex({ delta: insertTwoAtFive, index: 8, bias: "before" }), 10);
  });

  it("at the insertion point, a remote insert goes after my caret", () => {
    assert.equal(transformIndex({ delta: insertTwoAtFive, index: 5, bias: "before" }), 5);
  });

  it("at the insertion point, my caret moves past my own insert", () => {
    assert.equal(transformIndex({ delta: insertTwoAtFive, index: 5, bias: "after" }), 7);
  });

  it("an index inside a deleted span collapses to the span's start", () => {
    assert.equal(transformIndex({ delta: deleteThreeAtTwo, index: 3, bias: "before" }), 2);
  });

  it("an index after a delete shifts back", () => {
    assert.equal(transformIndex({ delta: deleteThreeAtTwo, index: 9, bias: "before" }), 6);
  });

  it("an insert at the very start shifts a later caret", () => {
    assert.equal(transformIndex({ delta: [{ kind: "insert", length: 4 }], index: 0, bias: "after" }), 4);
    assert.equal(transformIndex({ delta: [{ kind: "insert", length: 4 }], index: 2, bias: "before" }), 6);
  });

  it("fast local typing: 'a' then 'b' at the moving caret reads 'ab'", () => {
    // Caret at 0. "a" is queued at 0; the caret moves past it (bias after) to 1; "b" is queued at 1.
    const caretAfterA = transformIndex({ delta: [{ kind: "insert", length: 1 }], index: 0, bias: "after" });
    assert.equal(caretAfterA, 1);
  });
});

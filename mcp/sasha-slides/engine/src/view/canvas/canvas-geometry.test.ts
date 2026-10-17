// The canvas's drag preview derives a moved group's frame exactly as the model stores it
// (shared/element-tree.ts `derivedGroupFrame`), so the handles do not jump on release. The fixture
// is the case where the two rules once differed: a group rotated 30 degrees holding a diagonal line,
// whose end points count rather than its box's corners.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { FrameUpdate } from "../../contracts/commands.ts";
import { identityFrame, type Frame } from "../../contracts/geometry.ts";
import { derivedGroupFrame, elementOfKind, findInTree } from "../../shared/element-tree.ts";
import { elementId, group, line, shape, slide } from "../../state/testing/document-fixtures.ts";
import { applyFramePreview } from "./canvas-geometry.ts";

describe("applyFramePreview: a previewed group's frame is the model's", () => {
  const children = [line({ id: "line_a", start: { x: 0, y: 0 }, end: { x: 200, y: 200 } }), shape({ id: "box_a", x: 300, y: 0, width: 100, height: 100 })];
  const original = slide({ id: "slide_a", elements: [{ ...group({ id: "group_a", children }), frame: derivedGroupFrame({ rotation: 30, children }) }] });
  const rows: readonly Readonly<{ label: string; updates: readonly FrameUpdate[]; expected: Readonly<Record<"x" | "y" | "width" | "height" | "rotation", number>> }>[] = [
    {
      // The four-corner rule made this group 398.205 tall.
      label: "a leaf moved: the line's end points bound the group, not its box's corners",
      updates: [{ kind: "box", elementId: elementId("box_a"), frame: identityFrame({ x: 350, y: 0, width: 100, height: 100 }) }],
      expected: { x: 8.494, y: -104.904, width: 439.711, height: 298.205, rotation: 30 },
    },
    {
      label: "the group turned past a full turn: the rotation is normalised, the frame unchanged",
      updates: [{ kind: "groupRotation", elementId: elementId("group_a"), rotation: 390 }],
      expected: { x: 5.144, y: -92.404, width: 396.41, height: 273.205, rotation: 30 },
    },
  ];
  for (const row of rows) {
    it(row.label, () => {
      const previewed = elementOfKind(findInTree(applyFramePreview(original, row.updates).elements, "group_a"), "group");
      assert.ok(previewed !== null);
      assert.deepEqual(previewed.frame, derivedGroupFrame({ rotation: previewed.frame.rotation, children: previewed.children }));
      assert.deepEqual(rounded(previewed.frame), row.expected);
    });
  }
});

function rounded(frame: Frame): Readonly<Record<"x" | "y" | "width" | "height" | "rotation", number>> {
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return { x: round(frame.x), y: round(frame.y), width: round(frame.width), height: round(frame.height), rotation: round(frame.rotation) };
}

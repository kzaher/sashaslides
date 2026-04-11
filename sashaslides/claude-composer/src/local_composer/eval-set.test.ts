import { describe, expect, it } from "vitest";
import { EVAL_SET } from "./eval-set.js";
import type { EvalItem } from "./eval-types.js";

describe("EVAL_SET", () => {
  it("has exactly 100 items", () => {
    expect(EVAL_SET.length).toBe(100);
  });

  it("has a 50/50 visual/action split", () => {
    const visual = EVAL_SET.filter((i) => i.category === "visual").length;
    const action = EVAL_SET.filter((i) => i.category === "action").length;
    expect(visual).toBe(50);
    expect(action).toBe(50);
  });

  it("has unique ids", () => {
    const ids = new Set(EVAL_SET.map((i) => i.id));
    expect(ids.size).toBe(EVAL_SET.length);
  });

  it("visual items always include slideHtml (except diff-detect, which has two)", () => {
    const visual = EVAL_SET.filter((i) => i.category === "visual");
    for (const item of visual) {
      expect(item.input.slideHtml).toBeDefined();
    }
    const diffs = visual.filter((i) => i.subcategory === "diff_detect");
    for (const d of diffs) {
      expect(d.input.slideHtmlB).toBeDefined();
    }
  });

  it("every action item has at least one scoring expectation", () => {
    const action = EVAL_SET.filter((i) => i.category === "action");
    for (const a of action) {
      const hasAny =
        a.expected.containsAll ||
        a.expected.containsAny ||
        a.expected.containsNone ||
        a.expected.isJson ||
        a.expected.codeRuns ||
        a.expected.numericRange ||
        a.expected.jsonPathEquals ||
        a.expected.exact ||
        a.expected.rubric;
      expect(hasAny, `item ${a.id} has no expectations`).toBeTruthy();
    }
  });

  it("covers expected subcategory counts", () => {
    const counts: Record<string, number> = {};
    for (const item of EVAL_SET) {
      counts[item.subcategory] = (counts[item.subcategory] ?? 0) + 1;
    }
    // Visual
    expect(counts.ocr).toBe(10);
    expect(counts.layout_classify).toBe(8);
    expect(counts.chart_read).toBe(8);
    expect(counts.style_detect).toBe(6);
    expect(counts.element_count).toBe(6);
    expect(counts.diff_detect).toBe(6);
    expect(counts.aesthetic_score).toBe(6);
    // Action
    expect(counts.generate_html).toBe(10);
    expect(counts.pick_layout).toBe(6);
    expect(counts.write_pptxgenjs).toBe(8);
    expect(counts.fix_bug).toBe(6);
    expect(counts.edit_op).toBe(8);
    expect(counts.agent_plan).toBe(6);
    expect(counts.rewrite_content).toBe(6);
  });

  it("covers difficulty distribution", () => {
    const difficulties = new Set<EvalItem["difficulty"]>();
    for (const item of EVAL_SET) difficulties.add(item.difficulty);
    expect(difficulties.size).toBeGreaterThanOrEqual(2);
  });
});

import { describe, expect, it } from "vitest";
import { extractNumber, isSyntacticallyValidJs, scoreResponse, stripFences } from "./scorer.js";
import type { EvalItem } from "./eval-types.js";

const item = (expected: EvalItem["expected"]): EvalItem => ({
  id: "t",
  category: "action",
  subcategory: "generate_html",
  difficulty: "easy",
  description: "",
  input: { prompt: "" },
  expected,
});

describe("scoreResponse", () => {
  it("passes exact match", () => {
    expect(scoreResponse(item({ exact: "hello" }), "hello").score).toBe(1);
    expect(scoreResponse(item({ exact: "hello" }), "Hello").score).toBe(0);
  });

  it("passes containsAll / fails on any miss", () => {
    expect(scoreResponse(item({ containsAll: ["foo", "bar"] }), "foo bar").score).toBe(1);
    expect(scoreResponse(item({ containsAll: ["foo", "bar"] }), "foo").score).toBe(0);
  });

  it("passes containsAny if any present", () => {
    expect(scoreResponse(item({ containsAny: ["foo", "bar"] }), "bar").score).toBe(1);
    expect(scoreResponse(item({ containsAny: ["foo", "bar"] }), "baz").score).toBe(0);
  });

  it("fails containsNone when forbidden substring present", () => {
    expect(scoreResponse(item({ containsNone: ["bad"] }), "good").score).toBe(1);
    expect(scoreResponse(item({ containsNone: ["bad"] }), "so bad").score).toBe(0);
  });

  it("validates JSON", () => {
    expect(scoreResponse(item({ isJson: true }), '{"a":1}').score).toBe(1);
    expect(scoreResponse(item({ isJson: true }), "not json").score).toBe(0);
  });

  it("checks jsonPathEquals", () => {
    expect(
      scoreResponse(
        item({ jsonPathEquals: { path: "layout", values: ["two_column"] } }),
        '{"layout":"two_column"}',
      ).score,
    ).toBe(1);
    expect(
      scoreResponse(
        item({ jsonPathEquals: { path: "layout", values: ["two_column"] } }),
        '{"layout":"image_right"}',
      ).score,
    ).toBe(0);
  });

  it("validates codeRuns via new Function", () => {
    expect(scoreResponse(item({ codeRuns: true }), "const x = 1;").score).toBe(1);
    expect(scoreResponse(item({ codeRuns: true }), "const x = ;").score).toBe(0);
  });

  it("enforces numericRange", () => {
    expect(scoreResponse(item({ numericRange: [5, 10] }), "7").score).toBe(1);
    expect(scoreResponse(item({ numericRange: [5, 10] }), "2").score).toBe(0);
    expect(scoreResponse(item({ numericRange: [5, 10] }), "score: 8/10").score).toBe(1);
  });

  it("combines multiple expectations (all must pass)", () => {
    const exp = { containsAll: ["<section"], containsNone: ["```"] };
    expect(scoreResponse(item(exp), "<section>hi</section>").score).toBe(1);
    expect(scoreResponse(item(exp), "```html\n<section></section>\n```").score).toBe(0);
  });
});

describe("helpers", () => {
  it("stripFences removes markdown code fences", () => {
    expect(stripFences("```js\nlet x = 1;\n```")).toBe("let x = 1;");
    expect(stripFences("no fence")).toBe("no fence");
  });

  it("extractNumber finds first number", () => {
    expect(extractNumber("score is 7")).toBe(7);
    expect(extractNumber("8.5")).toBe(8.5);
    expect(extractNumber("none here")).toBeNull();
  });

  it("isSyntacticallyValidJs catches syntax errors", () => {
    expect(isSyntacticallyValidJs("slide.addText('hi')")).toBe(true);
    expect(isSyntacticallyValidJs("slide.addText(")).toBe(false);
  });
});

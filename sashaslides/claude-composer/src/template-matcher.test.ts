import { describe, it, expect } from "vitest";
import { scoreTemplate, matchTemplate, matchAllSlides } from "./template-matcher.js";
import { createTemplate, type Template } from "./template.js";
import { createSlide } from "./slide.js";
import type { ParsedSlide } from "./markdown-parser.js";

function makeParsed(overrides: Partial<ParsedSlide> = {}): ParsedSlide {
  return {
    title: "Test Slide",
    body: ["Line one", "Line two"],
    headingLevel: 2,
    layoutHint: "title_and_body",
    images: [],
    notes: "",
    ...overrides,
  };
}

function makeTemplate(overrides: Partial<Template> = {}): Template {
  return createTemplate({
    id: "t1",
    presentationId: "pres1",
    slide: createSlide({
      slideId: "s1",
      layout: "TITLE_AND_BODY",
      elements: [
        {
          objectId: "e1",
          kind: "shape",
          text: "Title",
          transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, width: 100, height: 50 },
          style: { fontSize: 24, bold: true, italic: false, fontFamily: "Arial", foregroundColor: null, backgroundColor: null },
        },
        {
          objectId: "e2",
          kind: "shape",
          text: "Body",
          transform: { translateX: 0, translateY: 50, scaleX: 1, scaleY: 1, width: 100, height: 200 },
          style: { fontSize: 14, bold: false, italic: false, fontFamily: "Arial", foregroundColor: null, backgroundColor: null },
        },
      ],
    }),
    ...overrides,
  });
}

describe("scoreTemplate", () => {
  it("scores high for matching layout tags", () => {
    const parsed = makeParsed({ layoutHint: "title_and_body" });
    const template = makeTemplate();
    const score = scoreTemplate(parsed, template);
    expect(score).toBeGreaterThan(0.5);
  });

  it("scores low for mismatched layout tags", () => {
    const parsed = makeParsed({ layoutHint: "image_with_caption" });
    const template = makeTemplate();
    // Template has title_and_body tags, parsed wants image_with_caption
    // image_with_caption prefers ["image_with_caption", "title_and_body"]
    // so it should still get partial score from title_and_body fallback
    const score = scoreTemplate(parsed, template);
    expect(score).toBeLessThan(0.8);
  });

  it("considers description keyword overlap", () => {
    const parsed = makeParsed({ title: "Revenue Growth" });
    const templateWithDesc = makeTemplate({ description: "quarterly revenue growth chart" });
    const templateNoDesc = makeTemplate({ description: "" });
    expect(scoreTemplate(parsed, templateWithDesc)).toBeGreaterThan(
      scoreTemplate(parsed, templateNoDesc)
    );
  });
});

describe("matchTemplate", () => {
  it("returns null for empty templates", () => {
    expect(matchTemplate(makeParsed(), [])).toBeNull();
  });

  it("picks the best matching template", () => {
    const parsed = makeParsed({ layoutHint: "title_and_body" });
    const goodTemplate = makeTemplate({ id: "good" });
    const badTemplate = makeTemplate({
      id: "bad",
      slide: createSlide({ slideId: "s2", layout: "BLANK" }),
    });

    // Force bad template to have blank tag
    const result = matchTemplate(parsed, [badTemplate, goodTemplate]);
    expect(result).not.toBeNull();
    expect(result!.template.id).toBe("good");
  });

  it("includes a reason string", () => {
    const result = matchTemplate(makeParsed(), [makeTemplate()]);
    expect(result!.reason).toContain("score=");
  });
});

describe("matchAllSlides", () => {
  it("matches each parsed slide independently", () => {
    const slides = [
      makeParsed({ title: "Slide 1" }),
      makeParsed({ title: "Slide 2" }),
    ];
    const templates = [makeTemplate()];
    const results = matchAllSlides(slides, templates);
    expect(results).toHaveLength(2);
  });
});

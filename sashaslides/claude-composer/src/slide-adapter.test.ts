import { describe, it, expect } from "vitest";
import { adaptTemplate } from "./slide-adapter.js";
import { createMatchResult, type MatchResult } from "./match-result.js";
import { createTemplate } from "./template.js";
import { createSlide, type SlideElement } from "./slide.js";
import type { ParsedSlide } from "./markdown-parser.js";

function makeElement(id: string, text: string): SlideElement {
  return {
    objectId: id,
    kind: "shape",
    text,
    transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, width: 100, height: 50 },
    style: { fontSize: 14, bold: false, italic: false, fontFamily: null, foregroundColor: null, backgroundColor: null },
  };
}

function makeMatch(
  parsedOverrides: Partial<ParsedSlide> = {},
  elements: SlideElement[] = [makeElement("title_el", "Old Title"), makeElement("body_el", "Old Body")]
): MatchResult {
  const parsed: ParsedSlide = {
    title: "New Title",
    body: ["New body line 1", "New body line 2"],
    headingLevel: 2,
    layoutHint: "title_and_body",
    images: [],
    notes: "",
    ...parsedOverrides,
  };

  const template = createTemplate({
    id: "t1",
    presentationId: "pres1",
    slide: createSlide({
      slideId: "slide1",
      elements,
    }),
  });

  return createMatchResult(parsed, template, 0.8, "test match");
}

describe("adaptTemplate", () => {
  it("generates delete + insert requests for title", () => {
    const result = adaptTemplate(makeMatch());
    const titleRequests = result.requests.filter((r) => r.objectId === "title_el");
    expect(titleRequests).toHaveLength(2);
    expect(titleRequests[0].kind).toBe("deleteText");
    expect(titleRequests[1].kind).toBe("insertText");
    expect(titleRequests[1].fields.text).toBe("New Title");
  });

  it("generates requests for body elements", () => {
    const result = adaptTemplate(makeMatch());
    const bodyRequests = result.requests.filter((r) => r.objectId === "body_el");
    expect(bodyRequests.length).toBeGreaterThan(0);
  });

  it("sets slideId from template", () => {
    const result = adaptTemplate(makeMatch());
    expect(result.slideId).toBe("slide1");
  });

  it("updates expected slide title", () => {
    const result = adaptTemplate(makeMatch());
    const titleEl = result.expectedSlide.elements.find((e) => e.objectId === "title_el");
    expect(titleEl?.text).toBe("New Title");
  });

  it("preserves notes from parsed slide", () => {
    const result = adaptTemplate(makeMatch({ notes: "Speaker note" }));
    expect(result.expectedSlide.notes).toBe("Speaker note");
  });

  it("handles empty template elements", () => {
    const result = adaptTemplate(makeMatch({}, []));
    expect(result.requests).toHaveLength(0);
  });
});

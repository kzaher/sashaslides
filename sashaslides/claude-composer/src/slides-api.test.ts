import { describe, it, expect } from "vitest";
import { extractPresentationId } from "./slides-api.js";

describe("extractPresentationId", () => {
  it("extracts ID from edit URL", () => {
    const url = "https://docs.google.com/presentation/d/abc123_DEF/edit";
    expect(extractPresentationId(url)).toBe("abc123_DEF");
  });

  it("extracts ID from URL with slide fragment", () => {
    const url = "https://docs.google.com/presentation/d/abc123/edit#slide=id.p1";
    expect(extractPresentationId(url)).toBe("abc123");
  });

  it("extracts ID from short URL", () => {
    const url = "https://docs.google.com/presentation/d/XYZ-789/";
    expect(extractPresentationId(url)).toBe("XYZ-789");
  });

  it("throws for invalid URL", () => {
    expect(() => extractPresentationId("https://example.com/not-slides")).toThrow(
      "Cannot extract presentation ID"
    );
  });
});

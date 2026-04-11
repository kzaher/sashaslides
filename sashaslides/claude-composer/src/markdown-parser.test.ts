import { describe, it, expect } from "vitest";
import { parseMarkdown } from "./markdown-parser.js";

describe("parseMarkdown", () => {
  it("parses a single title-only slide", () => {
    const result = parseMarkdown("# Welcome");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Welcome");
    expect(result[0].body).toHaveLength(0);
    expect(result[0].headingLevel).toBe(1);
    expect(result[0].layoutHint).toBe("title_only");
  });

  it("parses title and body", () => {
    const md = `## Revenue Growth
- Q1: $10M
- Q2: $15M
- Q3: $20M`;
    const result = parseMarkdown(md);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Revenue Growth");
    expect(result[0].body).toEqual(["- Q1: $10M", "- Q2: $15M", "- Q3: $20M"]);
    expect(result[0].layoutHint).toBe("title_and_body");
  });

  it("parses multiple slides", () => {
    const md = `# Intro

## Slide One
Content here

## Slide Two
More content`;
    const result = parseMarkdown(md);
    expect(result).toHaveLength(3);
    expect(result[0].title).toBe("Intro");
    expect(result[1].title).toBe("Slide One");
    expect(result[2].title).toBe("Slide Two");
  });

  it("extracts speaker notes from blockquotes", () => {
    const md = `## My Slide
Some content
> This is a speaker note
> Second line`;
    const result = parseMarkdown(md);
    expect(result[0].notes).toBe("This is a speaker note\nSecond line");
  });

  it("extracts images", () => {
    const md = `## Photo Slide
![alt text](https://example.com/photo.png)`;
    const result = parseMarkdown(md);
    expect(result[0].images).toEqual(["https://example.com/photo.png"]);
    expect(result[0].layoutHint).toBe("image_with_caption");
  });

  it("detects two-column layout", () => {
    const md = `## Comparison
Left side | Right side
Feature A | Feature B`;
    const result = parseMarkdown(md);
    expect(result[0].layoutHint).toBe("two_columns");
  });

  it("detects section headers (h1 with body)", () => {
    const md = `# Section Title
A subtitle here`;
    const result = parseMarkdown(md);
    expect(result[0].layoutHint).toBe("section_header");
  });

  it("returns empty for blank input", () => {
    expect(parseMarkdown("")).toHaveLength(0);
    expect(parseMarkdown("   \n  \n")).toHaveLength(0);
  });
});

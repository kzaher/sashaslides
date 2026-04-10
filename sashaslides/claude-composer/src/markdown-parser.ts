/**
 * Parses markdown into structured slide descriptors for template matching.
 */

export type ParsedSlide = Readonly<{
  /** Slide title from the heading. */
  title: string;
  /** Body content lines (bullet points, paragraphs). */
  body: readonly string[];
  /** Heading level that started this slide (1 = #, 2 = ##, etc.). */
  headingLevel: number;
  /** Inferred layout hint based on content structure. */
  layoutHint: "title_only" | "title_and_body" | "section_header" | "two_columns" | "image_with_caption";
  /** Image URLs found in the slide content. */
  images: readonly string[];
  /** Speaker notes (from blockquote > lines). */
  notes: string;
}>;

export function parseMarkdown(markdown: string): readonly ParsedSlide[] {
  const lines = markdown.split("\n");
  const slides: ParsedSlide[] = [];
  let current: { title: string; headingLevel: number; body: string[]; images: string[]; notes: string[] } | null = null;

  const flush = () => {
    if (current) {
      slides.push(buildParsedSlide(current));
    }
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flush();
      current = {
        title: headingMatch[2].trim(),
        headingLevel: headingMatch[1].length,
        body: [],
        images: [],
        notes: [],
      };
      continue;
    }

    if (!current) continue;

    // Speaker notes: lines starting with >
    const noteMatch = line.match(/^>\s*(.*)$/);
    if (noteMatch) {
      current.notes.push(noteMatch[1]);
      continue;
    }

    // Images: ![alt](url)
    const imgMatch = line.match(/!\[.*?\]\((.+?)\)/);
    if (imgMatch) {
      current.images.push(imgMatch[1]);
      continue;
    }

    // Skip empty lines but keep content
    const trimmed = line.trim();
    if (trimmed) {
      current.body.push(trimmed);
    }
  }

  flush();
  return slides;
}

function buildParsedSlide(raw: {
  title: string;
  headingLevel: number;
  body: string[];
  images: string[];
  notes: string[];
}): ParsedSlide {
  return {
    title: raw.title,
    body: raw.body,
    headingLevel: raw.headingLevel,
    images: raw.images,
    notes: raw.notes.join("\n"),
    layoutHint: inferLayoutHint(raw),
  };
}

function inferLayoutHint(raw: {
  headingLevel: number;
  body: string[];
  images: string[];
}): ParsedSlide["layoutHint"] {
  if (raw.images.length > 0) return "image_with_caption";
  if (raw.headingLevel === 1 && raw.body.length === 0) return "title_only";
  if (raw.headingLevel === 1) return "section_header";

  // Detect two-column layout: lines separated by " | " or "||"
  const hasSeparator = raw.body.some((l) => l.includes(" | ") || l.includes("||"));
  if (hasSeparator) return "two_columns";

  return "title_and_body";
}

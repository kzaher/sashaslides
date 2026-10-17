/**
 * slides-md.ts — the whiteboard `slides.md` format and its parser, shared by
 * generate-pptx.ts and render-assets.ts.
 *
 * Slides are separated by `---` lines. Within a slide: `#`/`##` headings give the
 * title then subtitle (a heading starting `PART ` marks a section header), `>` lines
 * are speaker notes, a pipe table with a `|---|` separator row is the table, and every
 * other non-blank line is body text. A first note line of `whiteboard=1` opts the
 * slide into whiteboard styling and is stripped from the notes.
 */

export type SlideTable = Readonly<{ headers: readonly string[]; rows: readonly (readonly string[])[] }>;

export type SlideData = Readonly<{
  title: string;
  subtitle: string;
  bodyLines: readonly string[];
  table: SlideTable | null;
  notes: string;
  isSectionHeader: boolean;
  isTitleSlide: boolean;
  isClosing: boolean;
  whiteboard: boolean; // first `>` line was `whiteboard=1`
}>;

const SEPARATOR_ROW = /^[\s|:-]+$/;

export function parseSlides(md: string): SlideData[] {
  const blocks = md.split(/\n---\n/);
  const slides: SlideData[] = [];

  for (const block of blocks) {
    const lines = block.trim().split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;

    let title = "";
    let subtitle = "";
    const bodyLines: string[] = [];
    const notes: string[] = [];
    let isSectionHeader = false;
    let table: SlideTable | null = null;
    let inTable = false;

    for (let li = 0; li < lines.length; li++) {
      // SAFETY: li < lines.length, so the index is in range.
      const line = lines[li]!;

      if (line.startsWith(">")) {
        notes.push(line.replace(/^>\s*/, ""));
        continue;
      }

      if (line.includes("|") && !line.startsWith("#")) {
        const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
        if (SEPARATOR_ROW.test(line)) continue;
        if (!inTable) {
          const next = lines[li + 1];
          if (next && SEPARATOR_ROW.test(next)) {
            table = { headers: cells, rows: [] };
            inTable = true;
            continue;
          }
        }
        if (inTable && table) {
          // `prev` is annotated to break TS's circular inference on the
          // self-referential spread assignment (`table = {...table}`).
          const prev: SlideTable = table;
          table = { ...prev, rows: [...prev.rows, cells] };
          continue;
        }
      } else {
        inTable = false;
      }

      if (/^#{1,2}\s/.test(line)) {
        const text = line.replace(/^#+\s+/, "").replace(/\*\*/g, "");
        if (text.startsWith("PART ")) {
          isSectionHeader = true;
          continue;
        }
        if (!title) title = text;
        else if (!subtitle) subtitle = text;
        continue;
      }

      bodyLines.push(line);
    }

    // The marker MUST be the first `>` line on the slide; anywhere else it is a
    // regular note. Strip it before computing subtitle/notes so it never leaks
    // into displayed text.
    const whiteboard = notes[0] === "whiteboard=1";
    if (whiteboard) notes.shift();

    const isTitleSlide =
      (lines[0]?.startsWith("# ") ?? false) && bodyLines.length === 0 && !isSectionHeader && !table;
    const isClosing = title.toLowerCase().includes("thank you");

    const firstNote = notes[0];
    if (firstNote !== undefined && !subtitle) subtitle = firstNote;
    if (isTitleSlide && notes.length > 0) subtitle = notes.join(" | ");

    slides.push({
      title,
      subtitle,
      bodyLines,
      table,
      notes: notes.join("\n"),
      isSectionHeader,
      isTitleSlide,
      isClosing,
      whiteboard,
    });
  }

  return slides;
}

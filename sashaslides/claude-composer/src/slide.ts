/**
 * Core slide types — one immutable type per file.
 */

export type SlideElement = Readonly<{
  objectId: string;
  kind: "shape" | "image" | "table" | "line";
  /** Content text (for shapes). */
  text: string | null;
  /** Bounding box in EMU (English Metric Units used by Slides API). */
  transform: Readonly<{
    translateX: number;
    translateY: number;
    scaleX: number;
    scaleY: number;
    width: number;
    height: number;
  }>;
  /** Style hints carried through matching. */
  style: Readonly<{
    fontSize: number | null;
    bold: boolean;
    italic: boolean;
    fontFamily: string | null;
    foregroundColor: string | null;
    backgroundColor: string | null;
  }>;
}>;

export type Slide = Readonly<{
  slideId: string;
  /** 0-based position in the presentation. */
  index: number;
  elements: readonly SlideElement[];
  /** Layout reference from Google Slides (e.g. "TITLE", "TITLE_AND_BODY"). */
  layout: string;
  /** Notes text for speaker notes. */
  notes: string;
}>;

export function createSlide(partial: Partial<Slide> & Pick<Slide, "slideId">): Slide {
  return {
    slideId: partial.slideId,
    index: partial.index ?? 0,
    elements: partial.elements ?? [],
    layout: partial.layout ?? "BLANK",
    notes: partial.notes ?? "",
  };
}

export function withElements(slide: Slide, elements: readonly SlideElement[]): Slide {
  return { ...slide, elements };
}

export function withNotes(slide: Slide, notes: string): Slide {
  return { ...slide, notes };
}

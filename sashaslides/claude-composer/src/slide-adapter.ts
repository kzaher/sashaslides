/**
 * Slide adapter — takes a MatchResult and produces Google Slides API requests
 * that transform the template slide into the desired content.
 */

import type { MatchResult } from "./match-result.js";
import type { Slide, SlideElement } from "./slide.js";

/** A Google Slides API batch update request. */
export type SlideRequest = Readonly<{
  /** The request type (maps to Slides API request kinds). */
  kind: "insertText" | "deleteText" | "updateTextStyle" | "createSlide" | "replaceAllText";
  /** The target object ID. */
  objectId: string;
  /** Request-specific fields. */
  fields: Readonly<Record<string, unknown>>;
}>;

export type AdaptResult = Readonly<{
  /** The slide ID being modified/created. */
  slideId: string;
  /** Ordered batch update requests to send to the Slides API. */
  requests: readonly SlideRequest[];
  /** The expected resulting slide state (for preview). */
  expectedSlide: Slide;
}>;

/**
 * Generate Slides API requests to adapt a template to match desired content.
 */
export function adaptTemplate(match: MatchResult): AdaptResult {
  const { parsedSlide, template } = match;
  const requests: SlideRequest[] = [];
  const templateSlide = template.slide;

  // Find text elements in the template to replace
  const textElements = templateSlide.elements.filter(
    (el) => el.kind === "shape" && el.text !== null
  );

  // Strategy: map parsed content to template text elements
  // First element gets the title, rest get body lines
  const titleElement = textElements[0];
  const bodyElements = textElements.slice(1);

  if (titleElement) {
    requests.push(
      ...replaceText(titleElement, parsedSlide.title)
    );
  }

  // Distribute body lines across remaining elements
  const bodyLines = parsedSlide.body;
  for (let i = 0; i < bodyElements.length; i++) {
    const element = bodyElements[i];
    if (i < bodyLines.length) {
      requests.push(...replaceText(element, bodyLines[i]));
    } else {
      // Clear extra elements
      requests.push(...replaceText(element, ""));
    }
  }

  // If more body lines than elements, concatenate into the last body element
  if (bodyLines.length > bodyElements.length && bodyElements.length > 0) {
    const lastElement = bodyElements[bodyElements.length - 1];
    const extraLines = bodyLines.slice(bodyElements.length - 1).join("\n");
    // Replace the last request set for this element
    const lastElementRequests = requests.filter((r) => r.objectId === lastElement.objectId);
    if (lastElementRequests.length > 0) {
      // Remove existing requests for this element and add combined one
      const filtered = requests.filter((r) => r.objectId !== lastElement.objectId);
      filtered.push(...replaceText(lastElement, extraLines));
      requests.length = 0;
      requests.push(...filtered);
    }
  }

  // Build expected slide state
  const newElements: SlideElement[] = templateSlide.elements.map((el) => {
    if (el === titleElement) {
      return { ...el, text: parsedSlide.title };
    }
    const bodyIdx = bodyElements.indexOf(el);
    if (bodyIdx >= 0 && bodyIdx < bodyLines.length) {
      return { ...el, text: bodyLines[bodyIdx] };
    }
    return el;
  });

  return {
    slideId: templateSlide.slideId,
    requests,
    expectedSlide: {
      ...templateSlide,
      elements: newElements,
      notes: parsedSlide.notes || templateSlide.notes,
    },
  };
}

function replaceText(element: SlideElement, newText: string): SlideRequest[] {
  const requests: SlideRequest[] = [];

  // Delete existing text
  if (element.text) {
    requests.push({
      kind: "deleteText",
      objectId: element.objectId,
      fields: {
        textRange: { type: "ALL" },
      },
    });
  }

  // Insert new text
  if (newText) {
    requests.push({
      kind: "insertText",
      objectId: element.objectId,
      fields: {
        text: newText,
        insertionIndex: 0,
      },
    });
  }

  return requests;
}

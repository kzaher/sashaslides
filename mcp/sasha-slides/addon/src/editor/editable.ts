// WHAT THIS ELEMENT WILL ACCEPT — the refusals, in one place.
//
// The contract's rule is that an edit the editor cannot express as one of the five kinds is
// "dropped with a warning, never approximated". Approximation is the tempting failure: an inline
// `<em>` cannot be moved by a transform (CSS says transforms do not apply to a non-replaced inline
// element), and the approximations available -- flipping it to `inline-block`, or wrapping it --
// change the slide's line breaking behind the user's back. So the gesture is refused, by name, and
// the overlay simply does not offer a handle it cannot honour.
//
// Pure facts in, a reason out: every rule below is unit-tested without a DOM.

/** Allowed, or refused with the sentence the warning will carry. */
export type Permission = Readonly<{ kind: "allowed" }> | Readonly<{ kind: "refused"; reason: string }>;

export const ALLOWED: Permission = { kind: "allowed" };

/** What one live element looks like to the rules. Measured once, when it is selected. */
export type LayoutFacts = Readonly<{
  tag: string;
  /** Computed `display`. */
  display: string;
  /** True when some element child is laid out as a block-level box. */
  hasBlockChildren: boolean;
  /** True when the element renders any non-whitespace text of its own. */
  hasText: boolean;
  /** `img`, `svg`, `canvas`, `video`, `iframe`, `object` — a box with intrinsic content. */
  isReplaced: boolean;
}>;

/** Tags whose geometry, colour and text belong to the slide itself, not to an element on it. */
const STRUCTURAL_TAGS: ReadonlySet<string> = new Set(["html", "body"]);

export function mayMove(facts: LayoutFacts): Permission {
  if (STRUCTURAL_TAGS.has(facts.tag)) {
    return { kind: "refused", reason: `<${facts.tag}> is the slide itself, not an element on it` };
  }
  if (isInlineFlow(facts) && !facts.isReplaced) {
    return {
      kind: "refused",
      reason: `<${facts.tag}> is a non-replaced inline element, and CSS transforms do not apply to one; moving it would need a display change that re-wraps the line`,
    };
  }
  return ALLOWED;
}

export function mayResize(facts: LayoutFacts): Permission {
  if (STRUCTURAL_TAGS.has(facts.tag)) {
    return { kind: "refused", reason: `<${facts.tag}> is the slide itself; its size is the 1280x720 page` };
  }
  if (isInlineFlow(facts) && !facts.isReplaced) {
    return {
      kind: "refused",
      reason: `a non-replaced inline <${facts.tag}> ignores width and height; its box is the text inside it`,
    };
  }
  return ALLOWED;
}

export function mayRecolour(facts: LayoutFacts): Permission {
  if (facts.tag === "html") return { kind: "refused", reason: "<html> paints nothing of its own" };
  return ALLOWED;
}

/**
 * `retext` carries PLAIN text, so it replaces the element's whole text run -- `<h1>Paths in,
 * <em>ids out</em></h1>` becomes one text node and the `<em>` is gone. That is a fair reading of
 * "the user typed new words" for a text run, and a terrible one for a container: retexting a flex
 * row would delete its cards. So a container with block-level children is refused.
 */
export function mayRetext(facts: LayoutFacts): Permission {
  if (STRUCTURAL_TAGS.has(facts.tag)) {
    return { kind: "refused", reason: `retexting <${facts.tag}> would replace the whole slide with one line` };
  }
  if (facts.isReplaced) return { kind: "refused", reason: `<${facts.tag}> renders content, not text` };
  if (facts.hasBlockChildren) {
    return {
      kind: "refused",
      reason: `<${facts.tag}> is a container of blocks; retexting it would delete them. Select the text inside it instead`,
    };
  }
  if (!facts.hasText) return { kind: "refused", reason: `<${facts.tag}> has no text of its own to replace` };
  return ALLOWED;
}

export function mayRemove(facts: LayoutFacts): Permission {
  if (STRUCTURAL_TAGS.has(facts.tag)) {
    return { kind: "refused", reason: `removing <${facts.tag}> would remove the slide` };
  }
  return ALLOWED;
}

/** Facts for one live element, with its own `getComputedStyle` reads. */
export function layoutFactsOf({ element, view }: { element: Element; view: Window }): LayoutFacts {
  const display = view.getComputedStyle(element).display;
  let hasBlockChildren = false;
  for (const child of element.children) {
    const childDisplay = view.getComputedStyle(child).display;
    if (childDisplay !== "none" && !INLINE_DISPLAYS.has(childDisplay)) hasBlockChildren = true;
  }
  return {
    tag: element.tagName.toLowerCase(),
    display,
    hasBlockChildren,
    hasText: ownTextOf(element).length > 0,
    isReplaced: REPLACED_TAGS.has(element.tagName.toLowerCase()),
  };
}

/** The element's rendered text, trimmed — what a `retext` would be replacing. */
export function ownTextOf(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

const REPLACED_TAGS: ReadonlySet<string> = new Set(["img", "svg", "canvas", "video", "iframe", "object", "embed", "input", "textarea", "select"]);

/** `display` values that put a box in inline flow, where width/height/transform do not apply. */
const INLINE_DISPLAYS: ReadonlySet<string> = new Set(["inline", "contents"]);

function isInlineFlow(facts: LayoutFacts): boolean {
  return INLINE_DISPLAYS.has(facts.display);
}

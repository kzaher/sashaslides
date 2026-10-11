// THE TARGET SELECTOR — "which element" as a string a model can read.
//
// `target` is the only name the model ever gets for a thing on the slide, so `h1.title` and
// `.cards .card:nth-of-type(2)` are worth real work, and `body > div:nth-child(7) > span:nth-child(2)`
// is a failure even though it is perfectly unique: nothing downstream can reason about it, and the
// user cannot recognise their own element in a review row.
//
// HOW A SELECTOR IS CHOSEN. Candidates are generated from most meaningful to least and the FIRST
// one that matches exactly one element in the document wins:
//
//   1. `#id`                       — the author named it; nothing beats that.
//   2. `tag.class`                 — the author's own vocabulary, with the tag for readability.
//   3. `tag.classA.classB`         — two classes when one is shared.
//   4. `tag.class:nth-of-type(n)`  — "the second flagged cell": still the author's word for it.
//   5. `tag`                       — `h1`, `table`, `figure`: unique on most slides, and ideal.
//   6. `<named ancestor> tag…`     — scope by the nearest ancestor that has a name of its own, so
//                                    a card's heading reads `div.card:nth-of-type(2) h2` rather
//                                    than a chain of child indices.
//   7. `tag:nth-of-type(n)`        — positional, but at least typed: "the third paragraph".
//   8. a full `nth-of-type` path   — the ugly last resort, and the only one that cannot fail.
//
// Generation is PURE (facts in, strings out) and uniqueness is checked by an injected counter, so
// every rule above is unit-tested without a DOM.
//
// STABILITY. The map is built ONCE, in `selectorIndexOf`, when the editor attaches. Edits change
// text and inline styles, and a later recomputation could pick a different (still unique) name for
// the same element; the model would then see two targets for one thing. So the name an element is
// given on attach is the name it keeps for the session, even if a better one becomes available.

/** Everything selector generation needs to know about one element. No DOM, no live node. */
export type ElementFacts = Readonly<{
  /** Lowercase tag name. */
  tag: string;
  /** The `id` attribute when it is usable as a CSS identifier, else null. */
  id: string | null;
  /** Class names usable as CSS identifiers, in attribute order. */
  classes: readonly string[];
  /** 1-based position among same-tag siblings, which is what `:nth-of-type` counts. */
  nthOfType: number;
}>;

/** The element first, then each ancestor outward, ending at the element whose tag is `body`. */
export type FactsPath = readonly ElementFacts[];

/** At most this many named ancestors are tried before falling back to a positional path. */
const ANCESTOR_SCOPES = 2;

/** Candidate selectors for the element at `path[0]`, best first and de-duplicated. */
export function selectorCandidates(path: FactsPath): readonly string[] {
  const self = path[0];
  if (self === undefined) return [];
  const candidates: string[] = [];
  const local = localForms(self);
  for (const form of local) candidates.push(form);
  for (const scope of namedScopes(path)) {
    for (const form of local) candidates.push(`${scope} ${form}`);
    candidates.push(`${scope} ${self.tag}:nth-of-type(${self.nthOfType})`);
  }
  candidates.push(`${self.tag}:nth-of-type(${self.nthOfType})`);
  candidates.push(positionalPath(path));
  return [...new Set(candidates)];
}

/** The first candidate that names exactly one element. Null when even the path was not unique. */
export function pickSelector({
  candidates,
  countMatches,
}: {
  candidates: readonly string[];
  countMatches: (selector: string) => number;
}): string | null {
  for (const candidate of candidates) {
    if (countMatches(candidate) === 1) return candidate;
  }
  return null;
}

/**
 * `body > div:nth-of-type(2) > p:nth-of-type(1)` — unique by construction, unreadable by
 * construction. It exists so that `stableSelectorFor` never has to return "no name".
 */
export function positionalPath(path: FactsPath): string {
  const steps: string[] = [];
  for (const facts of path) {
    steps.unshift(facts.tag === "body" ? "body" : `${facts.tag}:nth-of-type(${facts.nthOfType})`);
  }
  return steps.join(" > ");
}

/** A CSS identifier we are willing to paste into a selector unescaped. */
export function isPlainCssIdentifier(name: string): boolean {
  return /^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(name);
}

/** Facts for one live element. The only DOM read in selector generation. */
export function factsOf(element: Element): ElementFacts {
  const id = element.getAttribute("id");
  const classes = [...element.classList].filter(isPlainCssIdentifier);
  return {
    tag: element.tagName.toLowerCase(),
    id: id !== null && isPlainCssIdentifier(id) ? id : null,
    classes,
    nthOfType: nthOfTypeOf(element),
  };
}

/** The facts path for `element`, outward to `root` inclusive. */
export function factsPathOf({ element, root }: { element: Element; root: Element }): FactsPath {
  const path: ElementFacts[] = [];
  let walker: Element | null = element;
  while (walker !== null) {
    path.push(factsOf(walker));
    if (walker === root) break;
    walker = walker.parentElement;
  }
  return path;
}

/**
 * Every element the editor can address, named once. Both directions are returned because the
 * overlay needs element -> target to record an edit and target -> element to apply one.
 */
export type SelectorIndex = Readonly<{
  targetOf: ReadonlyMap<Element, string>;
  elementOf: ReadonlyMap<string, Element>;
}>;

/** Tags that are never slide content, so they are never given a target. */
const NON_CONTENT_TAGS: ReadonlySet<string> = new Set(["script", "style", "link", "meta", "title", "base", "head"]);

export function selectorIndexOf({ root }: { root: Element }): SelectorIndex {
  const targetOf = new Map<Element, string>();
  const elementOf = new Map<string, Element>();
  const owner = root.ownerDocument;
  const countMatches = (selector: string): number => {
    try {
      return owner.querySelectorAll(selector).length;
    } catch {
      // An invalid selector is a generation bug, not a reason to take the editor down: treat it as
      // "matches nothing" so the next, duller candidate wins.
      return 0;
    }
  };
  for (const element of [root, ...root.querySelectorAll("*")]) {
    if (NON_CONTENT_TAGS.has(element.tagName.toLowerCase())) continue;
    const selector = pickSelector({ candidates: selectorCandidates(factsPathOf({ element, root })), countMatches });
    if (selector === null || elementOf.has(selector)) continue;
    targetOf.set(element, selector);
    elementOf.set(selector, element);
  }
  return { targetOf, elementOf };
}

/** `tag`, `tag.class`, `tag.a.b`, `tag.class:nth-of-type(n)` — the element's own vocabulary. */
function localForms(facts: ElementFacts): readonly string[] {
  const forms: string[] = [];
  if (facts.id !== null) forms.push(`#${facts.id}`);
  for (const className of facts.classes) forms.push(`${facts.tag}.${className}`);
  for (let first = 0; first < facts.classes.length; first++) {
    for (let second = first + 1; second < facts.classes.length; second++) {
      const a = facts.classes[first];
      const b = facts.classes[second];
      if (a !== undefined && b !== undefined) forms.push(`${facts.tag}.${a}.${b}`);
    }
  }
  // A class plus a position still carries the author's word for the thing, which a bare index
  // never does: `td.flag:nth-of-type(2)` beats a four-step child path for the same cell.
  for (const className of facts.classes) forms.push(`${facts.tag}.${className}:nth-of-type(${facts.nthOfType})`);
  forms.push(facts.tag);
  return forms;
}

/**
 * The nearest ancestors that have a name of their own, nearest first, `body` excluded. Each
 * contributes TWO forms -- itself, then itself qualified by position -- because a repeated
 * component (three `div.card`s in a row) needs the index to be a scope at all, and
 * `div.card:nth-of-type(2) h2` is still a sentence a human and a model can both read.
 */
function namedScopes(path: FactsPath): readonly string[] {
  const scopes: string[] = [];
  let used = 0;
  for (const facts of path.slice(1)) {
    if (facts.tag === "body") break;
    if (facts.id !== null) scopes.push(`#${facts.id}`);
    else {
      const named = classForm(facts);
      if (named === null) continue;
      // An id is already unique, so only a class scope ever needs the positional qualifier.
      scopes.push(named, `${named}:nth-of-type(${facts.nthOfType})`);
    }
    used++;
    if (used === ANCESTOR_SCOPES) break;
  }
  return scopes;
}

function classForm(facts: ElementFacts): string | null {
  const className = facts.classes[0];
  return className === undefined ? null : `${facts.tag}.${className}`;
}

function nthOfTypeOf(element: Element): number {
  const parent = element.parentElement;
  if (parent === null) return 1;
  let position = 0;
  for (const sibling of parent.children) {
    if (sibling.tagName === element.tagName) position++;
    if (sibling === element) return position;
  }
  return position;
}

// Selector choice: the rules that decide whether the model is told `h1.title` or
// `body > div:nth-of-type(7) > span:nth-of-type(2)`. Candidate GENERATION is pure, and uniqueness
// is an injected counter, so every rule is asserted here without a document.

import assert from "node:assert/strict";
import test from "node:test";
import {
  isPlainCssIdentifier,
  pickSelector,
  positionalPath,
  selectorCandidates,
  type ElementFacts,
  type FactsPath,
} from "./stable-selector.ts";

function facts(partial: Partial<ElementFacts> & Readonly<{ tag: string }>): ElementFacts {
  return { id: null, classes: [], nthOfType: 1, ...partial };
}

const BODY = facts({ tag: "body" });

test("an id the author wrote beats everything else", () => {
  const path: FactsPath = [facts({ tag: "div", id: "chart", classes: ["panel"] }), BODY];
  assert.equal(selectorCandidates(path)[0], "#chart");
});

test("without an id it is the author's own class, with the tag in front of it", () => {
  const path: FactsPath = [facts({ tag: "h1", classes: ["title", "big"] }), BODY];
  const candidates = selectorCandidates(path);
  assert.deepEqual(candidates.slice(0, 4), ["h1.title", "h1.big", "h1.title.big", "h1.title:nth-of-type(1)"]);
});

test("a repeated class keeps the author's word for it and adds the position", () => {
  // Two `td.flag` in one row: `td.flag:nth-of-type(2)` names the cell, a child-index path does not.
  const path: FactsPath = [facts({ tag: "td", classes: ["flag"], nthOfType: 2 }), facts({ tag: "tr" }), BODY];
  const unique = new Set(["td.flag:nth-of-type(2)"]);
  const picked = pickSelector({
    candidates: selectorCandidates(path),
    countMatches: (selector) => (unique.has(selector) ? 1 : 3),
  });
  assert.equal(picked, "td.flag:nth-of-type(2)");
});

test("an element with no name of its own is scoped by the nearest ancestor that has one", () => {
  const path: FactsPath = [
    facts({ tag: "h2" }),
    facts({ tag: "div", classes: ["card"], nthOfType: 2 }),
    facts({ tag: "div", classes: ["cards"] }),
    BODY,
  ];
  const unique = new Set(["div.card:nth-of-type(2) h2"]);
  const picked = pickSelector({
    candidates: selectorCandidates(path),
    countMatches: (selector) => (unique.has(selector) ? 1 : 3),
  });
  assert.equal(picked, "div.card:nth-of-type(2) h2");
});

test("a bare tag wins when the slide only has one of them", () => {
  const path: FactsPath = [facts({ tag: "table" }), facts({ tag: "div", classes: ["pane"] }), BODY];
  const picked = pickSelector({ candidates: selectorCandidates(path), countMatches: (selector) => (selector === "table" ? 1 : 5) });
  assert.equal(picked, "table");
});

test("the positional path is the last resort, and it is always reachable", () => {
  const path: FactsPath = [facts({ tag: "span", nthOfType: 2 }), facts({ tag: "div", nthOfType: 7 }), BODY];
  const candidates = selectorCandidates(path);
  const last = candidates[candidates.length - 1];
  assert.equal(last, "body > div:nth-of-type(7) > span:nth-of-type(2)");
  assert.equal(positionalPath(path), last);
  // Nothing else is unique, so that is what the picker lands on rather than returning "no name".
  assert.equal(pickSelector({ candidates, countMatches: (selector) => (selector === last ? 1 : 4) }), last);
});

test("no unique candidate at all is null, not a guess", () => {
  assert.equal(pickSelector({ candidates: ["p", "body p"], countMatches: () => 2 }), null);
});

test("a class that is not a plain CSS identifier is skipped rather than escaped", () => {
  assert.equal(isPlainCssIdentifier("card"), true);
  assert.equal(isPlainCssIdentifier("-sasha_1"), true);
  assert.equal(isPlainCssIdentifier("w-1/2"), false);
  assert.equal(isPlainCssIdentifier("2cols"), false);
  assert.equal(isPlainCssIdentifier(""), false);
});

test("candidates are de-duplicated, so the uniqueness check is never run twice on one string", () => {
  const path: FactsPath = [facts({ tag: "p", classes: ["lead", "lead"] }), BODY];
  const candidates = selectorCandidates(path);
  assert.equal(new Set(candidates).size, candidates.length);
});

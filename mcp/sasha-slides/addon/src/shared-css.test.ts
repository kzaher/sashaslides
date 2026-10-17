// SHARED SHEETS, SEVERAL SURFACES: a class name may mean exactly one thing.
//
// `BASE_CSS` ships on every surface and `WINDOW_CSS` on both wide windows (surface-stylesheets.ts),
// so a rule in either applies to several documents. A class name reused for a different component
// therefore silently restyles another surface -- and until 2026-10-17 ONE sheet shipped everywhere.
//
// THIS HAS HAPPENED TWICE. `.sasha-editor` was the visual editor's slot AND the editor window, so
// the window's card rules (white, rounded, shadowed, overflow hidden) landed on the little panel.
// Then `.sasha-composer` was the sidebar's message box AND the slide comment popup, so the
// message box turned into a floating card with a tail hovering over the log -- which is what the
// user reported as "I don't know what this popup is doing there".
//
// The test is cheap and the bug is not: both surfaces are rendered and their class names are
// compared, so a name introduced on one that already belongs to the other fails here.

import assert from "node:assert/strict";
import test from "node:test";
import { DIALOG_STYLESHEETS, SIDEBAR_STYLESHEETS } from "./surface-stylesheets.ts";

/** Every class name a rule in the given stylesheet targets. */
function styledClasses(css: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const match of css.matchAll(/\.([a-z][a-z0-9-]*)/gi)) {
    const name = match[1];
    if (name !== undefined && name.startsWith("sasha-")) found.add(name);
  }
  return found;
}

/**
 * The families each surface owns. A family is a prefix, because every component here names its
 * parts after itself (`sasha-spot`, `sasha-spot-head`, `sasha-spot-note`).
 */
const DIALOG_ONLY = ["sasha-spot", "sasha-cell", "sasha-grid", "sasha-toolrail", "sasha-ed-"];
const SIDEBAR_ONLY = ["sasha-composer", "sasha-chat", "sasha-msg"];

test("the dialog's own class families are not the sidebar's, and never the reverse", () => {
  for (const mine of DIALOG_ONLY) {
    for (const theirs of SIDEBAR_ONLY) {
      assert.ok(
        !mine.startsWith(theirs) && !theirs.startsWith(mine),
        `"${mine}" and "${theirs}" overlap -- one stylesheet, so one of the two surfaces is restyled`,
      );
    }
  }
});

test("THE POPUP BUG: the slide comment popup does not take the sidebar's message-box name", () => {
  // The popup exists under its own name, on the dialog...
  assert.ok(styledClasses(DIALOG_STYLESHEETS.join("\n")).has("sasha-spot"), "the slide comment popup is styled");
  // ...and NEITHER surface gives `.sasha-composer`, the sidebar's box you type a message into, the
  // popup's floating treatment: that hovered a tailed card over the Ask Sasha log, which shipped.
  for (const css of [DIALOG_STYLESHEETS.join("\n"), SIDEBAR_STYLESHEETS.join("\n")]) {
    assert.ok(
      !/\.sasha-composer\s*\{[^}]*position:\s*absolute/.test(css),
      "the sidebar's message box must not be given the popup's absolute positioning",
    );
    assert.ok(!/\.sasha-composer[^{]*::before/.test(css), "nor the popup's tail");
  }
});

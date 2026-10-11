// ONE STYLESHEET, TWO SURFACES: a class name may mean exactly one thing.
//
// `PICKER_CSS` is shipped by BOTH the slides dialog and the Ask Sasha sidebar (Conversation.tsx
// renders it in its own `<style>`), so every rule in it applies to both documents. A class name
// reused for a different component therefore silently restyles the other surface.
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
import { PICKER_CSS } from "./picker-styles.ts";

/** Every class name a rule in the shared stylesheet targets. */
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
  const styled = styledClasses(PICKER_CSS);
  // The popup exists under its own name...
  assert.ok(styled.has("sasha-spot"), "the slide comment popup is styled");
  // ...and it is NOT the floating treatment applied to `.sasha-composer`, which the sidebar uses
  // for the box you type a message into. A rule for that class here would hover a tailed card
  // over the Ask Sasha log, which is exactly what shipped.
  assert.ok(
    !/\.sasha-composer\s*\{[^}]*position:\s*absolute/.test(PICKER_CSS),
    "the sidebar's message box must not be given the popup's absolute positioning",
  );
  assert.ok(
    !/\.sasha-composer[^{]*::before/.test(PICKER_CSS),
    "nor the popup's tail",
  );
});

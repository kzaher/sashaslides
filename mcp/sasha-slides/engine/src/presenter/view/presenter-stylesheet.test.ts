// The presenter's own rules follow the shared Tidepool rules (src/theme/tidepool-theme.test.ts):
// tokens only, no colour literal, no blur, motion only without a reduced-motion preference, and
// the control bar over the slide in the nearly opaque glass.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { TIDEPOOL_TOKENS, tidepoolCustomProperties } from "../../theme/tidepool-theme.ts";
import { PRESENTER_CLASS, presenterRules } from "./presenter-stylesheet.ts";

describe("presenter stylesheet", () => {
  const rules = presenterRules();

  it("contains no colour literal: every colour comes from a token", () => {
    assert.equal(/#[0-9a-f]{3,8}\b/i.test(rules), false, "hexadecimal colour in the rules");
    assert.equal(/rgba?\(|hsla?\(/i.test(rules), false, "functional colour in the rules");
    // "white-space" is a property, not a colour.
    assert.equal(/\b(black|white)\b(?!-)/i.test(rules), false, "named colour in the rules");
  });

  it("reads only custom properties that the theme defines", () => {
    const defined = new Set(tidepoolCustomProperties({ tokens: TIDEPOOL_TOKENS, scheme: "light" }).map((property) => property.name));
    for (const match of rules.matchAll(/var\(--sasha-([a-z0-9-]+)\)/g)) assert.ok(defined.has(match[1] ?? ""), `--sasha-${match[1] ?? ""} is not defined`);
  });

  it("blurs nothing", () => {
    assert.equal(/backdrop-filter|filter:\s*blur/.test(rules), false);
  });

  it("animates only under prefers-reduced-motion: no-preference", () => {
    const outsideGated = rules.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, "");
    assert.equal(/animation:|transition:/.test(outsideGated), false);
  });

  it("puts the control bar over the slide in the glass made for overlapping the canvas", () => {
    const controls = new RegExp(`\\.${PRESENTER_CLASS.controls} \\{[^}]*\\}`).exec(rules)?.[0] ?? "";
    assert.match(controls, /background: var\(--sasha-glass-over-canvas\)/);
  });
});

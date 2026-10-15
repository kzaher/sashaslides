// The Tidepool tokens keep text readable: at least 4.5:1 for every text colour against every
// surface it is drawn on, in both schemes -- including the worst cases a reviewer measured failing
// before: chrome over a black or white SLIDE (menus and popovers overlap the canvas), the wash at
// every 10 degrees of its hue swing (not only at rest), inactive tabs on secondary pills, and peer
// labels in the dark scheme. Milestone 2's liquid glass (SPEC.md 21.11) is in every panel sample:
// the panel glass at its new alpha over the wash AFTER the backdrop filter's saturation, which
// makes the wash behind the glass more colourful than the wash itself. Then the stylesheet: every
// token is a custom property, the rules contain no colour literal, the panel blur exists only while
// no gesture runs, and motion stops under reduced motion.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { compositeOver, contrastRatio, opaque, parseColour, washFilter, type OpaqueColour } from "./colour-contrast.ts";
import { TIDEPOOL_TOKENS, tidepoolCustomProperties, type SchemeName, type TidepoolScheme } from "./tidepool-theme.ts";
import { TIDEPOOL_CLASS, tidepoolRules, tidepoolStylesheet } from "./tidepool-stylesheet.ts";

const BLACK: OpaqueColour = { red: 0, green: 0, blue: 0 };
const WHITE: OpaqueColour = { red: 255, green: 255, blue: 255 };

describe("Tidepool contrast", () => {
  for (const schemeName of ["light", "dark"] as const) {
    const scheme = TIDEPOOL_TOKENS[schemeName];
    const textColours = [scheme.text, scheme.textMuted, scheme.textSubtle, scheme.accent, scheme.danger, scheme.success, scheme.warning];

    it(`${schemeName}: every text colour reaches 4.5:1 on every chrome surface`, () => {
      for (const surface of chromeSurfaces(scheme)) {
        for (const textColour of textColours) {
          assertContrast({ text: opaque(textColour), background: surface.colour, minimum: 4.5, label: `${schemeName}: ${textColour} on ${surface.label}` });
        }
      }
    });

    it(`${schemeName}: pill text reaches 4.5:1 on ink and danger pills, at rest and hovered`, () => {
      for (const fill of [scheme.inkButton, scheme.inkButtonHover]) {
        assertContrast({ text: opaque(scheme.inkButtonText), background: opaque(fill), minimum: 4.5, label: `${schemeName}: ink text on ${fill}` });
      }
      for (const fill of [scheme.dangerButton, scheme.dangerButtonHover]) {
        assertContrast({ text: opaque(scheme.dangerButtonText), background: opaque(fill), minimum: 4.5, label: `${schemeName}: danger text on ${fill}` });
      }
    });

    it(`${schemeName}: secondary pills and tabs keep their text readable over the panel at every wash hue`, () => {
      for (const panel of panelOverWash(scheme)) {
        for (const pill of [scheme.secondaryButton, scheme.secondaryButtonHover]) {
          const background = compositeOver({ over: pill, under: panel.colour });
          for (const textColour of [scheme.text, scheme.textSubtle]) {
            assertContrast({ text: opaque(textColour), background, minimum: 4.5, label: `${schemeName}: ${textColour} on ${pill} over ${panel.label}` });
          }
        }
        const tabOn = compositeOver({ over: scheme.tabOn, under: panel.colour });
        assertContrast({ text: opaque(scheme.text), background: tabOn, minimum: 4.5, label: `${schemeName}: active tab over ${panel.label}` });
      }
    });

    it(`${schemeName}: peer colours stand out at 3:1 and their labels read at 4.5:1`, () => {
      const backgrounds = [{ label: "ground", colour: opaque(scheme.ground) }, ...panelOverWash(scheme)];
      for (const peer of scheme.peerColours) {
        for (const background of backgrounds) {
          assertContrast({ text: opaque(peer), background: background.colour, minimum: 3, label: `${schemeName}: peer ${peer} on ${background.label}` });
        }
        assertContrast({ text: opaque(scheme.peerLabelText), background: opaque(peer), minimum: 4.5, label: `${schemeName}: label on ${peer}` });
      }
    });

    it(`${schemeName}: the panel glass is liquid glass, alpha 0.26 to 0.45`, () => {
      const alpha = parseColour(scheme.panelGlass)?.alpha ?? Number.NaN;
      assert.ok(alpha >= 0.26 && alpha <= 0.45, `${scheme.panelGlass} has alpha ${alpha}`);
      const property = tidepoolCustomProperties({ tokens: TIDEPOOL_TOKENS, scheme: schemeName }).find((candidate) => candidate.name === "panel-glass");
      assert.equal(property?.value, scheme.panelGlass);
    });

    it(`${schemeName}: the selection outline stands out at 3:1 from its halo`, () => {
      assertContrast({ text: opaque(scheme.selection), background: opaque(scheme.selectionHalo), minimum: 3, label: `${schemeName}: selection on halo` });
    });
  }
});

describe("Tidepool stylesheet", () => {
  for (const schemeName of ["light", "dark"] as const satisfies readonly SchemeName[]) {
    it(`${schemeName}: every token becomes a --sasha- custom property`, () => {
      const properties = tidepoolCustomProperties({ tokens: TIDEPOOL_TOKENS, scheme: schemeName });
      const names = new Set(properties.map((property) => property.name));
      for (const expected of ["ground", "panel-glass", "panel-backdrop-filter", "glass-over-canvas", "scrim", "peer-colours-1", "lively-shape-gradients-5-2", "font-family", "space-medium", "layer-dialog", "control-focus-ring-width", "calm-hue-duration"]) {
        assert.ok(names.has(expected), `missing --sasha-${expected}`);
      }
      for (const property of properties) assert.equal(property.value.includes("undefined"), false, property.name);
    });
  }

  it("every custom property a rule reads is defined", () => {
    const defined = new Set(tidepoolCustomProperties({ tokens: TIDEPOOL_TOKENS, scheme: "light" }).map((property) => property.name));
    for (const match of tidepoolRules(TIDEPOOL_TOKENS).matchAll(/var\(--sasha-([a-z0-9-]+)\)/g)) {
      assert.ok(defined.has(match[1] ?? ""), `--sasha-${match[1] ?? ""} is read but never defined`);
    }
  });

  it("the rules contain no colour literal: every colour comes from a token", () => {
    const rules = tidepoolRules(TIDEPOOL_TOKENS);
    assert.equal(/#[0-9a-f]{3,8}\b/i.test(rules), false, "hexadecimal colour in the rules");
    assert.equal(/rgba?\(/i.test(rules), false, "functional colour in the rules");
  });

  it("the panels blur what is behind them only while no gesture is active; the lively card always", () => {
    const blurred = [...tidepoolRules(TIDEPOOL_TOKENS).matchAll(/([^{}]+)\{[^}]*backdrop-filter/g)].map((match) => (match[1] ?? "").trim());
    assert.deepEqual(blurred, [`.${TIDEPOOL_CLASS.root}:not([data-gesture="active"]) .${TIDEPOOL_CLASS.panel}`, `.${TIDEPOOL_CLASS.livelyCard}`]);
  });

  // The rows differ only in the selector a panel would be matched by: the gated one blurs, the
  // engine root during a gesture does not.
  for (const row of [
    { label: "a panel in an idle editor", rootGesture: "idle", blurs: true },
    { label: "control: a panel while a drag is active", rootGesture: "active", blurs: false },
  ] as const) {
    it(`${row.label} ${row.blurs ? "is" : "is not"} matched by the panel blur rule`, () => {
      const rule = /([^{}\n]+)\{[^}]*--sasha-panel-backdrop-filter/.exec(tidepoolRules(TIDEPOOL_TOKENS))?.[1] ?? "";
      const gated = /:not\(\[data-gesture="active"\]\)/.test(rule);
      assert.ok(gated, rule);
      assert.equal(row.rootGesture !== "active", row.blurs);
    });
  }

  it("every animation is gated on prefers-reduced-motion: no-preference", () => {
    const rules = tidepoolRules(TIDEPOOL_TOKENS);
    const withoutGatedBlocks = rules.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, "");
    assert.equal(/animation:|transition:/.test(withoutGatedBlocks), false);
  });

  // The control reset must lose to every class rule. The control row is the selector the reset used
  // to have, which outranked the ink pills and made their text invisible.
  const pillSpecificity = selectorSpecificity(`.${TIDEPOOL_CLASS.primaryPill}`);
  for (const row of [
    { label: "the shipped reset", selector: controlResetSelector(), losesToClasses: true },
    { label: "control: the old `.sasha-engine button` reset", selector: `.${TIDEPOOL_CLASS.root} button`, losesToClasses: false },
  ] as const) {
    it(`${row.label} ${row.losesToClasses ? "loses" : "wins"} against a pill's class rule`, () => {
      assert.equal(compareSpecificity(selectorSpecificity(row.selector), pillSpecificity) < 0, row.losesToClasses, `${row.selector}`);
    });
  }

  // A link dressed as a pill (the top bar's "Account") must read as the pill: the root's link rule
  // (`.sasha-engine a`, accent and underlined) outranks a bare pill class, so each pill needs an
  // anchor rule of its own. The control row is the link rule the Account link used to fall to.
  const linkRule = `.${TIDEPOOL_CLASS.root} a`;
  for (const row of [
    { pill: TIDEPOOL_CLASS.primaryPill, colour: "var(--sasha-ink-button-text)" },
    { pill: TIDEPOOL_CLASS.secondaryPill, colour: "var(--sasha-text)" },
    { pill: TIDEPOOL_CLASS.dangerPill, colour: "var(--sasha-danger-button-text)" },
  ] as const) {
    it(`a link with ${row.pill} has no underline, the pill's text colour, and outranks the root's link rule`, () => {
      const rules = [...tidepoolRules(TIDEPOOL_TOKENS).matchAll(/([^{}]+)\{([^}]*)\}/g)].map((match) => ({ selectors: (match[1] ?? "").split(",").map((selector) => selector.trim()), body: match[2] ?? "" }));
      const anchored = rules.filter((rule) => rule.selectors.some((selector) => selector.endsWith(`a.${row.pill}`)));
      assert.ok(anchored.length > 0, `a rule for links with ${row.pill}`);
      const body = anchored.map((rule) => rule.body).join(" ");
      assert.match(body, /text-decoration: none;/);
      assert.ok(body.includes(`color: ${row.colour};`), body);
      const selector = anchored.flatMap((rule) => rule.selectors).find((candidate) => candidate.endsWith(`a.${row.pill}`)) ?? "";
      assert.ok(compareSpecificity(selectorSpecificity(selector), selectorSpecificity(linkRule)) > 0, `${selector} outranks ${linkRule}`);
    });
  }

  it("the calm wash is drawn in its own element's box, not the viewport", () => {
    const washRule = /\.sasha-calm-ground::before \{([^}]*)\}/.exec(tidepoolRules(TIDEPOOL_TOKENS))?.[1] ?? "";
    assert.match(washRule, /position: absolute;/);
    assert.doesNotMatch(washRule, /position: fixed;/);
  });

  it("the stylesheet defines both schemes and honours a forced theme", () => {
    const sheet = tidepoolStylesheet(TIDEPOOL_TOKENS);
    assert.match(sheet, /@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\)/);
    assert.match(sheet, /:root\[data-theme="dark"\]/);
  });
});

type Surface = Readonly<{ label: string; colour: OpaqueColour }>;

/** Every surface text is drawn on in the editor chrome. */
function chromeSurfaces(scheme: TidepoolScheme): readonly Surface[] {
  const ground = opaque(scheme.ground);
  const surfaces: Surface[] = [{ label: "ground", colour: ground }];
  for (const panel of panelOverWash(scheme)) {
    surfaces.push(panel);
    surfaces.push({ label: `card on ${panel.label}`, colour: compositeOver({ over: scheme.cardGlass, under: panel.colour }) });
  }
  for (const wash of washSamples(scheme)) {
    surfaces.push({ label: `lively glass over ${wash.label}`, colour: compositeOver({ over: scheme.livelyGlass, under: wash.colour }) });
  }
  for (const slide of [{ label: "a black slide", colour: BLACK }, { label: "a white slide", colour: WHITE }]) {
    surfaces.push({ label: `glass over canvas on ${slide.label}`, colour: compositeOver({ over: scheme.glassOverCanvas, under: slide.colour }) });
    const dimmed = compositeOver({ over: scheme.scrim, under: slide.colour });
    surfaces.push({ label: `dialog over the scrim on ${slide.label}`, colour: compositeOver({ over: scheme.glassOverCanvas, under: dimmed }) });
  }
  return surfaces;
}

/**
 * The panel glass over the ground and over each wash colour at every sampled hue, as the backdrop
 * filter shows it: the blur averages a nearly uniform wash (no change), the saturation boosts it.
 */
function panelOverWash(scheme: TidepoolScheme): readonly Surface[] {
  const saturation = TIDEPOOL_TOKENS.panelBackdrop.saturation;
  return washSamples(scheme).map((wash) => ({
    label: `panel over ${wash.label}`,
    colour: compositeOver({ over: scheme.panelGlass, under: washFilter({ colour: wash.colour, hueDegrees: 0, saturation }) }),
  }));
}

/** The ground and the three wash colours, filtered at every 10 degrees of the calm swing. */
function washSamples(scheme: TidepoolScheme): readonly Surface[] {
  const motion = TIDEPOOL_TOKENS.motion;
  const samples: Surface[] = [];
  for (let degrees = 0; degrees <= motion.calmHueMaximumDegrees; degrees += 10) {
    const progress = degrees / motion.calmHueMaximumDegrees;
    const saturation = 1 + (motion.calmSaturateMaximum - 1) * progress;
    for (const colour of [scheme.ground, ...scheme.washColours]) {
      samples.push({ label: `${colour} at ${degrees} degrees`, colour: washFilter({ colour: opaque(colour), hueDegrees: degrees, saturation }) });
    }
  }
  return samples;
}

type Specificity = Readonly<{ identifiers: number; classes: number; elements: number }>;

/** The selector of the shared rule that resets buttons and fields to inherit the chrome font. */
function controlResetSelector(): string {
  const rule = /^([^{\n]*\bbutton\b[^{\n]*)\{ font: inherit; color: inherit; \}$/m.exec(tidepoolRules(TIDEPOOL_TOKENS));
  assert.ok(rule?.[1] !== undefined, "the control reset rule is missing");
  return rule[1].trim();
}

/** CSS specificity of one simple selector list entry; `:where(...)` counts nothing, as in CSS. */
function selectorSpecificity(selector: string): Specificity {
  const withoutWhere = selector.replace(/:where\([^)]*\)/g, "");
  const identifiers = (withoutWhere.match(/#[\w-]+/g) ?? []).length;
  const classes = (withoutWhere.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const elements = (withoutWhere.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length + (withoutWhere.match(/::[\w-]+/g) ?? []).length;
  return { identifiers, classes, elements };
}

function compareSpecificity(first: Specificity, second: Specificity): number {
  return first.identifiers - second.identifiers || first.classes - second.classes || first.elements - second.elements;
}

function assertContrast(options: Readonly<{ text: OpaqueColour; background: OpaqueColour; minimum: number; label: string }>): void {
  const ratio = contrastRatio({ first: options.text, second: options.background });
  assert.ok(ratio >= options.minimum, `${options.label}: ${ratio.toFixed(2)}:1, needs ${options.minimum}:1`);
}

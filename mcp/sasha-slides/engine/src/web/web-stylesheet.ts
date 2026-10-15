// THE WEB APPLICATION'S OWN RULES (the deck list, the share and import dialogs, the "Opening deck"
// card, the export notices), appended after the shared Tidepool stylesheet and the view's rules.
// Like every engine stylesheet they read `--sasha-*` custom properties only (SPEC.md 21.11);
// web-stylesheet.test.ts forbids colour literals here, as the theme's own test does for its rules.
//
// Key decisions:
//
//  * CLASS NAMES ARE CONSTANTS (`WEB_CLASS`), as in the theme, so a component never spells one.
//  * THE LIST PAGE IS A HOME SCREEN: lively shapes behind, `.sasha-lively-card` glass in front
//    (the only blurred glass, per the theme). The deck page keeps the calm wash.
//  * DIALOGS LIVE IN A LAYER OF THEIR OWN at the page root, never inside the editor's top bar: a
//    panel is a stacking context, and a dialog rendered inside one would sit under the toolbar.

import { TIDEPOOL_CLASS } from "../theme/tidepool-stylesheet.ts";

export const WEB_CLASS = {
  listPage: "sasha-web-list-page",
  header: "sasha-web-header",
  brand: "sasha-web-brand",
  logo: "sasha-web-logo",
  account: "sasha-web-account",
  main: "sasha-web-main",
  pageTitle: "sasha-web-page-title",
  actions: "sasha-web-actions",
  deckGrid: "sasha-web-deck-grid",
  deckCard: "sasha-web-deck-card",
  deckTitle: "sasha-web-deck-title",
  deckFacts: "sasha-web-deck-facts",
  cardActions: "sasha-web-card-actions",
  emptyCard: "sasha-web-empty-card",
  dialogLayer: "sasha-web-dialog-layer",
  dialogTitle: "sasha-web-dialog-title",
  form: "sasha-web-form",
  formRow: "sasha-web-form-row",
  people: "sasha-web-people",
  person: "sasha-web-person",
  personName: "sasha-web-person-name",
  personControls: "sasha-web-person-controls",
  sectionTitle: "sasha-web-section-title",
  problem: "sasha-web-problem",
  deckPage: "sasha-web-deck-page",
  opening: "sasha-web-opening",
  openingCard: "sasha-web-opening-card",
  toastLayer: "sasha-web-toast-layer",
  topBarAccessory: "sasha-web-top-bar-accessory",
} as const;

export function webStylesheet(): string {
  const classes = WEB_CLASS;
  const tidepool = TIDEPOOL_CLASS;
  return `
.${classes.listPage} { min-block-size: 100vh; display: flex; flex-direction: column; }
.${classes.header} { position: sticky; inset-block-start: 0; z-index: var(--sasha-layer-chrome); display: flex; align-items: center; justify-content: space-between; gap: var(--sasha-space-medium); margin: var(--sasha-space-medium); padding: var(--sasha-space-small) var(--sasha-space-large); }
.${tidepool.root} .${classes.brand} { display: inline-flex; align-items: center; gap: var(--sasha-space-small); font-weight: var(--sasha-font-weight-bold); font-size: var(--sasha-font-size-title); color: var(--sasha-text); text-decoration: none; }
.${classes.logo} { display: inline-flex; inline-size: 32px; block-size: 32px; }
.${classes.logo} svg { inline-size: 100%; block-size: 100%; }
.${classes.account} { display: inline-flex; align-items: center; gap: var(--sasha-space-medium); font-size: var(--sasha-font-size-small); }
.${classes.main} { flex: 1; inline-size: min(1120px, 100% - 2 * var(--sasha-space-large)); margin-inline: auto; padding-block: var(--sasha-space-large) var(--sasha-space-extra-large); }
.${classes.pageTitle} { margin: 0; font-size: var(--sasha-font-size-heading); font-weight: var(--sasha-font-weight-bold); }
.${classes.actions} { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sasha-space-medium); margin-block-end: var(--sasha-space-large); }
.${classes.actions} > div { display: flex; flex-wrap: wrap; gap: var(--sasha-space-small); }
.${classes.deckGrid} { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--sasha-space-large); }
.${classes.deckCard} { display: flex; flex-direction: column; gap: var(--sasha-space-small); min-block-size: 150px; cursor: pointer; }
.${classes.deckTitle} { margin: 0; font-size: var(--sasha-font-size-title); font-weight: var(--sasha-font-weight-bold); overflow-wrap: anywhere; }
.${classes.deckFacts} { margin: 0; display: grid; gap: var(--sasha-space-extra-small); }
.${classes.cardActions} { margin-block-start: auto; display: flex; gap: var(--sasha-space-small); }
.${classes.emptyCard} { display: grid; gap: var(--sasha-space-medium); justify-items: start; max-inline-size: 520px; }
.${classes.dialogLayer} { position: fixed; inset: 0; z-index: var(--sasha-layer-dialog); display: grid; place-items: center; padding: var(--sasha-space-medium); }
.${classes.dialogLayer} > .${tidepool.dialog} { position: relative; inline-size: min(560px, 100%); max-block-size: calc(100vh - 2 * var(--sasha-space-large)); overflow: auto; display: grid; gap: var(--sasha-space-medium); }
.${classes.dialogTitle} { margin: 0; font-size: var(--sasha-font-size-title); font-weight: var(--sasha-font-weight-bold); }
.${classes.form} { display: grid; gap: var(--sasha-space-small); }
.${classes.formRow} { display: flex; flex-wrap: wrap; gap: var(--sasha-space-small); align-items: center; }
.${classes.formRow} > .${tidepool.field} { flex: 1 1 200px; }
.${classes.people} { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--sasha-space-extra-small); }
.${classes.person} { display: flex; align-items: center; justify-content: space-between; gap: var(--sasha-space-small); min-block-size: var(--sasha-control-height); padding: 0 var(--sasha-space-small); border-radius: var(--sasha-radius-control); background: var(--sasha-card-glass); }
.${classes.personName} { display: grid; }
.${classes.personControls} { flex: none; display: inline-flex; align-items: center; gap: var(--sasha-space-small); }
fieldset.${classes.form} { margin: 0; padding: 0; border: 0; min-inline-size: 0; }
.${classes.sectionTitle} { margin: 0; font-size: var(--sasha-font-size-small); font-weight: var(--sasha-font-weight-semibold); color: var(--sasha-text-muted); }
.${classes.problem} { margin: 0; color: var(--sasha-danger); }
.${classes.deckPage} { position: relative; block-size: 100vh; overflow: hidden; }
.${classes.opening} { position: relative; block-size: 100vh; display: grid; place-items: center; }
.${classes.openingCard} { position: relative; z-index: var(--sasha-layer-chrome); display: grid; gap: var(--sasha-space-small); justify-items: center; min-inline-size: 260px; text-align: center; }
.${classes.toastLayer} { position: fixed; inset-inline: 0; inset-block-end: var(--sasha-space-large); z-index: var(--sasha-layer-notice); display: grid; justify-items: center; gap: var(--sasha-space-small); pointer-events: none; }
.${classes.toastLayer} > * { pointer-events: auto; max-inline-size: min(560px, 100% - 2 * var(--sasha-space-medium)); display: flex; gap: var(--sasha-space-medium); align-items: center; }
.${classes.topBarAccessory} { display: inline-flex; align-items: center; gap: var(--sasha-space-small); }
`;
}

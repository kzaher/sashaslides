// THE ACCOUNT LINK IS A SECONDARY PILL (SPEC.md 21.8): on the /decks header and in the editor's top
// bar it sits beside Share, New deck and Comments, so it wears the same Tidepool pill rather than the
// browser's underlined link. The theme's own test proves the pill wins over the root's link rule.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { createDeckApiClient, sessionCredentials } from "../api/deck-api-client.ts";
import { TopBarAccessory } from "../deck-page/deck-host.tsx";
import { DeckListPage, type DeckListActions } from "../deck-list/deck-list-page.tsx";
import { INITIAL_DECK_LIST_STATE } from "../deck-list/deck-list-state.ts";
import { TEST_DECK_ID } from "../testing/collaboration-harness.ts";

const ignore = (): void => undefined;
const ACTIONS: DeckListActions = {
  openDeck: ignore,
  newDeck: ignore,
  openImport: ignore,
  changeImportAddress: ignore,
  submitImport: ignore,
  connectGoogle: ignore,
  share: ignore,
  askDelete: ignore,
  confirmDelete: ignore,
  closeDialog: ignore,
};

const deck = createDeckApiClient({
  origin: "https://sashaslides.test",
  credentials: sessionCredentials("cookie"),
  fetch: () => Promise.reject(new Error("rendering the Account link sends no request")),
}).deck(TEST_DECK_ID);

describe("the Account link is a secondary pill", () => {
  const rows = [
    { name: "on the /decks header", markup: () => renderToStaticMarkup(createElement(DeckListPage, { state: INITIAL_DECK_LIST_STATE, now: 0, actions: ACTIONS, renderShareDialog: () => null })) },
    { name: "in the editor's top bar, beside Share", markup: () => renderToStaticMarkup(createElement(TopBarAccessory, { deck, showAccount: true, portalTarget: () => { throw new Error("no dialog opens while rendering"); } })) },
  ] as const;
  for (const row of rows) {
    it(row.name, () => {
      const markup = row.markup();
      const link = /<a[^>]*href="\/account"[^>]*>Account<\/a>/.exec(markup)?.[0] ?? "";
      assert.ok(link !== "", "the page links to /account");
      assert.match(link, new RegExp(`class="${TIDEPOOL_CLASS.secondaryPill}"`), link);
    });
  }

  it("control: in the add-on the editor's top bar has no Account link", () => {
    const markup = renderToStaticMarkup(createElement(TopBarAccessory, { deck, showAccount: false, portalTarget: () => { throw new Error("no dialog opens while rendering"); } }));
    assert.doesNotMatch(markup, /Account/);
  });
});

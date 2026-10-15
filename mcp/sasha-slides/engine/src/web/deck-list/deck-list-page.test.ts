// THE DECK LIST AND THE WEB STYLESHEET (acceptance 9): the page carries the REAL logo and the lively
// shapes, one card per deck with its role, Share and Delete only on the decks one owns, and the
// empty state; the web module's stylesheet holds no colour literal, the same check the theme makes
// for its own rules.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DECK_ROLES, type DeckRole } from "../../contracts/deck-access.ts";
import type { DeckSummary } from "../../contracts/deck-api.ts";
import { parseDeckId } from "../../contracts/ids.ts";
import { tidepoolCustomProperties, TIDEPOOL_TOKENS } from "../../theme/tidepool-theme.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { SASHA_LOGO_MARKUP, editedAgo } from "../shared/web-chrome.tsx";
import { PEER_PERSON, TEST_PERSON } from "../testing/collaboration-harness.ts";
import { webStylesheet } from "../web-stylesheet.ts";
import { DeckListPage, type DeckListActions } from "./deck-list-page.tsx";
import { INITIAL_DECK_LIST_STATE, reduceDeckList, type DeckListState } from "./deck-list-state.ts";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

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

function deck(options: Readonly<{ suffix: string; role: DeckRole; title: string; minutesAgo: number }>): DeckSummary {
  const deckId = parseDeckId(`dk_ListTest${options.suffix}000000000000`);
  if (deckId === null) throw new Error("bad deck id");
  return {
    deckId,
    title: options.title,
    role: options.role,
    owner: options.role === "owner" ? TEST_PERSON : PEER_PERSON,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - options.minutesAgo * 60_000,
    googleSlides: null,
  };
}

function render(state: DeckListState): string {
  return renderToStaticMarkup(createElement(DeckListPage, { state, now: NOW, actions: ACTIONS, renderShareDialog: () => null }));
}

function loaded(decks: readonly DeckSummary[]): DeckListState {
  const withSession = reduceDeckList(INITIAL_DECK_LIST_STATE, {
    kind: "sessionLoaded",
    session: { me: TEST_PERSON, email: "ada@example.com", csrfToken: "c", expiresAt: NOW + 1, authentication: "cookie" },
  });
  return reduceDeckList(withSession, { kind: "decksLoaded", decks });
}

describe("9. the deck list", () => {
  const decks = DECK_ROLES.map((role, index) => deck({ suffix: String(index), role, title: `${role} deck`, minutesAgo: index * 3 }));

  it("carries the real Sasha Slides logo, the lively shapes, and the account", () => {
    const markup = render(loaded(decks));
    assert.ok(SASHA_LOGO_MARKUP.startsWith("<svg") && SASHA_LOGO_MARKUP.length > 1000, "the generated logo, not a placeholder");
    assert.ok(markup.includes(SASHA_LOGO_MARKUP), "the logo markup is on the page");
    assert.ok(markup.includes(`class="${TIDEPOOL_CLASS.livelyGround}"`), "LivelyShapes");
    assert.ok(markup.includes("ada@example.com"));
    assert.ok(markup.includes('href="/account"'));
  });

  it("renders one lively card per deck with its role, and Share and Delete only on the owner's", () => {
    const markup = render(loaded(decks));
    const cards = [...markup.matchAll(/<article class="sasha-lively-card sasha-web-deck-card"[^>]*data-role="([a-z]+)"[^>]*>([\s\S]*?)<\/article>/g)];
    assert.equal(cards.length, decks.length);
    const rows = cards.map((card) => ({ role: card[1], hasShare: (card[2] ?? "").includes(">Share<"), hasDelete: (card[2] ?? "").includes(">Delete<") }));
    assert.deepEqual(rows, [
      { role: "owner", hasShare: true, hasDelete: true },
      { role: "editor", hasShare: false, hasDelete: false },
      { role: "commenter", hasShare: false, hasDelete: false },
      { role: "viewer", hasShare: false, hasDelete: false },
    ]);
    for (const label of ["Owner", "Editor", "Commenter", "Viewer"]) assert.ok(markup.includes(`>${label}<`), label);
    assert.ok(markup.includes("edited just now"));
    assert.ok(markup.includes("edited 3 minutes ago"));
    assert.ok(markup.includes(">New deck<") && markup.includes(">Import from Google Slides<"));
  });

  it("shows one 'Make your first deck' card when there are no decks (control: none when there are)", () => {
    for (const row of [{ decks: [], empty: true, cards: 0 }, { decks, empty: false, cards: 4 }]) {
      const markup = render(loaded(row.decks));
      assert.equal(markup.includes("Make your first deck"), row.empty, `empty state with ${row.decks.length} decks`);
      assert.equal([...markup.matchAll(/sasha-web-deck-card/g)].length, row.cards);
    }
  });

  it("the import dialog offers 'Connect Google Slides' when Google is not connected", () => {
    let state = reduceDeckList(loaded(decks), { kind: "importOpened" });
    state = reduceDeckList(state, { kind: "importNeedsGoogle", connectAddress: "/deck-api/google-slides/connect?return=/decks", message: "Connect Google Slides first." });
    const markup = render(state);
    assert.ok(markup.includes(">Connect Google Slides<"));
    assert.ok(markup.includes("Connect Google Slides first."));
  });

  it("says when a deck was edited", () => {
    const rows = [
      { minutes: 0, text: "edited just now" },
      { minutes: 1, text: "edited 1 minute ago" },
      { minutes: 59, text: "edited 59 minutes ago" },
      { minutes: 60, text: "edited 1 hour ago" },
      { minutes: 60 * 48, text: "edited 2 days ago" },
    ];
    for (const row of rows) assert.equal(editedAgo({ now: NOW, updatedAt: NOW - row.minutes * 60_000 }), row.text);
  });
});

describe("the web stylesheet", () => {
  it("contains no colour literal: every colour comes from a token", () => {
    const rules = webStylesheet();
    assert.equal(/#[0-9a-f]{3,8}\b/i.test(rules), false, "hexadecimal colour in the rules");
    assert.equal(/rgba?\(|hsla?\(/i.test(rules), false, "functional colour in the rules");
    assert.equal(/\b(white|black|red|blue|green|gray|grey|transparent)\b/i.test(rules), false, "named colour in the rules");
  });

  it("reads only custom properties the theme defines", () => {
    const defined = new Set(tidepoolCustomProperties({ tokens: TIDEPOOL_TOKENS, scheme: "light" }).map((property) => property.name));
    for (const match of webStylesheet().matchAll(/var\(--sasha-([a-z0-9-]+)\)/g)) assert.ok(defined.has(match[1] ?? ""), `--sasha-${match[1] ?? ""} is read but never defined`);
  });

  it("animates nothing outside prefers-reduced-motion", () => {
    assert.equal(/animation|transition/.test(webStylesheet()), false);
  });
});

// WHAT THE DECK PAGE ADDS TO THE EDITOR'S CHROME (editor-system.ts `EditorHost`): the logo's
// destination, the Share button and the account link in the top bar, and the File menu's items --
// "All decks", "Export to Google Slides", "Export to the linked presentation", and in the add-on
// "Open in a new tab". The view renders them; it never imports this module.
//
// Key decisions:
//
//  * A DISABLED ITEM SAYS WHY (`disabledReason`): a role without `exchangeWithGoogleSlides`, or a
//    deck with no linked presentation.
//  * INSIDE THE ADD-ON, LEAVING THE DECK OPENS A TAB. The dialog's frame has no cookie, so "All
//    decks" (which needs the web application's session) opens a top-level tab instead of
//    navigating the frame (SPEC.md section 14 item 4).
//  * THE SHARE DIALOG IS PORTALLED to the page root, outside the top bar panel's stacking context.

import { useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { assertNever } from "../../contracts/assert-never.ts";
import { roleAllows, type DeckRole } from "../../contracts/deck-access.ts";
import { DECK_LIST_PAGE_PATH, DECK_PAGE_PATH_PREFIX, type GoogleSlidesLink } from "../../contracts/deck-api.ts";
import type { EditorEmbedding } from "../../contracts/editor-state.ts";
import type { EditorHost, HostMenuItem } from "../../contracts/editor-system.ts";
import type { DeckId } from "../../contracts/ids.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import type { DeckClient } from "../api/deck-api-client.ts";
import { ShareDialogContainer } from "../share/share-dialog.tsx";
import { WEB_CLASS } from "../web-stylesheet.ts";
import type { ExportRunner, PageNotice } from "./deck-exports.ts";

export const HOST_MENU_ITEM_ID = {
  allDecks: "allDecks",
  exportToGoogleSlides: "exportToGoogleSlides",
  exportToLinkedPresentation: "exportToLinkedPresentation",
  openInNewTab: "openInNewTab",
} as const;

export function deckEditorHost(options: Readonly<{
  deckId: DeckId;
  origin: string;
  embedding: EditorEmbedding;
  role: DeckRole;
  googleSlides: GoogleSlidesLink | null;
  exports: ExportRunner;
  navigate: (address: string) => void;
  openTab: (address: string) => void;
  topBarAccessory: ReactNode;
}>): EditorHost {
  const inAddon = isAddonDialog(options.embedding);
  const mayExchange = roleAllows({ role: options.role, permission: "exchangeWithGoogleSlides" });
  const exchangeRefusal = mayExchange ? null : "Only the deck's editors can export it.";
  const allDecks: HostMenuItem = {
    id: HOST_MENU_ITEM_ID.allDecks,
    label: "All decks",
    disabledReason: null,
    run: () => (inAddon ? options.openTab(`${options.origin}${DECK_LIST_PAGE_PATH}`) : options.navigate(DECK_LIST_PAGE_PATH)),
  };
  const exportNew: HostMenuItem = {
    id: HOST_MENU_ITEM_ID.exportToGoogleSlides,
    label: "Export to Google Slides",
    disabledReason: exchangeRefusal,
    run: () => void options.exports.exportTo({ kind: "newPresentation" }),
  };
  const exportLinked: HostMenuItem = {
    id: HOST_MENU_ITEM_ID.exportToLinkedPresentation,
    label: "Export to the linked presentation",
    disabledReason: exchangeRefusal ?? (options.googleSlides === null ? "This deck is not linked to a Google Slides presentation yet." : null),
    run: () => void options.exports.exportTo({ kind: "linkedPresentation" }),
  };
  const openInNewTab: HostMenuItem = {
    id: HOST_MENU_ITEM_ID.openInNewTab,
    label: "Open in a new tab",
    disabledReason: null,
    run: () => options.openTab(`${options.origin}${DECK_PAGE_PATH_PREFIX}${options.deckId}`),
  };
  return {
    homeAddress: inAddon ? null : DECK_LIST_PAGE_PATH,
    topBarAccessory: options.topBarAccessory,
    fileMenuItems: inAddon ? [allDecks, exportNew, exportLinked, openInNewTab] : [allDecks, exportNew, exportLinked],
  };
}

/** Share for everyone (read-only below the owner), and the account link outside the add-on. */
export function TopBarAccessory(properties: Readonly<{ deck: DeckClient; showAccount: boolean; portalTarget: () => Element }>): ReactElement {
  const [sharing, setSharing] = useState(false);
  return (
    <span className={WEB_CLASS.topBarAccessory}>
      <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={() => setSharing(true)}>
        Share
      </button>
      {properties.showAccount ? (
        <a className={TIDEPOOL_CLASS.secondaryPill} href="/account">
          Account
        </a>
      ) : null}
      {sharing
        ? createPortal(
            <div className={TIDEPOOL_CLASS.root}>
              <ShareDialogContainer deck={properties.deck} onClose={() => setSharing(false)} />
            </div>,
            properties.portalTarget(),
          )
        : null}
    </span>
  );
}

/** The page's own notices (exports), bottom centre, each dismissible. */
export function PageNotices(properties: Readonly<{ notices: readonly (PageNotice & Readonly<{ id: number }>)[]; onDismiss: (id: number) => void }>): ReactElement {
  return (
    <div className={`${TIDEPOOL_CLASS.root} ${WEB_CLASS.toastLayer}`} aria-live="polite">
      {properties.notices.map((notice) => (
        <div key={notice.id} className={TIDEPOOL_CLASS.notice} data-tone={notice.tone} role={announcementRoleOf(notice.tone)}>
          <span>{notice.message}</span>
          {notice.link === null ? null : (
            <a href={notice.link.address} target="_blank" rel="noopener noreferrer">
              {notice.link.label}
            </a>
          )}
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={() => properties.onDismiss(notice.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}

/** Errors interrupt a screen reader; everything else waits its turn. */
function announcementRoleOf(tone: PageNotice["tone"]): "alert" | "status" {
  switch (tone) {
    case "error":
      return "alert";
    case "information":
    case "warning":
      return "status";
    default:
      return assertNever(tone);
  }
}

export function isAddonDialog(embedding: EditorEmbedding): boolean {
  switch (embedding.kind) {
    case "addonDialog":
      return true;
    case "webApplication":
      return false;
    default:
      return assertNever(embedding);
  }
}

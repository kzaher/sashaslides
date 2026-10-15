// SMALL PIECES BOTH PAGES SHARE: the real Sasha Slides logo, the dialog frame (scrim plus a
// Tidepool dialog in its own layer), and the words for roles and times.
//
// Key decisions:
//
//  * THE LOGO IS THE REAL ONE, generated from docs/brand into http/sasha-icon.generated.ts, never a
//    drawn placeholder. It is imported as a namespace so no identifier here carries the file's
//    format in its name (SPEC.md 21.9 item 7).
//  * A DIALOG CLOSES ON ESCAPE AND ON THE SCRIM, and its first field takes focus, as the editor's
//    own dialogs do.

import { useEffect, type ReactElement, type ReactNode } from "react";
import * as sashaIcon from "../../../../http/sasha-icon.generated.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import type { DeckRole } from "../../contracts/deck-access.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { WEB_CLASS } from "../web-stylesheet.ts";

/** The product logo, decorative (the name beside it is the label). */
export function SashaLogo(): ReactElement {
  return <span className={WEB_CLASS.logo} aria-hidden="true" dangerouslySetInnerHTML={{ __html: sashaIcon.SASHA_ICON_SVG }} />;
}

/** The logo's markup, for tests that check the page carries the real one. */
export const SASHA_LOGO_MARKUP: string = sashaIcon.SASHA_ICON_SVG;

export function DialogFrame(properties: Readonly<{ title: string; onClose: () => void; children: ReactNode }>): ReactElement {
  const { onClose } = properties;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className={WEB_CLASS.dialogLayer}>
      <div className={TIDEPOOL_CLASS.scrim} onClick={onClose} />
      <section className={TIDEPOOL_CLASS.dialog} role="dialog" aria-modal="true" aria-label={properties.title}>
        <h2 className={WEB_CLASS.dialogTitle}>{properties.title}</h2>
        {properties.children}
      </section>
    </div>
  );
}

export function roleLabel(role: DeckRole): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "editor":
      return "Editor";
    case "commenter":
      return "Commenter";
    case "viewer":
      return "Viewer";
    default:
      return assertNever(role);
  }
}

/** "edited just now", "edited 3 minutes ago", "edited 2 hours ago", "edited 5 days ago", or the date. */
export function editedAgo(options: Readonly<{ now: number; updatedAt: number }>): string {
  const minutes = Math.floor(Math.max(0, options.now - options.updatedAt) / 60_000);
  if (minutes < 1) return "edited just now";
  if (minutes < 60) return `edited ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `edited ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `edited ${days} ${days === 1 ? "day" : "days"} ago`;
  return `edited ${new Date(options.updatedAt).toISOString().slice(0, 10)}`;
}

// THE EDITOR'S ICONS: one small stroked set drawn in `currentColor`, so an icon takes the ink, muted
// or accent colour of the control it sits in and both colour schemes come for free. Names are a
// closed union with a total lookup, so a missing drawing is a compile error, not a blank button.

import type { ReactElement } from "react";
import { VIEW_CLASS } from "../view-stylesheet.ts";

export type IconName =
  | "undo"
  | "redo"
  | "select"
  | "textBox"
  | "shape"
  | "line"
  | "image"
  | "table"
  | "paintFormat"
  | "comment"
  | "present"
  | "chevronDown"
  | "plus"
  | "close"
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "alignStart"
  | "alignCentre"
  | "alignEnd"
  | "alignJustify"
  | "bulletedList"
  | "numberedList"
  | "lock"
  | "unlock"
  | "flipHorizontal"
  | "flipVertical"
  | "rotate"
  | "skipped"
  | "transition"
  | "notes"
  | "panel"
  | "filmstrip"
  | "check"
  | "zoom"
  | "speaker";

export function Icon(properties: Readonly<{ name: IconName }>): ReactElement {
  return (
    <svg className={VIEW_CLASS.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICON_DRAWINGS[properties.name]}
    </svg>
  );
}

const ICON_DRAWINGS: Readonly<Record<IconName, ReactElement>> = {
  undo: <path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  redo: <path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />,
  select: <path d="m5 3 14 8-6.5 1.5L9 19z" />,
  textBox: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  shape: (
    <>
      <circle cx="8" cy="8" r="4.5" />
      <rect x="10.5" y="10.5" width="9" height="9" rx="1.5" />
    </>
  ),
  line: <path d="M5 19 19 5" />,
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="m20 16-4.5-4.5L7 20" />
    </>
  ),
  table: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M3.5 15h17M10 4.5v15" />
    </>
  ),
  paintFormat: (
    <>
      <rect x="4" y="3.5" width="13" height="6" rx="1.5" />
      <path d="M17 6.5h2.5V12H11v3" />
      <rect x="9.5" y="15" width="3" height="5.5" rx="1" />
    </>
  ),
  comment: <path d="M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.4A7.5 7.5 0 1 1 20 12z" />,
  present: <path d="M8 5.5v13l11-6.5z" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  bold: <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />,
  italic: <path d="M10 5h8M6 19h8M14 5l-4 14" />,
  underline: <path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14" />,
  strikethrough: <path d="M16.5 7A4 3.5 0 0 0 12 5c-2.5 0-4 1.3-4 3s1.5 2.5 4 3M4 12h16M8 16.5c.6 1.6 2 2.5 4 2.5 2.5 0 4-1.3 4-3" />,
  alignStart: <path d="M4 6h16M4 10h10M4 14h16M4 18h10" />,
  alignCentre: <path d="M4 6h16M7 10h10M4 14h16M7 18h10" />,
  alignEnd: <path d="M4 6h16M10 10h10M4 14h16M10 18h10" />,
  alignJustify: <path d="M4 6h16M4 10h16M4 14h16M4 18h16" />,
  bulletedList: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  numberedList: <path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v5M4 14.5c0-1 2.5-1 2.5 0S4 16.5 4 18h2.5" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 7.5-2" />
    </>
  ),
  flipHorizontal: <path d="M12 3v18M9 7 4 17h5zM15 7l5 10h-5z" />,
  flipVertical: <path d="M3 12h18M7 9 17 4v5zM7 15l10 5v-5z" />,
  rotate: <path d="M20 11a8 8 0 1 1-2.3-5.7M20 4v5h-5" />,
  skipped: <path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 21 12a12 12 0 0 1-2.3 3.2M6.6 6.6A12 12 0 0 0 3 12s3.5 7 9 7a8.8 8.8 0 0 0 4.4-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2" />,
  transition: <path d="M4 7h11l-3-3M20 17H9l3 3" />,
  notes: <path d="M5 4h14v16H5zM8.5 8.5h7M8.5 12h7M8.5 15.5h4" />,
  panel: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M14.5 4.5v15" />
    </>
  ),
  filmstrip: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  zoom: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.4-4.4M8.5 11h5M11 8.5v5" />
    </>
  ),
  speaker: (
    <>
      <rect x="3.5" y="5" width="11" height="8" rx="1.5" />
      <rect x="9.5" y="11" width="11" height="8" rx="1.5" />
    </>
  ),
};

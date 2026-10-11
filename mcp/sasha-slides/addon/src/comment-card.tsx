// A GOOGLE-SHAPED COMMENT CARD, drawn by both surfaces.
//
// The product's two conversations -- the Ask Sasha log in the sidebar and the mark-ups in the
// slides window -- are comments on a slide, and the user reads them next to Google's own comment
// pane. They used to look like a log file: a 10 px uppercase label, a tinted strip, a one-line
// text input. This file is the shape read off a real Google Slides comment card: a round avatar
// with a single initial, the author's name in bold with the time under it, the body at the card's
// own left edge (NOT indented under the avatar), and a pill-shaped composer at the foot.
//
// It is PRESENTATION ONLY. Nothing here reads or writes the conversation's state, so both surfaces
// can use it without sharing a reducer -- which they deliberately do not (dialog.tsx). The one
// piece of local state is the three-dot menu's open/closed flag (`MoreMenu`): it is chrome, like a
// tooltip, and losing it to a re-render would cost nothing the user typed.
//
// THE THREAD CARD (2026-10-04, from the user's reference screenshot of Google's own pane). One white
// card per THREAD, not per post: the root comment with the blue resolve tick and a vertical
// three-dot menu at its top right, each reply nested inside the same card with its own avatar row
// and its own three-dot menu, the reply's words on a light grey strip, and a pill-shaped "Reply or
// add others with @" box at the foot of an open thread.

import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { assertNever } from "./protocol.ts";

/** Material's `check` icon, the path Google's own comment pane draws for "resolve". */
export const CHECK_ICON_PATH = "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z";

/** Material's `more_vert` icon: the vertical three dots. */
export const MORE_VERT_ICON_PATH =
  "M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z";

/** Google's own tooltip for the tick, word for word, so the control reads as the one it copies. */
export const RESOLVE_LABEL = "Mark as resolved and hide discussion";

/**
 * The letter in the avatar bubble.
 *
 * `[...name]` rather than `name[0]`: a name starting with an emoji or any other astral character
 * would otherwise be cut in half and render as a replacement glyph.
 */
export function avatarInitialOf(name: string): string {
  const first = [...name.trim()][0];
  return first === undefined ? "?" : first.toUpperCase();
}

/**
 * "12:08 AM Today", the way Google writes it.
 *
 * `timeZone` is injected rather than defaulted so the tests are not at the mercy of the machine
 * they run on; the surfaces pass nothing and get the viewer's own zone, which is the right one.
 * An unparseable or missing timestamp renders as NOTHING -- never "Invalid Date", which is what a
 * naive `toLocaleString` puts on screen when a Drive field is empty.
 */
export function describeCommentTime(
  options: Readonly<{ at: string; nowMs: number | null; timeZone?: string }>,
): string {
  const { at, nowMs, timeZone } = options;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return "";
  const zone = timeZone === undefined ? {} : { timeZone };
  const clock = new Date(atMs).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...zone });
  if (nowMs === null) return clock;
  const days = calendarDaysBetween({ fromMs: atMs, toMs: nowMs, ...zone });
  if (days === 0) return `${clock} Today`;
  if (days === 1) return `${clock} Yesterday`;
  const date = new Date(atMs).toLocaleDateString("en-US", { day: "numeric", month: "short", ...zone });
  return `${clock} ${date}`;
}

/**
 * Whole CALENDAR days apart, not elapsed hours.
 *
 * "Today" is a date, not a duration: 23:50 and 00:10 are eighty minutes apart and still different
 * days, and a subtraction of milliseconds gets that wrong in both directions.
 */
function calendarDaysBetween(options: Readonly<{ fromMs: number; toMs: number; timeZone?: string }>): number {
  const { fromMs, toMs } = options;
  const zone = options.timeZone === undefined ? {} : { timeZone: options.timeZone };
  const dayOf = (ms: number): number =>
    Date.parse(`${new Date(ms).toLocaleDateString("en-CA", { ...zone })}T00:00:00Z`);
  return Math.round((dayOf(toMs) - dayOf(fromMs)) / 86_400_000);
}

/**
 * The white card every comment sits in. `tone` only picks a tint or a layout; it carries no
 * behaviour. `thread` is one whole thread (root and replies), `event` is a line of the session log
 * drawn in the same language, and `resolved` dims a closed thread the way Google collapses one.
 */
export function CommentCard({
  tone,
  resolved,
  children,
}: {
  tone?: CardTone;
  resolved?: boolean;
  children: ReactNode;
}): JSX.Element {
  const closed = resolved === true ? " sasha-c-resolved" : "";
  return <div className={`sasha-c-card sasha-c-${tone ?? "plain"}${closed}`}>{children}</div>;
}

export type CardTone = "plain" | "agent" | "flagged" | "thread" | "event" | "opaque";

/**
 * Whose avatar it is, as a colour. Google gives every account its own; this product has exactly
 * four kinds of author, and the one that matters is that Sasha NEVER shares the user's colour --
 * the connector posts as the user's own Google account, so the name alone cannot be trusted.
 */
export type AvatarTone = "user" | "agent" | "deck" | "delivery" | "opaque";

/**
 * Avatar, name, time, and whatever the surface wants on the right (a resolve tick, a count).
 *
 * `where` is this product's one addition to Google's layout: a comment here is about a BOX on a
 * particular candidate, and which candidate is the first thing the reader needs.
 */
export function CommentHead({
  author,
  at,
  nowMs,
  where,
  actions,
  tone,
}: {
  author: string;
  /** Null for a comment that has not been posted yet -- the composer's own head shows no time. */
  at: string | null;
  nowMs: number | null;
  where?: string;
  actions?: ReactNode;
  tone?: AvatarTone;
}): JSX.Element {
  const when = at === null ? "" : describeCommentTime({ at, nowMs });
  return (
    <div className="sasha-c-head">
      <span className={avatarClassOf(tone ?? "user")} aria-hidden="true">
        {avatarInitialOf(author)}
      </span>
      <span className="sasha-c-who">
        <span className="sasha-c-name">{author}</span>
        <span className="sasha-c-when">
          {when}
          {where === undefined || where === "" ? null : <span className="sasha-c-where"> · {where}</span>}
        </span>
      </span>
      {actions === undefined ? null : <span className="sasha-c-actions">{actions}</span>}
    </div>
  );
}

/**
 * The comment's words. `pre-wrap`, because a multiline comment is written with newlines in it.
 * A REPLY's words sit on Google's light grey strip, which is what tells a nested reply from the
 * root at a glance.
 */
export function CommentBody({ text, reply }: { text: string; reply?: boolean }): JSX.Element {
  return <p className={reply === true ? "sasha-c-body sasha-c-body-reply" : "sasha-c-body"}>{text}</p>;
}

/** The blue tick at the root's top right. An icon button, never the text glyph. */
export function ResolveButton({ disabled, onResolve }: { disabled: boolean; onResolve: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="sasha-c-icon sasha-c-resolve"
      disabled={disabled}
      title={RESOLVE_LABEL}
      aria-label={RESOLVE_LABEL}
      onClick={onResolve}
    >
      <MaterialIcon path={CHECK_ICON_PATH} />
    </button>
  );
}

/** What a closed thread shows where the tick was. */
export function ResolvedLabel(): JSX.Element {
  return <span className="sasha-c-resolved-label">Resolved</span>;
}

/**
 * ONE ENTRY IN THE THREE-DOT MENU. Only REAL actions exist as variants: a menu item that does
 * nothing is a lie told in a popover, so there is no "Edit" or "Link to this comment" here until
 * there is something behind it.
 */
export type MenuItem =
  | Readonly<{ kind: "copy"; text: string }>
  | Readonly<{ kind: "resolve"; onResolve: () => void }>;

/**
 * THE VERTICAL THREE DOTS, and the small menu they open.
 *
 * Absolutely positioned under the button, closed by an outside press or Escape -- the behaviour
 * of Google's own. "Copy text" goes through `navigator.clipboard`, which an HtmlService iframe may
 * refuse (it is a permissions-policy feature the host decides); a refusal is a VISIBLE line telling
 * the user to select the words by hand, never a click that silently did nothing.
 */
export function MoreMenu({ items }: { items: readonly MenuItem[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<CopyNotice>({ kind: "none" });
  const container = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent): void => {
      const box = container.current;
      if (box !== null && event.target instanceof Node && box.contains(event.target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const choose = (item: MenuItem): void => {
    switch (item.kind) {
      case "copy":
        void copyText(item.text).then((copied) => {
          setNotice(copied);
          // Closed on success only: a refusal keeps the menu open so its explanation stays on screen.
          if (copied.kind === "copied") setOpen(false);
        });
        return;
      case "resolve":
        setOpen(false);
        item.onResolve();
        return;
      default:
        assertNever(item);
    }
  };

  return (
    <span className="sasha-c-more" ref={container}>
      <button
        type="button"
        className="sasha-c-icon sasha-c-more-button"
        title="More options"
        aria-label="More options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setNotice({ kind: "none" });
          setOpen(!open);
        }}
      >
        <MaterialIcon path={MORE_VERT_ICON_PATH} />
      </button>
      {open ? (
        <span className="sasha-c-menu" role="menu">
          {items.map((item) => (
            <button
              type="button"
              role="menuitem"
              className="sasha-c-menu-item"
              key={item.kind}
              onClick={() => choose(item)}
            >
              {menuLabelOf(item)}
            </button>
          ))}
          <CopyNoticeLine notice={notice} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * THE PILL AT THE FOOT OF AN OPEN THREAD. Enter posts, Shift+Enter is a newline -- Google's own
 * keys -- and the Reply button only appears once there is something to post, as in Google's pane.
 */
export function ReplyPill({
  value,
  disabled,
  onType,
  onSubmit,
}: {
  value: string;
  disabled: boolean;
  onType: (text: string) => void;
  onSubmit: () => void;
}): JSX.Element {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const intent = replyKeyIntent({
      key: event.key,
      shiftKey: event.shiftKey,
      composing: event.nativeEvent.isComposing,
    });
    switch (intent) {
      case "type":
        return;
      case "send":
        event.preventDefault();
        if (value.trim() !== "" && !disabled) onSubmit();
        return;
      default:
        assertNever(intent);
    }
  };
  return (
    <div className="sasha-c-pill-row">
      <textarea
        className="sasha-c-pill"
        rows={1}
        disabled={disabled}
        placeholder="Reply or add others with @"
        aria-label="Reply"
        value={value}
        onChange={(event) => onType(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {value.trim() === "" ? null : (
        <button type="button" className="sasha-c-reply-send" disabled={disabled} onClick={onSubmit}>
          Reply
        </button>
      )}
    </div>
  );
}

/**
 * What a key in the reply pill means. Pure, so the rule is tested without a browser.
 *
 * An Enter that ends an IME COMPOSITION is the user accepting a candidate word, not sending --
 * posting there would cut a Japanese or Chinese reply off mid-word.
 */
export function replyKeyIntent(
  options: Readonly<{ key: string; shiftKey: boolean; composing: boolean }>,
): "send" | "type" {
  const { key, shiftKey, composing } = options;
  if (key !== "Enter" || shiftKey || composing) return "type";
  return "send";
}

/** An avatar's classes. Exhaustive, so a new kind of author has to be given a colour. */
function avatarClassOf(tone: AvatarTone): string {
  switch (tone) {
    case "user":
      return "sasha-c-avatar";
    case "agent":
      return "sasha-c-avatar sasha-c-avatar-agent";
    case "deck":
      return "sasha-c-avatar sasha-c-avatar-deck";
    case "delivery":
      return "sasha-c-avatar sasha-c-avatar-delivery";
    case "opaque":
      return "sasha-c-avatar sasha-c-avatar-opaque";
    default:
      return assertNever(tone);
  }
}

/** A 24-unit Material icon, drawn at the button's font size in its text colour. */
function MaterialIcon({ path }: { path: string }): JSX.Element {
  return (
    <svg className="sasha-c-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={path} fill="currentColor" />
    </svg>
  );
}

function menuLabelOf(item: MenuItem): string {
  switch (item.kind) {
    case "copy":
      return "Copy text";
    case "resolve":
      return "Resolve";
    default:
      return assertNever(item);
  }
}

type CopyNotice =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "copied" }>
  | Readonly<{ kind: "refused"; reason: string }>;

/**
 * The clipboard, or why not. `navigator.clipboard` is undefined outside a secure context and its
 * `writeText` rejects when the frame was not granted `clipboard-write` -- both are answers the
 * user has to see, so neither throws past this function.
 */
async function copyText(text: string): Promise<CopyNotice> {
  // `navigator.clipboard` is typed as always present, but it is undefined in an insecure context;
  // reading it through an optional shape keeps that real absence visible to the compiler.
  const clipboard: Readonly<{ writeText?: (text: string) => Promise<void> }> | undefined = navigator.clipboard;
  if (clipboard?.writeText === undefined) {
    return { kind: "refused", reason: "this window has no clipboard access" };
  }
  try {
    await clipboard.writeText(text);
    return { kind: "copied" };
  } catch (cause) {
    return { kind: "refused", reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

function CopyNoticeLine({ notice }: { notice: CopyNotice }): JSX.Element | null {
  switch (notice.kind) {
    case "none":
    case "copied":
      return null;
    case "refused":
      return (
        <span className="sasha-c-menu-note sasha-trouble" role="status">
          Could not copy ({notice.reason}). Select the words in the card and copy them by hand.
        </span>
      );
    default:
      return assertNever(notice);
  }
}

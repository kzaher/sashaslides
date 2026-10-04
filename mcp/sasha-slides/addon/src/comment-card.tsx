// A GOOGLE-SHAPED COMMENT CARD, drawn by both surfaces.
//
// The product's two conversations -- the Ask Sasha log in the sidebar and the mark-ups in the
// slides window -- are comments on a slide, and the user reads them next to Google's own comment
// pane. They used to look like a log file: a 10 px uppercase label, a tinted strip, a one-line
// text input. This file is the shape read off a real Google Slides comment card: a round avatar
// with a single initial, the author's name in bold with the time under it, the body at the card's
// own left edge (NOT indented under the avatar), and a pill-shaped composer at the foot.
//
// It is PRESENTATION ONLY. Nothing here reads or writes state, so both surfaces can use it without
// sharing a reducer -- which they deliberately do not (dialog.tsx).

import type { JSX, ReactNode } from "react";

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

/** The white card every comment sits in. `tone` only picks a tint; it carries no behaviour. */
export function CommentCard({
  tone,
  children,
}: {
  tone?: "plain" | "agent" | "flagged";
  children: ReactNode;
}): JSX.Element {
  return <div className={`sasha-c-card sasha-c-${tone ?? "plain"}`}>{children}</div>;
}

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
}: {
  author: string;
  at: string;
  nowMs: number | null;
  where?: string;
  actions?: ReactNode;
}): JSX.Element {
  const when = describeCommentTime({ at, nowMs });
  return (
    <div className="sasha-c-head">
      <span className="sasha-c-avatar" aria-hidden="true">
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

/** The comment's words. `pre-wrap`, because a multiline comment is written with newlines in it. */
export function CommentBody({ text }: { text: string }): JSX.Element {
  return <p className="sasha-c-body">{text}</p>;
}

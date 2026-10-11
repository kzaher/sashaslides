// KEEPING THE LOG ON THE NEWEST ENTRY, which is what a conversation does.
//
// `.sasha-msgs` is a bounded scroll box and nothing ever set its scroll position, so Ask Sasha
// opened on the OLDEST entry and every answer Sasha wrote appeared below the fold. The user
// reported it as "the chat should immediately slide to the final comment when they load".
//
// The rule is the one every chat uses, and the second half of it is the half that is easy to
// forget: stick to the bottom ONLY while the reader is already there. A log that jumps to the
// newest line while somebody is reading history is worse than one that never moves.

/**
 * How far from the bottom still counts as "at the bottom", in pixels.
 *
 * Not zero: a fractional device-pixel ratio leaves `scrollTop + clientHeight` a hair short of
 * `scrollHeight` even when the box is scrolled all the way down, and a zero threshold would
 * read that as "the reader scrolled up" and then never follow the conversation again.
 */
export const BOTTOM_SLACK_PX = 48;

/**
 * Whether the next render should scroll this box to the bottom.
 *
 * Pure, so the rule can be tested without a browser: the caller passes the box's own numbers.
 */
export function shouldStickToBottom(
  box: Readonly<{ scrollTop: number; scrollHeight: number; clientHeight: number }>,
): boolean {
  const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
  return distanceFromBottom <= BOTTOM_SLACK_PX;
}

// WHAT THE SIDE PANEL SHOWS, AND IN WHAT ORDER.
//
// Modelled on the comment pane of a document editor, because that is what people already know:
// the panel lists COMMENTS, open ones by default, and a filter switches to the ones that have
// been dealt with. It replaces a yellow "3 things waiting for Sasha" summary that restated the
// comments in prose above them -- the same information twice, and the prose version first.
//
// TWO AXES, AND THEY ARE NOT THE SAME QUESTION:
//
//   DONE      the user marked the thread resolved. Only the user may do this. Sasha answering
//             is not the user agreeing, so an answer never closes a thread.
//   ADDRESSED Sasha has replied to it. That is a fact about the thread, not a decision, and it
//             is what tells the user which of their open comments are worth re-reading.
//
// Which is why the open list is SPLIT rather than sorted: "addressed" means there is something
// new to look at, so it leads; "not addressed" is still waiting and needs nothing from the user
// yet. Sorting them into one list by time would bury the ones that moved.

/**
 * The least this module needs to know about a thread. STRUCTURAL rather than an import of
 * `ConversationThread`: the panel sorts and groups, and nothing it does should depend on the
 * rest of that record. It also lets the slides window's own rail use the same grouping.
 */
export type PanelThreadShape = Readonly<{
  commentId: string;
  at: string;
  resolved: boolean;
  replies: readonly Readonly<{ voice: "user" | "sasha" }>[];
}>;

/** What the filter is set to. `open` is the default, the way a document's pane opens. */
export type CommentFilter = "open" | "done" | "all";

export const COMMENT_FILTERS: readonly CommentFilter[] = ["open", "done", "all"];

export const COMMENT_FILTER_LABEL: Readonly<Record<CommentFilter, string>> = {
  open: "Not done",
  done: "Marked as done",
  all: "All",
};

/** One thread, with the slide it is on (null for a message about the deck itself). */
export type PanelThread<TThread extends PanelThreadShape = PanelThreadShape> = Readonly<{
  slideIndex: number | null;
  thread: TThread;
}>;

export type CommentSection<TThread extends PanelThreadShape = PanelThreadShape> = Readonly<{
  /** Stable key and heading. `done` only ever appears under the `done` and `all` filters. */
  kind: "addressed" | "not-addressed" | "done";
  title: string;
  /** Why this section exists, for the reader. Empty sections are not rendered at all. */
  threads: readonly PanelThread<TThread>[];
}>;

const SECTION_TITLE: Readonly<Record<CommentSection["kind"], string>> = {
  addressed: "Addressed",
  "not-addressed": "Not addressed",
  done: "Marked as done",
};

/**
 * Whether Sasha has replied to this thread.
 *
 * ANY agent reply counts, not the newest one: a thread the user replied to again after Sasha
 * answered has still been addressed, and burying it under "not addressed" would hide the answer
 * the user is responding to.
 */
export function isAddressed(thread: PanelThreadShape): boolean {
  return thread.replies.some((reply) => reply.voice === "sasha");
}

/**
 * The panel's sections for one filter, newest thread first within each.
 *
 * Empty sections are dropped rather than rendered with a "nothing here": three headings over two
 * comments is a table of contents for a page that does not need one.
 */
export function commentSections<TThread extends PanelThreadShape>(
  options: Readonly<{ threads: readonly PanelThread<TThread>[]; filter: CommentFilter }>,
): readonly CommentSection<TThread>[] {
  const { threads, filter } = options;
  const open = threads.filter((entry) => !entry.thread.resolved);
  const done = threads.filter((entry) => entry.thread.resolved);

  const sections: CommentSection<TThread>[] = [];
  if (filter === "open" || filter === "all") {
    sections.push(section("addressed", open.filter((entry) => isAddressed(entry.thread))));
    sections.push(section("not-addressed", open.filter((entry) => !isAddressed(entry.thread))));
  }
  if (filter === "done" || filter === "all") {
    sections.push(section("done", done));
  }
  return sections.filter((entry) => entry.threads.length > 0);
}

function section<TThread extends PanelThreadShape>(
  kind: CommentSection["kind"],
  threads: readonly PanelThread<TThread>[],
): CommentSection<TThread> {
  return { kind, title: SECTION_TITLE[kind], threads: [...threads].sort(newestFirst) };
}

/**
 * Newest first, by the thread's own timestamp. An unparseable date sorts last rather than
 * throwing the whole order out: Drive has returned one, and a panel that reordered itself
 * randomly around it would be worse than one stale row at the bottom.
 */
function newestFirst(left: PanelThread, right: PanelThread): number {
  const at = (entry: PanelThread): number => {
    const parsed = Date.parse(entry.thread.at);
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  };
  return at(right) - at(left);
}

/**
 * How many threads each filter would show, for the filter control itself.
 *
 * A count on the control is what makes it worth having: "Not done 3" tells the user there is
 * something to do without their having to switch to find out.
 */
export function commentCounts(
  threads: readonly PanelThread[],
): Readonly<Record<CommentFilter, number>> {
  const open = threads.filter((entry) => !entry.thread.resolved).length;
  return { open, done: threads.length - open, all: threads.length };
}

/** The empty state for one filter, which is never the same sentence. */
export function describeNoComments(filter: CommentFilter): string {
  switch (filter) {
    case "open":
      return "No open comments. Mark up a candidate and what you say lands here.";
    case "done":
      return "Nothing marked as done yet.";
    case "all":
      return "No comments on these candidates yet.";
    default:
      return "No comments.";
  }
}

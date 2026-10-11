/**
 * THE ONE FACT BOTH SURFACES HAVE TO AGREE ON: how long a comment may sit undelivered before the
 * interface stops counting up and starts telling the user what to do.
 *
 * WHY THIS FILE EXISTS AT ALL. The bug it closes was two halves, each self-consistent, that did
 * not meet: the server knew nothing was attached and said nothing, and the add-on could not know,
 * so it showed a spinner and a count-up under an accurate disclaimer. A real user watched that for
 * 1 h 47 minutes with no Sasha on the other end. The fix needs ONE number read by both, not two
 * fives that can drift apart in a later edit -- so the number, and the words that depend on it,
 * live here and nowhere else.
 *
 * IT IS IMPORTED BY BOTH PROJECTS, so it may depend on nothing. The server checks it under
 * `tsc -p mcp/sasha-slides` (Node, @types/node) and the add-on under
 * `tsc -p mcp/sasha-slides/addon/tsconfig.json` (browser, no Node types at all, and esbuild bundles
 * it into Sidebar.html). Pure values and pure string builders only: a single import of anything
 * platform-shaped would break one of the two gates.
 *
 * PROTOCOL.md, "`feedback-delivered`: proof that something is listening", is the contract this
 * implements. Changing the number or the wording means changing it there first.
 */

/**
 * HOW LONG A COMMENT MAY SIT WITH NO `feedback-delivered` RECEIPT before the interface says nobody
 * is listening -- and, read from the other side, the server's default `await_feedback` poll.
 *
 * It is ONE constant because it is one fact measured against real client behaviour: a long poll
 * survives 30 minutes idle over standard input and 5 minutes over the web transport, so a connected
 * Sasha reads a comment well inside one poll of this length. Past it, the overwhelmingly likely
 * cause is that nothing is attached. Lower it and a working session gets accused; raise it and the
 * user is back to watching a clock.
 */
export const FEEDBACK_DELIVERY_THRESHOLD_MS = 300_000;

/** The session-log `kind` a delivery receipt is written under. PROTOCOL.md's name. */
export const FEEDBACK_DELIVERED_EVENT_KIND = "feedback-delivered";

/**
 * The threshold in the words a person reads, DERIVED from the number rather than typed beside it --
 * which is the whole point of the constant. Whole minutes, because every value this threshold has
 * ever plausibly had is one.
 */
export const FEEDBACK_DELIVERY_THRESHOLD_LABEL = describeThresholdMinutes(FEEDBACK_DELIVERY_THRESHOLD_MS);

/**
 * WHAT TO PRINT WHEN NOTHING IS LISTENING: an instruction, not a diagnosis. Three strings rather
 * than one paragraph because two of them are meant to be COPIED VERBATIM, so the surface has to be
 * able to draw them as code and offer them for selection -- a sentence with a command buried in it
 * is not copyable.
 *
 * NO IDENTIFIER APPEARS IN IT. It used to name the `proposalId`, on the reasoning that a session
 * cannot act without one -- which was true until `open_work` existed. A user asked why an opaque
 * `p_1791145806407_yig6ws` was in a sentence written for a person, and they were right: an id a
 * human has to find and copy is homework, not an instruction. `open_work` takes no arguments and
 * answers from the account the connector is authenticated as, so the id is minted by the server,
 * passed machine to machine, and never typed.
 */
export function nothingListeningNotice(): NothingListeningNotice {
  return {
    headline:
      `Nothing has picked this up in ${FEEDBACK_DELIVERY_THRESHOLD_LABEL}. Sasha runs inside a ` +
      "Claude session -- start one and paste:",
    prompt: "Use the sasha-slides connector: call open_work, then answer my open comments.",
    connectHeadline: "If the connector is not attached yet:",
    connect: `claude mcp add sasha-slides -- npx tsx ${REPO_PLACEHOLDER}/mcp/sasha-slides/server.ts --stdio`,
  };
}

/** The four lines of the notice, kept apart so the two copyable ones can be drawn as code. */
export type NothingListeningNotice = Readonly<{
  headline: string;
  /** Copyable verbatim: what to paste into a fresh Claude session. */
  prompt: string;
  connectHeadline: string;
  /** Copyable verbatim: how to attach the connector in the first place. */
  connect: string;
}>;

/**
 * The add-on runs inside an HtmlService iframe and has no idea where the repository is checked out,
 * so the command carries a placeholder the user substitutes. A wrong absolute path would be worse
 * than an obvious blank.
 */
const REPO_PLACEHOLDER = "<repo>";

function describeThresholdMinutes(thresholdMs: number): string {
  const minutes = Math.round(thresholdMs / 60_000);
  return minutes === 1 ? "1 minute" : `${String(minutes)} minutes`;
}

/**
 * The comment feedback channel against REAL Google, end to end.
 *
 *   npx tsx mcp/sasha-slides/e2e/feedback-live.ts
 *   npx tsx mcp/sasha-slides/e2e/feedback-live.ts --deck <presentationId>
 *
 * What it proves, in order: a comment can be created, listed, replied to, resolved and
 * deleted; the Slides-native anchor really does name a slide; and every artefact it made is
 * gone again afterwards.
 *
 * Three rules it holds itself to, because this runs against a deck the user owns:
 *
 *  - **An independent client reads every write back.** A second `OAuth2Client` + a second
 *    `FeedbackChannel` is built from the same credentials, and the assertions are made
 *    against *that* one. Trusting the response to our own POST would prove nothing about
 *    what Google stored.
 *  - **Counts are taken before and after.** Nothing is deleted unless the comment count
 *    matches what this run created, and the final count must equal the starting count.
 *    A destructive loop without per-iteration verification over-deletes the day an
 *    assumption is off by one.
 *  - **It only ever deletes comments it created**, identified by a run-unique marker in the
 *    text. A pre-existing thread is counted, never touched.
 *
 * The anchor part cannot be done through Drive at all: a comment created with
 * `drive.comments.create` is unanchored, and Google's guide says the editors render it that
 * way deliberately. So the anchored case is created through the **Slides** API
 * (`presentations.batchUpdate` / `insertComment`), which is what the Slides UI itself uses,
 * and then read back off the *Drive* comment to show the two are one store.
 */
import type { OAuth2Client } from "google-auth-library";
import {
  googleFeedbackChannel,
  type FeedbackChannel,
} from "../feedback/feedback-channel";
import {
  AGENT_REPLY_MARKER,
  awaitFeedback,
  feedbackCursorFrom,
  readFeedback,
  replyFeedback,
  resolveFeedback,
  type FeedbackEnvironment,
  type FeedbackTarget,
} from "../feedback/feedback";
import { parseCommentAnchor } from "../feedback/comment-anchor";
import { describeAuthFailure, loadOAuthClient } from "../google-auth";

const DEFAULT_DECK = "1zsd1n66C18A4dAzSsxmmD_H1k8KLo9z3HUJu01zHF8U";

/** Stamped into every comment this run creates, so cleanup can never reach anything else. */
const RUN_TAG = `[sasha-feedback-e2e ${String(Date.now())}]`;

async function main(): Promise<void> {
  const presentationId = deckFromArgv(process.argv.slice(2)) ?? DEFAULT_DECK;
  // The DECK target: this harness exists to re-prove Google's own anchor strings, and the
  // deck is the only thing Google anchors. Comments on a CANDIDATE are addressed by
  // (proposalId, slideIndex) and are exercised by `e2e/session-live.ts`.
  const deckTarget: FeedbackTarget = { kind: "presentation", presentationId };

  const auth = await loadOAuthClient();
  if (auth.kind !== "ok") {
    fail(`auth: ${describeAuthFailure(auth)}`);
    return;
  }
  // The writer. Every assertion below is made against `observer` instead.
  const env = liveEnvironment({ channel: googleFeedbackChannel({ auth: auth.auth }) });

  const independent = await loadOAuthClient();
  if (independent.kind !== "ok") {
    fail(`second auth: ${describeAuthFailure(independent)}`);
    return;
  }
  const observer = googleFeedbackChannel({ auth: independent.auth });

  const checks: Check[] = [];
  const check = (label: string, ok: boolean, detail?: string): void => {
    checks.push({ label, ok, detail: detail ?? null });
  };

  const startingIds = new Set((await observer.listComments({ fileId: presentationId, startModifiedTime: null })).map((thread) => thread.id));
  process.stdout.write(`deck ${presentationId}\nstarting comment count: ${String(startingIds.size)}\n\n`);

  const created: string[] = [];
  try {
    // --- 1. the deck's pages, so a page object id can become "slide N".
    const pages = await observer.listSlidePages({ presentationId });
    check("the deck's page order is readable", pages.kind === "ok");
    if (pages.kind !== "ok") {
      report({ checks });
      return;
    }
    const targetPage = pages.pageObjectIds[1] ?? pages.pageObjectIds[0];
    if (targetPage === undefined) {
      check("the deck has at least one slide", false);
      report({ checks });
      return;
    }
    const targetNumber = pages.pageObjectIds.indexOf(targetPage) + 1;
    process.stdout.write(`  ${String(pages.pageObjectIds.length)} slides; targeting ${targetPage} (slide ${String(targetNumber)})\n`);

    // --- 2. an ANCHORED comment, the way the user's own Slides UI makes one.
    const anchored = await insertSlidesAnchoredComment({
      auth: auth.auth,
      presentationId,
      objectId: targetPage,
      text: `the chart on this slide is unreadable ${RUN_TAG}`,
    });
    created.push(anchored.commentId);
    check("the Slides API anchors a comment to a slide", true, `anchorId=${anchored.anchorId ?? "<none>"}`);

    // --- 3. an UNANCHORED comment, the way our own Drive API path makes one.
    const unanchored = await env.channel.createComment({
      fileId: presentationId,
      // The marker must come FIRST: it is only read at the front of the text, so that prose
      // mentioning "[slide:2]" mid-sentence cannot be mistaken for a location.
      text: `[slide:${String(targetNumber)}] the footer is cut off ${RUN_TAG}`,
    });
    created.push(unanchored.id);
    check(
      "a Drive-API comment is created WITHOUT an anchor (Slides renders it unanchored)",
      unanchored.anchor === null,
      `anchor=${String(unanchored.anchor)}`,
    );

    // --- 3b. a comment in the add-on sidebar's own format, to prove the two halves agree.
    const sidebar = await env.channel.createComment({
      fileId: presentationId,
      text:
        `the gridlines are gone ${RUN_TAG}\n\n` +
        `sasha-slides-feedback={"protocolVersion":1,"noteId":"e2e_note",` +
        `"pageObjectId":"${targetPage}","region":{"x":0.1,"y":0.2,"w":0.3,"h":0.2},` +
        `"createdAt":"${new Date().toISOString()}"}`,
    });
    created.push(sidebar.id);

    // --- 4. read them all back through the INDEPENDENT client.
    const read = await readFeedback({
      env: { ...env, channel: observer },
      target: deckTarget,
      since: null,
      includeResolved: false,
    });
    const ours = read.threads.filter((thread) => thread.text.includes(RUN_TAG));
    check("the independent client sees all three comments", ours.length === 3, `saw ${String(ours.length)}`);

    const anchoredThread = ours.find((thread) => thread.commentId === anchored.commentId);
    check(
      "the anchored comment's RAW anchor is on the DRIVE comment too",
      anchoredThread?.anchorRaw !== null && anchoredThread?.anchorRaw !== undefined,
      anchoredThread?.anchorRaw ?? "<none>",
    );
    if (anchoredThread !== undefined) {
      process.stdout.write(`\n  THE ANCHOR, as Drive stores it:\n    ${anchoredThread.anchorRaw ?? "<none>"}\n`);
      process.stdout.write(`  parsed: ${JSON.stringify(parseCommentAnchor(anchoredThread.anchorRaw))}\n\n`);
    }
    check(
      "the anchor resolves to the slide it was filed on",
      anchoredThread?.slide.kind === "slide" &&
        anchoredThread.slide.pageObjectId === targetPage &&
        anchoredThread.slide.slideNumber === targetNumber &&
        anchoredThread.slide.via === "slides-anchor",
      anchoredThread === undefined ? "<missing>" : JSON.stringify(anchoredThread.slide),
    );

    const unanchoredThread = ours.find((thread) => thread.commentId === unanchored.id);
    check(
      "the unanchored comment falls back to its [slide:N] marker",
      unanchoredThread?.slide.kind === "slide" &&
        unanchoredThread.slide.slideNumber === targetNumber &&
        unanchoredThread.slide.via === "text-marker",
      unanchoredThread === undefined ? "<missing>" : JSON.stringify(unanchoredThread.slide),
    );

    const sidebarThread = ours.find((thread) => thread.commentId === sidebar.id);
    check(
      "the add-on sidebar's sentinel places the comment and carries its dragged region",
      sidebarThread?.slide.kind === "slide" &&
        sidebarThread.slide.pageObjectId === targetPage &&
        sidebarThread.slide.via === "sidebar-sentinel" &&
        sidebarThread.sentinel?.region?.w === 0.3 &&
        sidebarThread.sentinel?.noteId === "e2e_note",
      sidebarThread === undefined
        ? "<missing>"
        : `${JSON.stringify(sidebarThread.slide)} region=${JSON.stringify(sidebarThread.sentinel?.region)}`,
    );

    // --- 5. reply, and read the reply back independently.
    const replied = await replyFeedback({
      env,
      target: deckTarget,
      commentId: anchored.commentId,
      text: "redrawn with larger axis labels",
    });
    check("reply_feedback posts a reply", replied.kind === "ok", JSON.stringify(replied));

    const afterReply = await observer.getComment({ fileId: presentationId, commentId: anchored.commentId });
    const agentReply = afterReply?.replies.find((reply) => reply.text.includes(AGENT_REPLY_MARKER));
    check(
      "the independent client reads the reply back, tagged as the agent's",
      agentReply !== undefined && agentReply.text.includes("redrawn with larger axis labels"),
      agentReply?.text ?? "<none>",
    );
    check(
      "the reply bumped the parent thread's modifiedTime (what makes one cursor enough)",
      afterReply !== null && afterReply.modifiedTime !== afterReply.createdTime,
      `${String(afterReply?.createdTime)} -> ${String(afterReply?.modifiedTime)}`,
    );

    // --- 6. await_feedback must NOT wake on the agent's own reply.
    const beforeOwnReply = feedbackCursorFrom({
      comments: await observer.listComments({ fileId: presentationId, startModifiedTime: null }),
      now: new Date(),
    });
    await replyFeedback({
      env,
      target: deckTarget,
      commentId: unanchored.id,
      text: "noted, trimming the footer",
    });
    const ignored = await awaitFeedback({
      env: { ...env, channel: observer },
      target: deckTarget,
      since: beforeOwnReply,
      timeoutMs: 4_000,
    });
    check(
      "await_feedback ignores the agent's own reply and times out",
      ignored.kind === "timeout",
      ignored.kind === "arrived" ? JSON.stringify(ignored.posts.map((post) => post.text)) : "timeout",
    );

    // --- 7. resolve, and confirm the state independently.
    const resolved = await resolveFeedback({
      env,
      target: deckTarget,
      commentId: anchored.commentId,
      text: null,
    });
    check("resolve_feedback reports the thread resolved", resolved.kind === "ok" && resolved.resolved);

    const afterResolve = await observer.getComment({ fileId: presentationId, commentId: anchored.commentId });
    check(
      "the independent client confirms resolved = true",
      afterResolve?.resolved === true,
      `resolved=${String(afterResolve?.resolved)}`,
    );
    check(
      "resolving was done by a reply carrying action=resolve",
      afterResolve?.replies.some((reply) => reply.action === "resolve") === true,
    );

    const openAfter = await readFeedback({
      env: { ...env, channel: observer },
      target: deckTarget,
      since: null,
      includeResolved: false,
    });
    check(
      "the resolved thread leaves the open list",
      !openAfter.threads.some((thread) => thread.commentId === anchored.commentId),
    );
    const allAfter = await readFeedback({
      env: { ...env, channel: observer },
      target: deckTarget,
      since: null,
      includeResolved: true,
    });
    check(
      "includeResolved brings it back",
      allAfter.threads.some((thread) => thread.commentId === anchored.commentId),
    );
  } finally {
    // --- 8. clean up, verifying counts, and never touching a comment we did not create.
    const cleanup = await cleanUp({ observer, presentationId, startingIds, created });
    for (const line of cleanup.lines) process.stdout.write(`${line}\n`);
    checks.push(...cleanup.checks);
  }

  report({ checks });
}

type Check = Readonly<{ label: string; ok: boolean; detail: string | null }>;

/**
 * Deletes exactly the comments this run created, refusing if the deck does not look the way
 * it should, and asserting the deck ends as it started.
 */
async function cleanUp(
  options: Readonly<{
    observer: FeedbackChannel;
    presentationId: string;
    startingIds: ReadonlySet<string>;
    created: readonly string[];
  }>,
): Promise<Readonly<{ checks: readonly Check[]; lines: readonly string[] }>> {
  const { observer, presentationId, startingIds, created } = options;
  const checks: Check[] = [];
  const lines: string[] = ["", "--- cleanup"];

  const before = await observer.listComments({ fileId: presentationId, startModifiedTime: null });
  const mine = before.filter((thread) => thread.text.includes(RUN_TAG));
  const foreign = before.filter((thread) => !thread.text.includes(RUN_TAG));
  lines.push(
    `  ${String(before.length)} comments now: ${String(mine.length)} tagged by this run, ` +
      `${String(foreign.length)} pre-existing (keeping those)`,
  );

  // The guard: every comment we think we created must be present and tagged, and nothing
  // tagged may be one we did not create. Either mismatch means stop, not delete more.
  const mineIds = new Set(mine.map((thread) => thread.id));
  const unexpected = [...mineIds].filter((id) => !created.includes(id));
  const missing = created.filter((id) => !mineIds.has(id));
  if (unexpected.length > 0 || missing.length > 0) {
    checks.push({
      label: "cleanup refused: the tagged comments are not exactly the ones this run created",
      ok: false,
      detail: `unexpected=${unexpected.join(",") || "none"} missing=${missing.join(",") || "none"}`,
    });
    return { checks, lines };
  }

  let deleted = 0;
  for (const id of mineIds) {
    await observer.deleteComment({ fileId: presentationId, commentId: id });
    // Per-iteration verification, so an off-by-one cannot run on silently.
    const stillThere = await observer.getComment({ fileId: presentationId, commentId: id });
    if (stillThere !== null) {
      checks.push({ label: `cleanup: ${id} survived deletion`, ok: false, detail: null });
      return { checks, lines };
    }
    deleted += 1;
  }
  lines.push(`  deleted ${String(deleted)} of ${String(mineIds.size)}`);

  const after = await observer.listComments({ fileId: presentationId, startModifiedTime: null });
  const afterIds = new Set(after.map((thread) => thread.id));
  checks.push({
    label: "every comment this run created was deleted",
    ok: deleted === mineIds.size && !created.some((id) => afterIds.has(id)),
    detail: null,
  });
  checks.push({
    label: "the deck is left exactly as it was found",
    ok: afterIds.size === startingIds.size && [...startingIds].every((id) => afterIds.has(id)),
    detail: `${String(startingIds.size)} comments before, ${String(afterIds.size)} after`,
  });
  lines.push(`  comment count: ${String(startingIds.size)} before, ${String(afterIds.size)} after`);
  return { checks, lines };
}

/**
 * Anchors a comment to a slide the only way that works: the Slides API, which is the same
 * surface the Slides UI drives. `drive.comments.create` cannot do this at all.
 *
 * Done with `fetch` rather than the generated client because `insertComment` is newer than
 * the `googleapis` build in this repo, so the typed client has no field for it.
 */
async function insertSlidesAnchoredComment(
  options: Readonly<{ auth: OAuth2Client; presentationId: string; objectId: string; text: string }>,
): Promise<Readonly<{ commentId: string; anchorId: string | null }>> {
  const { auth, presentationId, objectId, text } = options;
  const token = await auth.getAccessToken();
  if (typeof token.token !== "string") throw new Error("no access token for the Slides API");

  const response = await fetch(
    `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ insertComment: { content: text, objectId } }] }),
    },
  );
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`insertComment failed (${String(response.status)}): ${JSON.stringify(body)}`);
  const inserted = narrowInsertedComment(body);
  if (inserted === null) throw new Error(`insertComment returned no comment id: ${JSON.stringify(body)}`);
  return inserted;
}

/** The parse boundary for the untyped Slides batchUpdate response. */
function narrowInsertedComment(body: unknown): Readonly<{ commentId: string; anchorId: string | null }> | null {
  const root = asRecord(body);
  const replies = root?.["replies"];
  if (!Array.isArray(replies)) return null;
  const first = asRecord(replies[0]);
  const thread = asRecord(asRecord(first?.["insertComment"])?.["commentThread"]);
  const commentId = thread?.["commentId"];
  if (typeof commentId !== "string") return null;
  const anchorId = thread?.["anchorId"];
  return { commentId, anchorId: typeof anchorId === "string" ? anchorId : null };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function liveEnvironment(options: Readonly<{ channel: FeedbackChannel }>): FeedbackEnvironment {
  return {
    channel: options.channel,
    now: () => new Date(),
    sleep: ({ milliseconds }) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    warn: (message) => void process.stdout.write(`  warn: ${message}\n`),
  };
}

function deckFromArgv(args: readonly string[]): string | null {
  const position = args.indexOf("--deck");
  if (position < 0) return null;
  return args[position + 1] ?? null;
}

function report(options: Readonly<{ checks: readonly Check[] }>): void {
  process.stdout.write("\n");
  for (const { label, ok, detail } of options.checks) {
    process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${label}\n`);
    if (detail !== null) process.stdout.write(`        ${detail}\n`);
  }
  const failed = options.checks.filter((check) => !check.ok).length;
  const passed = options.checks.length - failed;
  process.stdout.write(`\n${String(passed)}/${String(options.checks.length)} live checks passed\n`);
  if (failed > 0) process.exitCode = 1;
}

function fail(message: string): void {
  process.stderr.write(`feedback-live: ${message}\n`);
  process.exitCode = 1;
}

main().catch((cause: unknown) => {
  process.stderr.write(`feedback-live: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`);
  process.exitCode = 1;
});
